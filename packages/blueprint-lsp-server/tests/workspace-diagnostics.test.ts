import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import {
  computeCircularDependencyDiagnostics,
  computeUnresolvedReferenceDiagnostics,
  computeNoTicketDiagnostics,
  computeOrphanedTicketDiagnostics,
  computeWorkspaceDiagnostics,
  mergeDiagnosticResults,
  type TicketFileInfo,
} from "../src/workspace-diagnostics";
import type { Ticket, TicketFile } from "../src/tickets";

describe("workspace-diagnostics", () => {
  let index: CrossFileSymbolIndex;

  beforeAll(async () => {
    await initializeParser();
  });

  beforeEach(() => {
    index = new CrossFileSymbolIndex();
  });

  /**
   * Helper to parse code and return AST.
   */
  function parseToAST(code: string) {
    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    return transformToAST(tree!);
  }

  describe("computeCircularDependencyDiagnostics", () => {
    test("returns empty result for empty index", () => {
      const result = computeCircularDependencyDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("returns empty result for acyclic graph", () => {
      const storageCode = `@module storage`;
      const authCode = `
@module auth
  @depends-on storage
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("detects simple two-node cycle", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.filesWithDiagnostics).toHaveLength(2);
      expect(result.byFile.has("file:///a.bp")).toBe(true);
      expect(result.byFile.has("file:///b.bp")).toBe(true);

      // Check diagnostics in file a
      const diagsA = result.byFile.get("file:///a.bp")!;
      expect(diagsA.length).toBeGreaterThanOrEqual(1);
      expect(diagsA[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagsA[0]!.message).toContain("Circular dependency detected");
      expect(diagsA[0]!.code).toBe("circular-dependency");
      expect(diagsA[0]!.source).toBe("blueprint");

      // Check diagnostics in file b
      const diagsB = result.byFile.get("file:///b.bp")!;
      expect(diagsB.length).toBeGreaterThanOrEqual(1);
      expect(diagsB[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagsB[0]!.message).toContain("Circular dependency detected");
    });

    test("cycle message contains the full cycle path", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `
@module b
  @depends-on c
`;
      const codeC = `
@module c
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));
      index.addFile("file:///c.bp", parseToAST(codeC));

      const result = computeCircularDependencyDiagnostics(index);

      // At least one file should have the cycle path in its message
      let foundCyclePath = false;
      for (const [, diags] of result.byFile) {
        for (const diag of diags) {
          if (
            diag.message.includes("a") &&
            diag.message.includes("b") &&
            diag.message.includes("c")
          ) {
            foundCyclePath = true;
            break;
          }
        }
      }
      expect(foundCyclePath).toBe(true);
    });

    test("diagnostic range points to the @depends-on reference", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      const result = computeCircularDependencyDiagnostics(index);

      const diagsA = result.byFile.get("file:///a.bp")!;
      expect(diagsA.length).toBeGreaterThanOrEqual(1);

      // The diagnostic should point to line 2 (0-indexed) where @depends-on b is
      const diag = diagsA[0]!;
      expect(diag.range.start.line).toBe(2);
    });

    test("handles multiple independent cycles", () => {
      const code = `
@module a
  @depends-on b

@module b
  @depends-on a

@module x
  @depends-on y

@module y
  @depends-on x
`;
      index.addFile("file:///test.bp", parseToAST(code));

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.filesWithDiagnostics).toContain("file:///test.bp");

      const diags = result.byFile.get("file:///test.bp")!;
      // Should have diagnostics for both cycles
      expect(diags.length).toBeGreaterThanOrEqual(2);
    });

    test("handles cycle within same file", () => {
      const code = `
@module auth

@feature login
  @depends-on auth.session

@feature session
  @depends-on auth.login
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags.length).toBeGreaterThanOrEqual(1);
      expect(diags[0]!.message).toContain("Circular dependency detected");
    });

    test("does not duplicate diagnostics for same location", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      const result = computeCircularDependencyDiagnostics(index);

      // Each file should have exactly one diagnostic for the cycle
      const diagsA = result.byFile.get("file:///a.bp")!;
      const diagsB = result.byFile.get("file:///b.bp")!;

      // Count circular-dependency diagnostics
      const circularDiagsA = diagsA.filter(
        (d) => d.code === "circular-dependency"
      );
      const circularDiagsB = diagsB.filter(
        (d) => d.code === "circular-dependency"
      );

      expect(circularDiagsA).toHaveLength(1);
      expect(circularDiagsB).toHaveLength(1);
    });
  });

  describe("computeUnresolvedReferenceDiagnostics", () => {
    test("returns empty result for empty index", () => {
      const result = computeUnresolvedReferenceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("returns empty result when all references resolve", () => {
      const storageCode = `@module storage`;
      const authCode = `
@module auth
  @depends-on storage
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = computeUnresolvedReferenceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
    });

    test("detects unresolved reference", () => {
      const code = `
@module auth
  @depends-on nonexistent
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeUnresolvedReferenceDiagnostics(index);

      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diags[0]!.message).toContain("nonexistent");
      expect(diags[0]!.code).toBe("unresolved-reference");
      expect(diags[0]!.source).toBe("blueprint");
    });

    test("detects multiple unresolved references", () => {
      const code = `
@module auth
  @depends-on nonexistent1, nonexistent2

@feature login
  @depends-on also-missing
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeUnresolvedReferenceDiagnostics(index);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(3);
    });

    test("diagnostic range points to the reference", () => {
      const code = `
@module auth
  @depends-on nonexistent
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeUnresolvedReferenceDiagnostics(index);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags[0]!.range.start.line).toBe(2);
    });

    test("reports unresolved cross-file references", () => {
      const authCode = `
@module auth
  @depends-on storage.database
`;
      // Note: storage module exists but storage.database does not
      const storageCode = `@module storage`;

      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///storage.bp", parseToAST(storageCode));

      const result = computeUnresolvedReferenceDiagnostics(index);

      // storage.database should be unresolved because only storage exists
      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.message).toContain("storage.database");
    });
  });

  describe("mergeDiagnosticResults", () => {
    test("merges empty results", () => {
      const result1 = { byFile: new Map(), filesWithDiagnostics: [] };
      const result2 = { byFile: new Map(), filesWithDiagnostics: [] };

      const merged = mergeDiagnosticResults(result1, result2);

      expect(merged.byFile.size).toBe(0);
      expect(merged.filesWithDiagnostics).toHaveLength(0);
    });

    test("merges results from different files", () => {
      const result1 = {
        byFile: new Map([
          [
            "file:///a.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "Error 1",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///a.bp"],
      };
      const result2 = {
        byFile: new Map([
          [
            "file:///b.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "Error 2",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///b.bp"],
      };

      const merged = mergeDiagnosticResults(result1, result2);

      expect(merged.byFile.size).toBe(2);
      expect(merged.filesWithDiagnostics).toContain("file:///a.bp");
      expect(merged.filesWithDiagnostics).toContain("file:///b.bp");
    });

    test("merges results from same file", () => {
      const result1 = {
        byFile: new Map([
          [
            "file:///a.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "Error 1",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///a.bp"],
      };
      const result2 = {
        byFile: new Map([
          [
            "file:///a.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 5 },
                },
                message: "Error 2",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///a.bp"],
      };

      const merged = mergeDiagnosticResults(result1, result2);

      expect(merged.byFile.size).toBe(1);
      expect(merged.byFile.get("file:///a.bp")).toHaveLength(2);
    });
  });

  describe("computeNoTicketDiagnostics", () => {
    /**
     * Helper to create a ticket object.
     */
    function createTicket(
      id: string,
      ref: string,
      status: "pending" | "in-progress" | "complete" | "obsolete" = "pending"
    ): Ticket {
      return {
        id,
        ref,
        description: `Ticket for ${ref}`,
        status,
        constraints_satisfied: [],
      };
    }

    test("returns empty result for empty index", () => {
      const result = computeNoTicketDiagnostics(index, []);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("returns empty result when all requirements have tickets", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.

@requirement oauth
  OAuth authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const tickets = [
        createTicket("TKT-001", "auth.login.basic-auth"),
        createTicket("TKT-002", "auth.login.oauth"),
      ];

      const result = computeNoTicketDiagnostics(index, tickets);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("warns when requirement has no ticket", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeNoTicketDiagnostics(index, []);

      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.severity).toBe(DiagnosticSeverity.Warning);
      expect(diags[0]!.message).toContain("auth.login.basic-auth");
      expect(diags[0]!.message).toContain("no associated ticket");
      expect(diags[0]!.code).toBe("no-ticket");
      expect(diags[0]!.source).toBe("blueprint");
    });

    test("warns for multiple requirements without tickets", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.

@requirement oauth
  OAuth authentication.

@requirement two-factor
  2FA authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      // Only one requirement has a ticket
      const tickets = [createTicket("TKT-001", "auth.login.oauth")];

      const result = computeNoTicketDiagnostics(index, tickets);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(2);

      const messages = diags.map((d) => d.message);
      expect(messages.some((m) => m.includes("basic-auth"))).toBe(true);
      expect(messages.some((m) => m.includes("two-factor"))).toBe(true);
    });

    test("handles requirements across multiple files", () => {
      const authCode = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      const storageCode = `
@module storage

@feature database

@requirement user-table
  User table schema.
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///storage.bp", parseToAST(storageCode));

      // Only auth requirement has a ticket
      const tickets = [createTicket("TKT-001", "auth.login.basic-auth")];

      const result = computeNoTicketDiagnostics(index, tickets);

      expect(result.filesWithDiagnostics).toContain("file:///storage.bp");
      expect(result.filesWithDiagnostics).not.toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///storage.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.message).toContain("storage.database.user-table");
    });

    test("handles multiple tickets for same requirement", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      // Multiple tickets for same requirement (allowed per SPEC)
      const tickets = [
        createTicket("TKT-001", "auth.login.basic-auth"),
        createTicket("TKT-002", "auth.login.basic-auth"),
      ];

      const result = computeNoTicketDiagnostics(index, tickets);

      expect(result.byFile.size).toBe(0);
    });

    test("handles module-level requirements", () => {
      const code = `
@module auth

@requirement global-check
  Global authentication check.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeNoTicketDiagnostics(index, []);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.message).toContain("auth.global-check");
    });

    test("diagnostic range points to requirement declaration", () => {
      const code = `@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeNoTicketDiagnostics(index, []);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);

      // @requirement basic-auth is on line 4 (0-indexed)
      expect(diags[0]!.range.start.line).toBe(4);
      expect(diags[0]!.range.start.character).toBe(0);
    });
  });

  describe("computeWorkspaceDiagnostics", () => {
    test("returns empty result for empty index", () => {
      const result = computeWorkspaceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("combines circular dependency and unresolved reference diagnostics", () => {
      const codeA = `
@module a
  @depends-on b
  @depends-on nonexistent
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      const result = computeWorkspaceDiagnostics(index);

      const diagsA = result.byFile.get("file:///a.bp")!;

      // Should have both circular dependency and unresolved reference diagnostics
      const circularDiags = diagsA.filter(
        (d) => d.code === "circular-dependency"
      );
      const unresolvedDiags = diagsA.filter(
        (d) => d.code === "unresolved-reference"
      );

      expect(circularDiags.length).toBeGreaterThanOrEqual(1);
      expect(unresolvedDiags).toHaveLength(1);
    });

    test("returns clean result for valid workspace", () => {
      const storageCode = `
@module storage

@feature database

@requirement user-table
`;
      const authCode = `
@module auth
  @depends-on storage

@feature login
  @depends-on storage.database

@requirement basic-auth
  @depends-on storage.database.user-table
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = computeWorkspaceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("includes no-ticket warnings when tickets are provided", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.

@requirement oauth
  OAuth authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      // Only one requirement has a ticket
      const tickets: Ticket[] = [
        {
          id: "TKT-001",
          ref: "auth.login.basic-auth",
          description: "Implement basic auth",
          status: "complete",
          constraints_satisfied: [],
        },
      ];

      const result = computeWorkspaceDiagnostics(index, tickets);

      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      const noTicketDiags = diags.filter((d) => d.code === "no-ticket");
      expect(noTicketDiags).toHaveLength(1);
      expect(noTicketDiags[0]!.message).toContain("oauth");
      expect(noTicketDiags[0]!.severity).toBe(DiagnosticSeverity.Warning);
    });

    test("does not include no-ticket warnings when tickets not provided", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      // Don't pass tickets
      const result = computeWorkspaceDiagnostics(index);

      // Should not have any diagnostics since there are no circular deps or unresolved refs
      expect(result.byFile.size).toBe(0);
    });

    test("combines all diagnostic types", () => {
      const codeA = `
@module a
  @depends-on b
  @depends-on nonexistent

@feature login

@requirement req-a
  A requirement.
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      // No tickets provided for any requirements
      const tickets: Ticket[] = [];

      const result = computeWorkspaceDiagnostics(index, tickets);

      const diagsA = result.byFile.get("file:///a.bp")!;

      // Should have all three types of diagnostics
      const circularDiags = diagsA.filter((d) => d.code === "circular-dependency");
      const unresolvedDiags = diagsA.filter((d) => d.code === "unresolved-reference");
      const noTicketDiags = diagsA.filter((d) => d.code === "no-ticket");

      expect(circularDiags.length).toBeGreaterThanOrEqual(1);
      expect(unresolvedDiags).toHaveLength(1);
      expect(noTicketDiags).toHaveLength(1);
    });
  });

  describe("computeOrphanedTicketDiagnostics", () => {
    /**
     * Helper to create a ticket file info object.
     */
    function createTicketFileInfo(
      uri: string,
      tickets: Ticket[],
      source: string = "requirements/test.bp"
    ): TicketFileInfo {
      return {
        uri,
        data: {
          version: "1.0",
          source,
          tickets,
        },
      };
    }

    /**
     * Helper to create a ticket object.
     */
    function createTicket(
      id: string,
      ref: string,
      status: "pending" | "in-progress" | "complete" | "obsolete" = "pending"
    ): Ticket {
      return {
        id,
        ref,
        description: `Ticket for ${ref}`,
        status,
        constraints_satisfied: [],
      };
    }

    test("returns empty result for empty index and no ticket files", () => {
      const result = computeOrphanedTicketDiagnostics(index, []);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("returns empty result when all tickets reference valid requirements", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.

@requirement oauth
  OAuth authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.login.basic-auth"),
          createTicket("TKT-002", "auth.login.oauth"),
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("warns when ticket references non-existent requirement", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.login.basic-auth"),
          createTicket("TKT-002", "auth.login.removed-requirement"), // This doesn't exist
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      expect(result.filesWithDiagnostics).toContain(
        "file:///.blueprint/tickets/auth.tickets.json"
      );

      const diags = result.byFile.get(
        "file:///.blueprint/tickets/auth.tickets.json"
      )!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.severity).toBe(DiagnosticSeverity.Warning);
      expect(diags[0]!.message).toContain("TKT-002");
      expect(diags[0]!.message).toContain("auth.login.removed-requirement");
      expect(diags[0]!.message).toContain("removed requirement");
      expect(diags[0]!.code).toBe("orphaned-ticket");
      expect(diags[0]!.source).toBe("blueprint");
    });

    test("warns for multiple orphaned tickets in same file", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.login.basic-auth"),
          createTicket("TKT-002", "auth.login.removed-one"),
          createTicket("TKT-003", "auth.login.removed-two"),
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      const diags = result.byFile.get(
        "file:///.blueprint/tickets/auth.tickets.json"
      )!;
      expect(diags).toHaveLength(2);

      const messages = diags.map((d) => d.message);
      expect(messages.some((m) => m.includes("TKT-002"))).toBe(true);
      expect(messages.some((m) => m.includes("TKT-003"))).toBe(true);
    });

    test("handles orphaned tickets across multiple ticket files", () => {
      const authCode = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      const storageCode = `
@module storage

@feature database

@requirement user-table
  User table schema.
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///storage.bp", parseToAST(storageCode));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.login.basic-auth"),
          createTicket("TKT-002", "auth.login.removed"), // orphaned
        ]),
        createTicketFileInfo("file:///.blueprint/tickets/storage.tickets.json", [
          createTicket("TKT-003", "storage.database.user-table"),
          createTicket("TKT-004", "storage.database.deleted"), // orphaned
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      expect(result.filesWithDiagnostics).toHaveLength(2);
      expect(result.filesWithDiagnostics).toContain(
        "file:///.blueprint/tickets/auth.tickets.json"
      );
      expect(result.filesWithDiagnostics).toContain(
        "file:///.blueprint/tickets/storage.tickets.json"
      );

      const authDiags = result.byFile.get(
        "file:///.blueprint/tickets/auth.tickets.json"
      )!;
      expect(authDiags).toHaveLength(1);
      expect(authDiags[0]!.message).toContain("TKT-002");

      const storageDiags = result.byFile.get(
        "file:///.blueprint/tickets/storage.tickets.json"
      )!;
      expect(storageDiags).toHaveLength(1);
      expect(storageDiags[0]!.message).toContain("TKT-004");
    });

    test("does not warn for valid module-level requirement refs", () => {
      const code = `
@module auth

@requirement global-check
  Global authentication check.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.global-check"),
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      expect(result.byFile.size).toBe(0);
    });

    test("warns when module exists but requirement does not", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          // Module exists, feature exists, but requirement doesn't
          createTicket("TKT-001", "auth.login.nonexistent"),
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      expect(result.filesWithDiagnostics).toContain(
        "file:///.blueprint/tickets/auth.tickets.json"
      );

      const diags = result.byFile.get(
        "file:///.blueprint/tickets/auth.tickets.json"
      )!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.message).toContain("auth.login.nonexistent");
    });

    test("handles empty ticket file gracefully", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", []),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      expect(result.byFile.size).toBe(0);
    });

    test("handles empty symbol index with tickets", () => {
      // No .bp files indexed, but we have tickets
      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.login.basic-auth"),
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      // All tickets should be orphaned since there are no requirements
      expect(result.filesWithDiagnostics).toContain(
        "file:///.blueprint/tickets/auth.tickets.json"
      );

      const diags = result.byFile.get(
        "file:///.blueprint/tickets/auth.tickets.json"
      )!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.message).toContain("TKT-001");
    });

    test("ticket with obsolete status still triggers warning if ref is invalid", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const ticketFiles = [
        createTicketFileInfo("file:///.blueprint/tickets/auth.tickets.json", [
          createTicket("TKT-001", "auth.login.removed", "obsolete"),
        ]),
      ];

      const result = computeOrphanedTicketDiagnostics(index, ticketFiles);

      // Even obsolete tickets with invalid refs should warn
      // This helps users clean up their ticket files
      expect(result.filesWithDiagnostics).toContain(
        "file:///.blueprint/tickets/auth.tickets.json"
      );

      const diags = result.byFile.get(
        "file:///.blueprint/tickets/auth.tickets.json"
      )!;
      expect(diags).toHaveLength(1);
    });
  });
});
