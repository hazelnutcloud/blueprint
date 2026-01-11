import { describe, test, expect, beforeAll } from "bun:test";
import type { CodeActionParams, Diagnostic } from "vscode-languageserver/node";
import { DiagnosticSeverity, CodeActionKind } from "vscode-languageserver/node";
import {
  buildCodeActions,
  extractRequirementPathFromMessage,
  extractOrphanedTicketInfo,
  generateTicketId,
  createTicket,
  findWorkspaceFolder,
  createAddTicketEdit,
  createNewTicketFileEdit,
  createRemoveTicketEdit,
  type CodeActionsContext,
} from "../src/code-actions";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import type { Ticket } from "../src/tickets";

// Mock TicketDocumentManager for testing
class MockTicketDocumentManager {
  private tickets: Array<{ ticket: Ticket; fileUri: string }> = [];
  private ticketFiles: Array<{ uri: string; content: string; data: { version: string; source: string; tickets: Ticket[] } }> = [];

  setTickets(tickets: Array<{ ticket: Ticket; fileUri: string }>) {
    this.tickets = tickets;
  }

  setTicketFiles(files: Array<{ uri: string; content: string; data: { version: string; source: string; tickets: Ticket[] } }>) {
    this.ticketFiles = files;
  }

  getAllTickets() {
    return this.tickets;
  }

  getAllTicketFilesWithContent() {
    return this.ticketFiles;
  }
}

beforeAll(async () => {
  await initializeParser();
});

describe("extractRequirementPathFromMessage", () => {
  test("extracts path from standard no-ticket message", () => {
    const message = "Requirement 'auth.login.verify' has no associated ticket";
    expect(extractRequirementPathFromMessage(message)).toBe("auth.login.verify");
  });

  test("extracts single-part path", () => {
    const message = "Requirement 'simple' has no associated ticket";
    expect(extractRequirementPathFromMessage(message)).toBe("simple");
  });

  test("extracts path with hyphens", () => {
    const message = "Requirement 'auth.user-login.verify-token' has no associated ticket";
    expect(extractRequirementPathFromMessage(message)).toBe("auth.user-login.verify-token");
  });

  test("returns null for non-matching message", () => {
    const message = "Some other error message";
    expect(extractRequirementPathFromMessage(message)).toBeNull();
  });

  test("returns null for empty message", () => {
    expect(extractRequirementPathFromMessage("")).toBeNull();
  });
});

describe("extractOrphanedTicketInfo", () => {
  test("extracts ticket ID and ref from standard orphaned-ticket message", () => {
    const message = "Ticket 'TKT-001' references removed requirement 'auth.login.verify'";
    const info = extractOrphanedTicketInfo(message);
    expect(info).toEqual({
      ticketId: "TKT-001",
      requirementRef: "auth.login.verify",
    });
  });

  test("extracts info with multi-digit ticket ID", () => {
    const message = "Ticket 'TKT-123' references removed requirement 'module.feature.req'";
    const info = extractOrphanedTicketInfo(message);
    expect(info).toEqual({
      ticketId: "TKT-123",
      requirementRef: "module.feature.req",
    });
  });

  test("extracts info with non-standard ticket ID", () => {
    const message = "Ticket 'CUSTOM-99' references removed requirement 'simple'";
    const info = extractOrphanedTicketInfo(message);
    expect(info).toEqual({
      ticketId: "CUSTOM-99",
      requirementRef: "simple",
    });
  });

  test("returns null for non-matching message", () => {
    const message = "Some other error message";
    expect(extractOrphanedTicketInfo(message)).toBeNull();
  });

  test("returns null for empty message", () => {
    expect(extractOrphanedTicketInfo("")).toBeNull();
  });

  test("returns null for no-ticket message", () => {
    const message = "Requirement 'auth.login.verify' has no associated ticket";
    expect(extractOrphanedTicketInfo(message)).toBeNull();
  });
});

describe("generateTicketId", () => {
  test("generates TKT-001 for empty ticket list", () => {
    expect(generateTicketId([])).toBe("TKT-001");
  });

  test("generates next sequential ID", () => {
    const tickets: Ticket[] = [
      { id: "TKT-001", ref: "a", description: "", status: "pending", constraints_satisfied: [] },
      { id: "TKT-002", ref: "b", description: "", status: "pending", constraints_satisfied: [] },
    ];
    expect(generateTicketId(tickets)).toBe("TKT-003");
  });

  test("handles gaps in ticket numbers", () => {
    const tickets: Ticket[] = [
      { id: "TKT-001", ref: "a", description: "", status: "pending", constraints_satisfied: [] },
      { id: "TKT-005", ref: "b", description: "", status: "pending", constraints_satisfied: [] },
    ];
    expect(generateTicketId(tickets)).toBe("TKT-006");
  });

  test("handles non-standard ticket IDs gracefully", () => {
    const tickets: Ticket[] = [
      { id: "CUSTOM-123", ref: "a", description: "", status: "pending", constraints_satisfied: [] },
      { id: "TKT-002", ref: "b", description: "", status: "pending", constraints_satisfied: [] },
    ];
    expect(generateTicketId(tickets)).toBe("TKT-003");
  });

  test("generates zero-padded IDs", () => {
    const tickets: Ticket[] = [];
    for (let i = 1; i <= 99; i++) {
      tickets.push({
        id: `TKT-${String(i).padStart(3, "0")}`,
        ref: `req-${i}`,
        description: "",
        status: "pending",
        constraints_satisfied: [],
      });
    }
    expect(generateTicketId(tickets)).toBe("TKT-100");
  });
});

describe("createTicket", () => {
  test("creates ticket with description", () => {
    const ticket = createTicket("TKT-001", "auth.login.verify", "Verify user credentials");
    expect(ticket).toEqual({
      id: "TKT-001",
      ref: "auth.login.verify",
      description: "Verify user credentials",
      status: "pending",
      constraints_satisfied: [],
    });
  });

  test("creates ticket with default description", () => {
    const ticket = createTicket("TKT-002", "auth.logout");
    expect(ticket.description).toBe("Implement auth.logout");
  });

  test("uses provided description over default", () => {
    const ticket = createTicket("TKT-003", "auth.refresh", "Handle token refresh");
    expect(ticket.description).toBe("Handle token refresh");
  });
});

describe("findWorkspaceFolder", () => {
  test("finds matching workspace folder", () => {
    const fileUri = "file:///workspace/project/src/auth.bp";
    const workspaceFolders = [
      "file:///workspace/project",
      "file:///workspace/other",
    ];
    expect(findWorkspaceFolder(fileUri, workspaceFolders)).toBe("file:///workspace/project");
  });

  test("returns first matching folder when multiple match", () => {
    const fileUri = "file:///workspace/project/src/auth.bp";
    const workspaceFolders = [
      "file:///workspace",
      "file:///workspace/project",
    ];
    // Both match, but /workspace comes first
    expect(findWorkspaceFolder(fileUri, workspaceFolders)).toBe("file:///workspace");
  });

  test("returns undefined when no folder matches", () => {
    const fileUri = "file:///other/path/auth.bp";
    const workspaceFolders = [
      "file:///workspace/project",
    ];
    expect(findWorkspaceFolder(fileUri, workspaceFolders)).toBeUndefined();
  });

  test("returns undefined for empty folder list", () => {
    const fileUri = "file:///workspace/project/auth.bp";
    expect(findWorkspaceFolder(fileUri, [])).toBeUndefined();
  });
});

describe("createAddTicketEdit", () => {
  test("adds ticket to existing tickets array", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const existingContent = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.verify",
      "description": "Verify user credentials",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;
    const newTicket = createTicket("TKT-002", "auth.login.refresh", "Handle token refresh");

    const edit = createAddTicketEdit(ticketFileUri, existingContent, newTicket);

    expect(edit.changes).toBeDefined();
    expect(edit.changes![ticketFileUri]).toBeDefined();
    expect(edit.changes![ticketFileUri]!.length).toBeGreaterThan(0);
  });

  test("adds ticket to empty tickets array", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const existingContent = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": []
}`;
    const newTicket = createTicket("TKT-001", "auth.login.verify", "Verify credentials");

    const edit = createAddTicketEdit(ticketFileUri, existingContent, newTicket);

    expect(edit.changes).toBeDefined();
    expect(edit.changes![ticketFileUri]).toBeDefined();

    // Check that the edit contains the new ticket
    const editText = edit.changes![ticketFileUri]![0]!.newText;
    expect(editText).toContain("TKT-001");
    expect(editText).toContain("auth.login.verify");
  });

  test("handles compact empty array format", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const existingContent = `{"version": "1.0", "source": "auth.bp", "tickets": []}`;
    const newTicket = createTicket("TKT-001", "auth.login", "Login");

    const edit = createAddTicketEdit(ticketFileUri, existingContent, newTicket);

    expect(edit.changes).toBeDefined();
    expect(edit.changes![ticketFileUri]).toBeDefined();
  });
});

describe("createRemoveTicketEdit", () => {
  test("removes single ticket from array", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.verify",
      "description": "Verify user credentials",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-001");

    expect(edit).not.toBeNull();
    expect(edit!.changes).toBeDefined();
    expect(edit!.changes![ticketFileUri]).toBeDefined();
    expect(edit!.changes![ticketFileUri]!.length).toBeGreaterThan(0);
  });

  test("removes first ticket from multiple tickets", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.old",
      "description": "Old requirement",
      "status": "complete",
      "constraints_satisfied": []
    },
    {
      "id": "TKT-002",
      "ref": "auth.login.verify",
      "description": "Verify user credentials",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-001");

    expect(edit).not.toBeNull();
    expect(edit!.changes).toBeDefined();
    expect(edit!.changes![ticketFileUri]).toBeDefined();
  });

  test("removes last ticket from multiple tickets and handles comma", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.verify",
      "description": "Verify user credentials",
      "status": "complete",
      "constraints_satisfied": []
    },
    {
      "id": "TKT-002",
      "ref": "auth.login.old",
      "description": "Old requirement",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-002");

    expect(edit).not.toBeNull();
    expect(edit!.changes).toBeDefined();
    expect(edit!.changes![ticketFileUri]).toBeDefined();
    // Should have 2 edits: remove comma from previous ticket, remove the ticket
    expect(edit!.changes![ticketFileUri]!.length).toBe(2);
  });

  test("removes middle ticket from three tickets", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.first",
      "description": "First",
      "status": "complete",
      "constraints_satisfied": []
    },
    {
      "id": "TKT-002",
      "ref": "auth.login.middle",
      "description": "Middle - to be removed",
      "status": "complete",
      "constraints_satisfied": []
    },
    {
      "id": "TKT-003",
      "ref": "auth.login.last",
      "description": "Last",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-002");

    expect(edit).not.toBeNull();
    expect(edit!.changes).toBeDefined();
    expect(edit!.changes![ticketFileUri]).toBeDefined();
  });

  test("returns null for non-existent ticket ID", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.verify",
      "description": "Verify",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-999");

    expect(edit).toBeNull();
  });

  test("returns null for empty tickets array", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": []
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-001");

    expect(edit).toBeNull();
  });

  test("handles ticket with implementation field", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const content = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.verify",
      "description": "Verify user credentials",
      "status": "complete",
      "constraints_satisfied": ["bcrypt-cost"],
      "implementation": {
        "files": ["src/auth/login.ts"],
        "tests": ["tests/auth/login.test.ts"]
      }
    }
  ]
}`;

    const edit = createRemoveTicketEdit(ticketFileUri, content, "TKT-001");

    expect(edit).not.toBeNull();
    expect(edit!.changes).toBeDefined();
  });
});

describe("createNewTicketFileEdit", () => {
  test("creates new ticket file with single ticket", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const sourcePath = "requirements/auth.bp";
    const newTicket = createTicket("TKT-001", "auth.login.verify", "Verify credentials");

    const edit = createNewTicketFileEdit(ticketFileUri, sourcePath, newTicket);

    expect(edit.changes).toBeDefined();
    expect(edit.changes![ticketFileUri]).toBeDefined();

    const content = edit.changes![ticketFileUri]![0]!.newText;
    expect(content).toContain('"version": "1.0"');
    expect(content).toContain('"source": "requirements/auth.bp"');
    expect(content).toContain('"id": "TKT-001"');
    expect(content).toContain('"ref": "auth.login.verify"');
  });

  test("creates valid JSON", () => {
    const ticketFileUri = "file:///workspace/.blueprint/tickets/test.tickets.json";
    const sourcePath = "test.bp";
    const newTicket = createTicket("TKT-001", "module.feature.req", "Test requirement");

    const edit = createNewTicketFileEdit(ticketFileUri, sourcePath, newTicket);
    const content = edit.changes![ticketFileUri]![0]!.newText;

    // Should be valid JSON
    expect(() => JSON.parse(content)).not.toThrow();

    const parsed = JSON.parse(content);
    expect(parsed.version).toBe("1.0");
    expect(parsed.source).toBe("test.bp");
    expect(parsed.tickets).toHaveLength(1);
    expect(parsed.tickets[0].id).toBe("TKT-001");
  });
});

describe("buildCodeActions", () => {
  function createMockParams(
    uri: string,
    diagnostics: Diagnostic[]
  ): CodeActionParams {
    return {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      context: { diagnostics },
    };
  }

  function createNoTicketDiagnostic(requirementPath: string): Diagnostic {
    return {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: 5, character: 0 },
        end: { line: 5, character: 20 },
      },
      message: `Requirement '${requirementPath}' has no associated ticket`,
      source: "blueprint",
      code: "no-ticket",
    };
  }

  test("creates code action for no-ticket diagnostic", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify user credentials.
`;
    const tree = parseDocument(code);
    expect(tree).not.toBeNull();

    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///workspace/requirements/auth.bp", ast);

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([]);
    mockTicketManager.setTicketFiles([]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [createNoTicketDiagnostic("auth.login.verify")]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain("TKT-001");
    expect(actions[0]!.title).toContain("auth.login.verify");
    expect(actions[0]!.kind).toBe(CodeActionKind.QuickFix);
    expect(actions[0]!.isPreferred).toBe(true);
    expect(actions[0]!.edit).toBeDefined();
  });

  test("generates sequential ticket IDs when tickets exist", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify user credentials.

  @requirement refresh
    Refresh token.
`;
    const tree = parseDocument(code);
    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///workspace/requirements/auth.bp", ast);

    const existingTicket: Ticket = {
      id: "TKT-005",
      ref: "auth.login.verify",
      description: "Verify",
      status: "complete",
      constraints_satisfied: [],
    };

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([{ ticket: existingTicket, fileUri: "file:///workspace/.blueprint/tickets/auth.tickets.json" }]);
    mockTicketManager.setTicketFiles([{
      uri: "file:///workspace/.blueprint/tickets/auth.tickets.json",
      content: JSON.stringify({ version: "1.0", source: "auth.bp", tickets: [existingTicket] }),
      data: { version: "1.0", source: "auth.bp", tickets: [existingTicket] },
    }]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [createNoTicketDiagnostic("auth.login.refresh")]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain("TKT-006"); // Next after TKT-005
  });

  test("ignores non-no-ticket diagnostics", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const mockTicketManager = new MockTicketDocumentManager();

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const otherDiagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      message: "Circular dependency detected",
      source: "blueprint",
      code: "circular-dependency",
    };

    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [otherDiagnostic]
    );

    const actions = buildCodeActions(params, context);
    expect(actions).toHaveLength(0);
  });

  test("handles multiple no-ticket diagnostics", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify.

  @requirement refresh
    Refresh.

  @requirement logout
    Logout.
`;
    const tree = parseDocument(code);
    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///workspace/requirements/auth.bp", ast);

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([]);
    mockTicketManager.setTicketFiles([]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [
        createNoTicketDiagnostic("auth.login.verify"),
        createNoTicketDiagnostic("auth.login.refresh"),
        createNoTicketDiagnostic("auth.login.logout"),
      ]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(3);
    // All should get sequential IDs
    expect(actions[0]!.title).toContain("TKT-001");
    expect(actions[1]!.title).toContain("TKT-001"); // Same because no tickets in context yet
    expect(actions[2]!.title).toContain("TKT-001");
  });

  test("returns empty array when no workspace folder matches", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify.
`;
    const tree = parseDocument(code);
    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///other/path/auth.bp", ast);

    const mockTicketManager = new MockTicketDocumentManager();

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"], // Different path
    };

    const params = createMockParams(
      "file:///other/path/auth.bp",
      [createNoTicketDiagnostic("auth.login.verify")]
    );

    const actions = buildCodeActions(params, context);
    expect(actions).toHaveLength(0);
  });

  test("returns empty array when no workspace folders provided", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const mockTicketManager = new MockTicketDocumentManager();

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: undefined,
    };

    const params = createMockParams(
      "file:///workspace/auth.bp",
      [createNoTicketDiagnostic("auth.login.verify")]
    );

    const actions = buildCodeActions(params, context);
    expect(actions).toHaveLength(0);
  });

  test("uses requirement description for ticket description", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify user credentials against the database.
    This is a multi-line description.
`;
    const tree = parseDocument(code);
    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///workspace/requirements/auth.bp", ast);

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([]);
    mockTicketManager.setTicketFiles([]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [createNoTicketDiagnostic("auth.login.verify")]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    // The edit should contain the description from the requirement
    const editContent = JSON.stringify(actions[0]!.edit);
    expect(editContent).toContain("Verify user credentials against the database");
  });

  test("creates new file when ticket file does not exist", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify.
`;
    const tree = parseDocument(code);
    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///workspace/requirements/auth.bp", ast);

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([]);
    mockTicketManager.setTicketFiles([]); // No existing ticket files

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [createNoTicketDiagnostic("auth.login.verify")]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain("(new file)");
  });

  test("associates diagnostic with code action", () => {
    const code = `
@module auth

@feature login

  @requirement verify
    Verify.
`;
    const tree = parseDocument(code);
    const ast = transformToAST(tree!);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile("file:///workspace/requirements/auth.bp", ast);

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([]);
    mockTicketManager.setTicketFiles([]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const diagnostic = createNoTicketDiagnostic("auth.login.verify");
    const params = createMockParams(
      "file:///workspace/requirements/auth.bp",
      [diagnostic]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.diagnostics).toEqual([diagnostic]);
  });

  // Tests for orphaned-ticket code actions
  function createOrphanedTicketDiagnostic(ticketId: string, requirementRef: string): Diagnostic {
    return {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      message: `Ticket '${ticketId}' references removed requirement '${requirementRef}'`,
      source: "blueprint",
      code: "orphaned-ticket",
    };
  }

  test("creates code action to remove orphaned ticket", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const ticketFileContent = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.removed",
      "description": "Removed requirement",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTickets([
      {
        ticket: {
          id: "TKT-001",
          ref: "auth.login.removed",
          description: "Removed requirement",
          status: "complete",
          constraints_satisfied: [],
        },
        fileUri: ticketFileUri,
      },
    ]);
    mockTicketManager.setTicketFiles([
      {
        uri: ticketFileUri,
        content: ticketFileContent,
        data: {
          version: "1.0",
          source: "requirements/auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.removed",
              description: "Removed requirement",
              status: "complete",
              constraints_satisfied: [],
            },
          ],
        },
      },
    ]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(ticketFileUri, [
      createOrphanedTicketDiagnostic("TKT-001", "auth.login.removed"),
    ]);

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toBe("Remove orphaned ticket 'TKT-001'");
    expect(actions[0]!.kind).toBe(CodeActionKind.QuickFix);
    expect(actions[0]!.isPreferred).toBe(true);
    expect(actions[0]!.edit).toBeDefined();
  });

  test("handles multiple orphaned ticket diagnostics", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const ticketFileContent = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.removed1",
      "description": "First removed",
      "status": "complete",
      "constraints_satisfied": []
    },
    {
      "id": "TKT-002",
      "ref": "auth.login.removed2",
      "description": "Second removed",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTicketFiles([
      {
        uri: ticketFileUri,
        content: ticketFileContent,
        data: {
          version: "1.0",
          source: "requirements/auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.removed1",
              description: "First removed",
              status: "complete",
              constraints_satisfied: [],
            },
            {
              id: "TKT-002",
              ref: "auth.login.removed2",
              description: "Second removed",
              status: "complete",
              constraints_satisfied: [],
            },
          ],
        },
      },
    ]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(ticketFileUri, [
      createOrphanedTicketDiagnostic("TKT-001", "auth.login.removed1"),
      createOrphanedTicketDiagnostic("TKT-002", "auth.login.removed2"),
    ]);

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(2);
    expect(actions[0]!.title).toBe("Remove orphaned ticket 'TKT-001'");
    expect(actions[1]!.title).toBe("Remove orphaned ticket 'TKT-002'");
  });

  test("ignores orphaned-ticket diagnostic when ticket file not found", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTicketFiles([]); // No ticket files

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(
      "file:///workspace/.blueprint/tickets/auth.tickets.json",
      [createOrphanedTicketDiagnostic("TKT-001", "auth.login.removed")]
    );

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(0);
  });

  test("ignores orphaned-ticket diagnostic when ticket ID not found in file", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const ticketFileContent = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-999",
      "ref": "auth.login.other",
      "description": "Different ticket",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTicketFiles([
      {
        uri: ticketFileUri,
        content: ticketFileContent,
        data: {
          version: "1.0",
          source: "requirements/auth.bp",
          tickets: [
            {
              id: "TKT-999",
              ref: "auth.login.other",
              description: "Different ticket",
              status: "complete",
              constraints_satisfied: [],
            },
          ],
        },
      },
    ]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const params = createMockParams(ticketFileUri, [
      createOrphanedTicketDiagnostic("TKT-001", "auth.login.removed"),
    ]);

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(0);
  });

  test("associates orphaned-ticket diagnostic with code action", () => {
    const symbolIndex = new CrossFileSymbolIndex();
    const ticketFileUri = "file:///workspace/.blueprint/tickets/auth.tickets.json";
    const ticketFileContent = `{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "auth.login.removed",
      "description": "Removed",
      "status": "complete",
      "constraints_satisfied": []
    }
  ]
}`;

    const mockTicketManager = new MockTicketDocumentManager();
    mockTicketManager.setTicketFiles([
      {
        uri: ticketFileUri,
        content: ticketFileContent,
        data: {
          version: "1.0",
          source: "requirements/auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.removed",
              description: "Removed",
              status: "complete",
              constraints_satisfied: [],
            },
          ],
        },
      },
    ]);

    const context: CodeActionsContext = {
      symbolIndex,
      ticketDocumentManager: mockTicketManager as any,
      workspaceFolderUris: ["file:///workspace"],
    };

    const diagnostic = createOrphanedTicketDiagnostic("TKT-001", "auth.login.removed");
    const params = createMockParams(ticketFileUri, [diagnostic]);

    const actions = buildCodeActions(params, context);

    expect(actions).toHaveLength(1);
    expect(actions[0]!.diagnostics).toEqual([diagnostic]);
  });
});
