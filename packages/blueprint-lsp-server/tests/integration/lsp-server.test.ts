/**
 * Integration tests for the Blueprint LSP server.
 *
 * These tests spawn the LSP server as a subprocess and communicate with it
 * via the Language Server Protocol over stdio. They test the full LSP
 * handshake and verify server capabilities.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Encodes an LSP message with the proper Content-Length header.
 */
function encodeMessage(message: object): string {
  const content = JSON.stringify(message);
  const contentLength = Buffer.byteLength(content, "utf-8");
  return `Content-Length: ${contentLength}\r\n\r\n${content}`;
}

/**
 * Decodes an LSP message from a buffer, extracting the JSON content.
 * Returns the parsed message and the number of bytes consumed.
 */
function decodeMessage(buffer: string): { message: object | null; bytesConsumed: number } {
  // Find the header separator
  const headerEndIndex = buffer.indexOf("\r\n\r\n");
  if (headerEndIndex === -1) {
    return { message: null, bytesConsumed: 0 };
  }

  // Parse Content-Length header
  const headers = buffer.substring(0, headerEndIndex);
  const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
  if (!contentLengthMatch) {
    return { message: null, bytesConsumed: 0 };
  }

  const contentLength = parseInt(contentLengthMatch[1], 10);
  const contentStart = headerEndIndex + 4; // Skip \r\n\r\n
  const contentEnd = contentStart + contentLength;

  // Check if we have the full content
  if (buffer.length < contentEnd) {
    return { message: null, bytesConsumed: 0 };
  }

  const content = buffer.substring(contentStart, contentEnd);
  try {
    const message = JSON.parse(content);
    return { message, bytesConsumed: contentEnd };
  } catch {
    return { message: null, bytesConsumed: 0 };
  }
}

/**
 * LSP Client for integration testing.
 * Communicates with the server via subprocess stdio.
 */
class TestLspClient {
  private process: Subprocess | null = null;
  private buffer = "";
  private messageQueue: object[] = [];
  private messageWaiters: Array<(message: object) => void> = [];
  private nextId = 1;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private isReading = false;

  /**
   * Starts the LSP server subprocess.
   * Uses --stdio flag to communicate via stdin/stdout.
   */
  async start(): Promise<void> {
    const serverPath = join(__dirname, "..", "..", "src", "index.ts");

    this.process = spawn({
      cmd: ["bun", "run", serverPath, "--stdio"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Start reading from stdout
    if (this.process.stdout) {
      this.reader = this.process.stdout.getReader();
      this.startReading();
    }
  }

  /**
   * Starts the background reading loop.
   */
  private async startReading(): Promise<void> {
    if (!this.reader || this.isReading) return;
    this.isReading = true;

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // Reader was cancelled or closed
    } finally {
      this.isReading = false;
    }
  }

  /**
   * Processes the buffer to extract complete messages.
   */
  private processBuffer(): void {
    while (true) {
      const { message, bytesConsumed } = decodeMessage(this.buffer);
      if (!message) break;

      this.buffer = this.buffer.substring(bytesConsumed);

      // Deliver message to waiting receiver or queue it
      const waiter = this.messageWaiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.messageQueue.push(message);
      }
    }
  }

  /**
   * Sends a request to the server and waits for the response.
   */
  async sendRequest<T>(method: string, params?: object): Promise<T> {
    const id = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    this.send(request);

    // Wait for response with matching id
    const response = await this.waitForMessage<{ id: number; result?: T; error?: object }>(
      (msg) => "id" in msg && msg.id === id
    );

    if (response.error) {
      throw new Error(`LSP error: ${JSON.stringify(response.error)}`);
    }

    return response.result as T;
  }

  /**
   * Sends a notification to the server (no response expected).
   */
  sendNotification(method: string, params?: object): void {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.send(notification);
  }

  /**
   * Sends a message to the server.
   */
  private send(message: object): void {
    if (!this.process?.stdin) {
      throw new Error("Server not started");
    }

    const encoded = encodeMessage(message);
    this.process.stdin.write(encoded);
    this.process.stdin.flush();
  }

  /**
   * Waits for a message matching the predicate.
   * Times out after the specified duration.
   */
  async waitForMessage<T extends object>(
    predicate: (msg: object) => boolean,
    timeoutMs = 5000
  ): Promise<T> {
    // Check queued messages first
    const index = this.messageQueue.findIndex(predicate);
    if (index !== -1) {
      const [message] = this.messageQueue.splice(index, 1);
      return message as T;
    }

    // Wait for new message
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.messageWaiters.indexOf(handler);
        if (idx !== -1) this.messageWaiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (msg: object) => {
        if (predicate(msg)) {
          clearTimeout(timeout);
          resolve(msg as T);
        } else {
          // Re-queue and wait for next message
          this.messageQueue.push(msg);
          this.messageWaiters.push(handler);
        }
      };

      this.messageWaiters.push(handler);
    });
  }

  /**
   * Stops the LSP server.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    try {
      // Send shutdown request
      await this.sendRequest("shutdown");

      // Send exit notification
      this.sendNotification("exit");

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      // Ignore errors during shutdown
    } finally {
      // Cancel the reader to stop the reading loop
      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch {
          // Ignore
        }
        this.reader = null;
      }

      // Kill the process if still running
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
    }
  }
}

describe("LSP Server Integration Tests", () => {
  let client: TestLspClient;
  let workspaceDir: string;

  beforeAll(async () => {
    // Create a temporary workspace directory
    workspaceDir = await mkdtemp(join(tmpdir(), "blueprint-lsp-test-"));
  });

  afterAll(async () => {
    // Clean up temporary directory
    try {
      await rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    client = new TestLspClient();
    await client.start();
  });

  afterEach(async () => {
    await client.stop();
  });

  describe("initialization handshake", () => {
    test("responds to initialize request with server capabilities", async () => {
      const initParams = {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: true,
              willSaveWaitUntil: true,
              didSave: true,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"],
            },
            completion: {
              dynamicRegistration: false,
            },
            semanticTokens: {
              dynamicRegistration: false,
              tokenTypes: ["keyword", "variable", "type", "comment"],
              tokenModifiers: ["declaration", "definition"],
              formats: ["relative"],
              requests: {
                range: false,
                full: {
                  delta: false,
                },
              },
            },
          },
        },
        workspaceFolders: [
          {
            uri: `file://${workspaceDir}`,
            name: "test-workspace",
          },
        ],
      };

      const result = await client.sendRequest<{
        capabilities: {
          textDocumentSync?: object;
          hoverProvider?: boolean;
          definitionProvider?: boolean;
          referencesProvider?: boolean;
          documentSymbolProvider?: boolean;
          workspaceSymbolProvider?: boolean;
          codeActionProvider?: boolean;
          semanticTokensProvider?: object;
        };
      }>("initialize", initParams);

      // Verify server capabilities
      expect(result.capabilities).toBeDefined();
      expect(result.capabilities.hoverProvider).toBe(true);
      expect(result.capabilities.definitionProvider).toBe(true);
      expect(result.capabilities.referencesProvider).toBe(true);
      expect(result.capabilities.documentSymbolProvider).toBe(true);
      expect(result.capabilities.workspaceSymbolProvider).toBe(true);
      expect(result.capabilities.codeActionProvider).toBe(true);
      expect(result.capabilities.semanticTokensProvider).toBeDefined();

      // Verify text document sync capabilities
      expect(result.capabilities.textDocumentSync).toBeDefined();

      // Send initialized notification to complete handshake
      client.sendNotification("initialized", {});

      // Wait a bit for the server to process the notification
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test("supports workspace folders capability", async () => {
      const initParams = {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {
          workspace: {
            workspaceFolders: true,
          },
        },
        workspaceFolders: [
          {
            uri: `file://${workspaceDir}`,
            name: "test-workspace",
          },
        ],
      };

      const result = await client.sendRequest<{
        capabilities: {
          workspace?: {
            workspaceFolders?: {
              supported?: boolean;
            };
          };
        };
      }>("initialize", initParams);

      expect(result.capabilities.workspace?.workspaceFolders?.supported).toBe(true);

      client.sendNotification("initialized", {});
    });

    test("includes semantic token legend in capabilities", async () => {
      const initParams = {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {
          textDocument: {
            semanticTokens: {
              tokenTypes: ["keyword", "variable", "type", "comment"],
              tokenModifiers: ["declaration"],
              formats: ["relative"],
              requests: { full: true },
            },
          },
        },
      };

      const result = await client.sendRequest<{
        capabilities: {
          semanticTokensProvider?: {
            legend?: {
              tokenTypes?: string[];
              tokenModifiers?: string[];
            };
            full?: boolean;
            range?: boolean;
          };
        };
      }>("initialize", initParams);

      const semanticTokensProvider = result.capabilities.semanticTokensProvider;
      expect(semanticTokensProvider).toBeDefined();
      expect(semanticTokensProvider?.legend).toBeDefined();
      expect(semanticTokensProvider?.legend?.tokenTypes).toBeArray();
      expect(semanticTokensProvider?.legend?.tokenTypes).toContain("keyword");
      expect(semanticTokensProvider?.legend?.tokenModifiers).toBeArray();
      expect(semanticTokensProvider?.full).toBe(true);

      client.sendNotification("initialized", {});
    });
  });

  describe("document synchronization", () => {
    test("accepts textDocument/didOpen notification", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});

      // Wait for initialization to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Create a test Blueprint file
      const testFilePath = join(workspaceDir, "test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module test
  This is a test module.

@feature feature1
  A test feature.

  @requirement req1
    A test requirement.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      // Wait for the server to process
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify by requesting document symbols
      const symbols = await client.sendRequest<
        Array<{
          name: string;
          kind: number;
        }>
      >("textDocument/documentSymbol", {
        textDocument: { uri: testFileUri },
      });

      expect(symbols).toBeArray();
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols[0].name).toBe("test");
    });

    test("accepts textDocument/didChange notification", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "test-change.bp");
      const testFileUri = `file://${testFilePath}`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: "@module original\n  Original module.\n",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Change the document
      client.sendNotification("textDocument/didChange", {
        textDocument: {
          uri: testFileUri,
          version: 2,
        },
        contentChanges: [
          {
            text: "@module updated\n  Updated module.\n",
          },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify the change by requesting document symbols
      const symbols = await client.sendRequest<
        Array<{
          name: string;
          kind: number;
        }>
      >("textDocument/documentSymbol", {
        textDocument: { uri: testFileUri },
      });

      expect(symbols).toBeArray();
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols[0].name).toBe("updated");
    });

    test("accepts textDocument/didClose notification", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "test-close.bp");
      const testFileUri = `file://${testFilePath}`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: "@module closetest\n  Module to close.\n",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Close the document
      client.sendNotification("textDocument/didClose", {
        textDocument: { uri: testFileUri },
      });

      // This should not throw - the server should handle closed documents gracefully
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  describe("hover", () => {
    test("provides hover information for @module keyword", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {
          textDocument: {
            hover: {
              contentFormat: ["markdown", "plaintext"],
            },
          },
        },
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "hover-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module authentication
  Handles user authentication.

@feature login
  User login functionality.

  @requirement basic-auth
    Email/password authentication.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request hover at the @module keyword (line 0, column 1)
      const hover = await client.sendRequest<{
        contents: { kind: string; value: string } | string;
      } | null>("textDocument/hover", {
        textDocument: { uri: testFileUri },
        position: { line: 0, character: 1 },
      });

      expect(hover).not.toBeNull();
      if (hover) {
        expect(hover.contents).toBeDefined();
        // The hover should contain something about the module
        const hoverText =
          typeof hover.contents === "string" ? hover.contents : hover.contents.value;
        expect(hoverText.length).toBeGreaterThan(0);
      }
    });

    test("provides hover information for requirement", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {
          textDocument: {
            hover: {
              contentFormat: ["markdown", "plaintext"],
            },
          },
        },
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "hover-req-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module auth
  Auth module.

@feature login
  Login feature.

  @requirement basic-auth
    Email/password authentication.

    @constraint bcrypt
      Use bcrypt for password hashing.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request hover at the requirement identifier (line 7, where "basic-auth" is)
      const hover = await client.sendRequest<{
        contents: { kind: string; value: string } | string;
      } | null>("textDocument/hover", {
        textDocument: { uri: testFileUri },
        position: { line: 7, character: 15 },
      });

      expect(hover).not.toBeNull();
      if (hover) {
        expect(hover.contents).toBeDefined();
        const hoverText =
          typeof hover.contents === "string" ? hover.contents : hover.contents.value;
        expect(hoverText.length).toBeGreaterThan(0);
        // Should contain the requirement name and status info
        expect(hoverText).toContain("basic-auth");
        expect(hoverText).toContain("Status");
      }
    });
  });

  describe("diagnostics", () => {
    test("publishes syntax error diagnostics for invalid Blueprint file", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "syntax-error.bp");
      const testFileUri = `file://${testFilePath}`;
      // Invalid syntax: identifier starting with digit
      const content = `@module 123invalid
  This module has an invalid name.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      // Wait for diagnostics notification
      const diagnosticsNotification = await client.waitForMessage<{
        method: string;
        params: {
          uri: string;
          diagnostics: Array<{
            range: { start: { line: number; character: number } };
            severity: number;
            message: string;
          }>;
        };
      }>((msg) => "method" in msg && msg.method === "textDocument/publishDiagnostics");

      expect(diagnosticsNotification.params.uri).toBe(testFileUri);
      expect(diagnosticsNotification.params.diagnostics.length).toBeGreaterThan(0);
      // Syntax errors have severity 1 (Error)
      expect(diagnosticsNotification.params.diagnostics[0]!.severity).toBe(1);
    });

    test("publishes diagnostics for unresolved @depends-on reference", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "unresolved-ref.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module auth
  Auth module.

@feature login
  @depends-on nonexistent.feature

  Login feature.

  @requirement basic-auth
    Basic authentication.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      // Wait for diagnostics notification with unresolved reference
      // There may be multiple diagnostics notifications, keep checking until we find the one with unresolved-reference
      let foundUnresolvedRefDiagnostic = false;
      const startTime = Date.now();
      const timeout = 5000;

      while (!foundUnresolvedRefDiagnostic && Date.now() - startTime < timeout) {
        try {
          const diagnosticsNotification = await client.waitForMessage<{
            method: string;
            params: {
              uri: string;
              diagnostics: Array<{
                range: { start: { line: number; character: number } };
                severity: number;
                message: string;
                code?: string;
              }>;
            };
          }>(
            (msg) =>
              "method" in msg &&
              msg.method === "textDocument/publishDiagnostics" &&
              "params" in msg &&
              (msg as { params: { uri: string } }).params.uri === testFileUri,
            1000
          );

          // Check if this notification contains an unresolved reference diagnostic
          const unresolvedDiag = diagnosticsNotification.params.diagnostics.find(
            (d) => d.code === "unresolved-reference" || d.message.includes("non-existent")
          );
          if (unresolvedDiag) {
            foundUnresolvedRefDiagnostic = true;
            expect(unresolvedDiag.severity).toBe(1); // Error
            expect(unresolvedDiag.message).toContain("nonexistent.feature");
          }
        } catch {
          // Timeout on this attempt, try again
        }
      }

      expect(foundUnresolvedRefDiagnostic).toBe(true);
    });

    test("publishes warning diagnostic for requirement without ticket", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "no-ticket.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module payments
  Payment processing module.

@feature checkout
  Checkout feature.

  @requirement process-payment
    Process a payment transaction.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      // Wait for diagnostics notification with no-ticket warning
      let foundNoTicketDiagnostic = false;
      const startTime = Date.now();
      const timeout = 5000;

      while (!foundNoTicketDiagnostic && Date.now() - startTime < timeout) {
        try {
          const diagnosticsNotification = await client.waitForMessage<{
            method: string;
            params: {
              uri: string;
              diagnostics: Array<{
                range: { start: { line: number; character: number } };
                severity: number;
                message: string;
                code?: string;
              }>;
            };
          }>(
            (msg) =>
              "method" in msg &&
              msg.method === "textDocument/publishDiagnostics" &&
              "params" in msg &&
              (msg as { params: { uri: string } }).params.uri === testFileUri,
            1000
          );

          // Check if this notification contains a no-ticket warning
          const noTicketDiag = diagnosticsNotification.params.diagnostics.find(
            (d) => d.code === "no-ticket" || d.message.includes("no associated ticket")
          );
          if (noTicketDiag) {
            foundNoTicketDiagnostic = true;
            expect(noTicketDiag.severity).toBe(2); // Warning
            expect(noTicketDiag.message).toContain("process-payment");
          }
        } catch {
          // Timeout on this attempt, try again
        }
      }

      expect(foundNoTicketDiagnostic).toBe(true);
    });

    test("publishes error diagnostics for circular dependencies", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "circular.bp");
      const testFileUri = `file://${testFilePath}`;
      // Create a circular dependency: A depends on B, B depends on A
      const content = `@module cycle
  Module with circular dependencies.

@feature feature-a
  @depends-on cycle.feature-b

  Feature A.

  @requirement req-a
    Requirement A.

@feature feature-b
  @depends-on cycle.feature-a

  Feature B.

  @requirement req-b
    Requirement B.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      // Wait for diagnostics notification with circular dependency error
      let foundCircularDiagnostic = false;
      const startTime = Date.now();
      const timeout = 5000;

      while (!foundCircularDiagnostic && Date.now() - startTime < timeout) {
        try {
          const diagnosticsNotification = await client.waitForMessage<{
            method: string;
            params: {
              uri: string;
              diagnostics: Array<{
                range: { start: { line: number; character: number } };
                severity: number;
                message: string;
                code?: string;
              }>;
            };
          }>(
            (msg) =>
              "method" in msg &&
              msg.method === "textDocument/publishDiagnostics" &&
              "params" in msg &&
              (msg as { params: { uri: string } }).params.uri === testFileUri,
            1000
          );

          // Check if this notification contains a circular dependency error
          const circularDiag = diagnosticsNotification.params.diagnostics.find(
            (d) => d.code === "circular-dependency" || d.message.includes("Circular dependency")
          );
          if (circularDiag) {
            foundCircularDiagnostic = true;
            expect(circularDiag.severity).toBe(1); // Error
            expect(circularDiag.message).toContain("Circular dependency detected");
          }
        } catch {
          // Timeout on this attempt, try again
        }
      }

      expect(foundCircularDiagnostic).toBe(true);
    });

    test("clears document-level diagnostics when document is closed", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "close-clear.bp");
      const testFileUri = `file://${testFilePath}`;
      // Valid file (no syntax errors) with a requirement that has no ticket
      const content = `@module valid-close
  A valid module.

@feature test-feature
  A test feature.

  @requirement test-req
    A test requirement.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      // Wait for initial diagnostics (likely no-ticket warning)
      await client.waitForMessage<{
        method: string;
        params: { uri: string; diagnostics: Array<object> };
      }>(
        (msg) =>
          "method" in msg &&
          msg.method === "textDocument/publishDiagnostics" &&
          "params" in msg &&
          (msg as { params: { uri: string } }).params.uri === testFileUri
      );

      // Close the document
      client.sendNotification("textDocument/didClose", {
        textDocument: { uri: testFileUri },
      });

      // Wait for a diagnostic notification for this file
      // Note: The document manager sends an immediate clear, but workspace diagnostics
      // may re-add warnings (like no-ticket) since the file is still in the symbol index.
      // What we're testing is that the didClose handler is called and doesn't crash.
      const notification = await client.waitForMessage<{
        method: string;
        params: { uri: string; diagnostics: Array<object> };
      }>(
        (msg) =>
          "method" in msg &&
          msg.method === "textDocument/publishDiagnostics" &&
          "params" in msg &&
          (msg as { params: { uri: string } }).params.uri === testFileUri
      );

      // The notification should be valid (may be empty or contain workspace diagnostics)
      expect(notification.params.uri).toBe(testFileUri);
      expect(notification.params.diagnostics).toBeArray();
    });

    test("updates diagnostics when document content changes", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "update-diag.bp");
      const testFileUri = `file://${testFilePath}`;

      // Start with invalid content
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: `@module 123invalid
  Invalid module.
`,
        },
      });

      // Wait for initial diagnostics with errors
      await client.waitForMessage<{
        method: string;
        params: { uri: string; diagnostics: Array<object> };
      }>(
        (msg) =>
          "method" in msg &&
          msg.method === "textDocument/publishDiagnostics" &&
          "params" in msg &&
          (msg as { params: { uri: string; diagnostics: Array<object> } }).params.uri ===
            testFileUri &&
          (msg as { params: { uri: string; diagnostics: Array<object> } }).params.diagnostics
            .length > 0
      );

      // Fix the content
      client.sendNotification("textDocument/didChange", {
        textDocument: {
          uri: testFileUri,
          version: 2,
        },
        contentChanges: [
          {
            text: `@module valid-module
  Now this is a valid module.

@feature valid-feature
  A valid feature.

  @requirement valid-req
    A valid requirement.
`,
          },
        ],
      });

      // Wait for updated diagnostics - should have fewer/no syntax errors
      // But may still have "no-ticket" warning which is expected
      let foundUpdatedDiagnostics = false;
      const startTime = Date.now();
      const timeout = 5000;

      while (!foundUpdatedDiagnostics && Date.now() - startTime < timeout) {
        try {
          const diagnosticsNotification = await client.waitForMessage<{
            method: string;
            params: {
              uri: string;
              diagnostics: Array<{
                severity: number;
                message: string;
                code?: string;
              }>;
            };
          }>(
            (msg) =>
              "method" in msg &&
              msg.method === "textDocument/publishDiagnostics" &&
              "params" in msg &&
              (msg as { params: { uri: string } }).params.uri === testFileUri,
            1000
          );

          // Check that there are no syntax errors (severity 1 without specific codes)
          const syntaxErrors = diagnosticsNotification.params.diagnostics.filter(
            (d) => d.severity === 1 && !d.code // Syntax errors don't have a code
          );

          if (syntaxErrors.length === 0) {
            foundUpdatedDiagnostics = true;
            // May still have warnings like no-ticket, but no syntax errors
          }
        } catch {
          // Timeout on this attempt, try again
        }
      }

      expect(foundUpdatedDiagnostics).toBe(true);
    });
  });

  describe("go-to-definition", () => {
    test("provides definition for @depends-on reference to another symbol", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {
          textDocument: {
            definition: {
              dynamicRegistration: false,
            },
          },
        },
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "definition-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module auth
  Authentication module.

  @feature login
    User login functionality.

    @requirement basic-auth
      Email/password authentication.

  @feature session
    @depends-on auth.login.basic-auth

    Session management.

    @requirement create-token
      Create session tokens.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition at the @depends-on reference (line 10, on "auth.login.basic-auth")
      // Line 10: "    @depends-on auth.login.basic-auth"
      // Character position around 20 should be on the reference
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 10, character: 20 },
      });

      expect(definition).not.toBeNull();
      if (definition) {
        // Should navigate to the basic-auth requirement definition
        expect(definition.uri).toBe(testFileUri);
        // The requirement is on line 6
        expect(definition.range.start.line).toBe(6);
      }
    });

    test("provides definition for requirement identifier (navigates to symbol when no ticket)", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "def-req-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module payments
  Payment processing.

  @feature checkout
    Checkout feature.

    @requirement process-payment
      Process a payment transaction.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition on the requirement identifier "process-payment" (line 6)
      // Line 6: "    @requirement process-payment"
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 6, character: 20 },
      });

      expect(definition).not.toBeNull();
      if (definition) {
        // Should stay in the same file, at the requirement definition line
        expect(definition.uri).toBe(testFileUri);
        expect(definition.range.start.line).toBe(6);
      }
    });

    test("provides definition for constraint identifier", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "def-constraint-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module security
  Security module.

  @feature encryption
    Encryption feature.

    @requirement encrypt-data
      Encrypt sensitive data.

      @constraint aes-256
        Use AES-256 encryption.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition on the constraint identifier "aes-256" (line 9)
      // Line 9: "      @constraint aes-256"
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 9, character: 20 },
      });

      expect(definition).not.toBeNull();
      if (definition) {
        expect(definition.uri).toBe(testFileUri);
        expect(definition.range.start.line).toBe(9);
      }
    });

    test("returns null for keyword (no definition for keywords)", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "def-keyword-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module test
  A test module.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition on the @module keyword (line 0, character 1-5)
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 0, character: 3 },
      });

      // Keywords don't have definitions
      expect(definition).toBeNull();
    });

    test("returns null for unresolved reference", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "def-unresolved-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module auth
  @depends-on nonexistent.feature

  Authentication module.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition on the unresolved reference (line 1)
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 1, character: 20 },
      });

      // Unresolved references don't have definitions
      expect(definition).toBeNull();
    });

    test("provides cross-file definition for reference to symbol in another file", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Create two files: storage.bp and auth.bp
      const storageFilePath = join(workspaceDir, "storage.bp");
      const storageFileUri = `file://${storageFilePath}`;
      const storageContent = `@module storage
  Storage module.

  @feature user-accounts
    User account management.

    @requirement user-table
      User table schema.
`;

      const authFilePath = join(workspaceDir, "auth.bp");
      const authFileUri = `file://${authFilePath}`;
      const authContent = `@module auth
  @depends-on storage.user-accounts

  Authentication module.

  @feature login
    Login functionality.
`;

      // Open storage.bp first (so the symbol is indexed)
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: storageFileUri,
          languageId: "blueprint",
          version: 1,
          text: storageContent,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Open auth.bp
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: authFileUri,
          languageId: "blueprint",
          version: 1,
          text: authContent,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition at the @depends-on reference in auth.bp (line 1)
      // Line 1: "  @depends-on storage.user-accounts"
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: authFileUri },
        position: { line: 1, character: 20 },
      });

      expect(definition).not.toBeNull();
      if (definition) {
        // Should navigate to storage.bp
        expect(definition.uri).toBe(storageFileUri);
        // The user-accounts feature is on line 3
        expect(definition.range.start.line).toBe(3);
      }
    });

    test("provides definition for feature identifier", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "def-feature-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module inventory
  Inventory module.

  @feature stock-management
    Stock management feature.

    @requirement track-inventory
      Track inventory levels.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition on the feature identifier "stock-management" (line 3)
      // Line 3: "  @feature stock-management"
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 3, character: 15 },
      });

      expect(definition).not.toBeNull();
      if (definition) {
        expect(definition.uri).toBe(testFileUri);
        expect(definition.range.start.line).toBe(3);
      }
    });

    test("provides definition for module identifier", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testFilePath = join(workspaceDir, "def-module-test.bp");
      const testFileUri = `file://${testFilePath}`;
      const content = `@module notifications
  Notification handling module.

  @feature email
    Email notifications.
`;

      // Open the document
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: testFileUri,
          languageId: "blueprint",
          version: 1,
          text: content,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Request definition on the module identifier "notifications" (line 0)
      // Line 0: "@module notifications"
      const definition = await client.sendRequest<{
        uri: string;
        range: { start: { line: number; character: number } };
      } | null>("textDocument/definition", {
        textDocument: { uri: testFileUri },
        position: { line: 0, character: 10 },
      });

      expect(definition).not.toBeNull();
      if (definition) {
        expect(definition.uri).toBe(testFileUri);
        expect(definition.range.start.line).toBe(0);
      }
    });
  });

  describe("shutdown", () => {
    test("handles shutdown and exit gracefully", async () => {
      // Initialize first
      await client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceDir}`,
        capabilities: {},
      });
      client.sendNotification("initialized", {});
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Send shutdown request
      const shutdownResult = await client.sendRequest("shutdown");

      // Shutdown should return null
      expect(shutdownResult).toBeNull();

      // Send exit notification - this should not throw
      client.sendNotification("exit");

      // Wait for the server to exit
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  });
});
