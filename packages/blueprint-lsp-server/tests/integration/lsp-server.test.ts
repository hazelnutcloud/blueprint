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
