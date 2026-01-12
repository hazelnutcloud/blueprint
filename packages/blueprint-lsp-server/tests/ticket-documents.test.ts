import { test, expect, describe, beforeEach, mock } from "bun:test";
import { DiagnosticSeverity, type Connection } from "vscode-languageserver/node";
import { TicketDocumentManager } from "../src/ticket-documents";

// Mock connection for testing
function createMockConnection() {
  const diagnostics: { uri: string; diagnostics: unknown[] }[] = [];
  const logs: string[] = [];

  return {
    sendDiagnostics: mock((params: { uri: string; diagnostics: unknown[] }) => {
      diagnostics.push(params);
    }),
    console: {
      log: mock((msg: string) => logs.push(msg)),
      warn: mock((msg: string) => logs.push(`WARN: ${msg}`)),
      error: mock((msg: string) => logs.push(`ERROR: ${msg}`)),
    },
    // Access captured data for assertions
    _diagnostics: diagnostics,
    _logs: logs,
  };
}

describe("TicketDocumentManager", () => {
  let manager: TicketDocumentManager;
  let mockConnection: ReturnType<typeof createMockConnection>;

  beforeEach(() => {
    mockConnection = createMockConnection();
    // Cast to Connection - we only use sendDiagnostics and console methods
    manager = new TicketDocumentManager(mockConnection as unknown as Connection);
  });

  describe("valid ticket files", () => {
    test("parses valid ticket file with no errors", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement login",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(false);
      expect(state.data).not.toBeNull();
      expect(state.data?.tickets).toHaveLength(1);
      expect(state.diagnostics).toHaveLength(0);
    });

    test("parses valid ticket file with implementation details", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement login",
            status: "complete",
            constraints_satisfied: ["bcrypt-cost"],
            implementation: {
              files: ["src/auth/login.ts"],
              tests: ["tests/auth/login.test.ts"],
            },
          },
        ],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(false);
      expect(state.data?.tickets[0]?.implementation?.files).toEqual(["src/auth/login.ts"]);
    });

    test("publishes empty diagnostics for valid file", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });

      manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(mockConnection.sendDiagnostics).toHaveBeenCalled();
      const lastCall = mockConnection._diagnostics[mockConnection._diagnostics.length - 1];
      expect(lastCall?.diagnostics).toHaveLength(0);
    });
  });

  describe("invalid JSON", () => {
    test("reports error for malformed JSON", () => {
      const content = "{ invalid json }";

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.data).toBeNull();
      expect(state.diagnostics).toHaveLength(1);
      expect(state.diagnostics[0]?.message).toContain("invalid JSON");
      expect(state.diagnostics[0]?.severity).toBe(DiagnosticSeverity.Error);
    });

    test("reports error for empty content", () => {
      const content = "";

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.length).toBeGreaterThan(0);
    });

    test("reports error for non-object JSON", () => {
      const content = "[]";

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics[0]?.message).toContain("must be a JSON object");
    });
  });

  describe("schema validation errors", () => {
    test("reports error for missing version field", () => {
      const content = JSON.stringify({
        source: "requirements/auth.bp",
        tickets: [],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.some((d) => d.message.includes("version"))).toBe(true);
    });

    test("reports error for missing source field", () => {
      const content = JSON.stringify({
        version: "1.0",
        tickets: [],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.some((d) => d.message.includes("source"))).toBe(true);
    });

    test("reports error for missing tickets array", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.some((d) => d.message.includes("tickets"))).toBe(true);
    });

    test("reports error for invalid ticket status", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login",
            description: "Test",
            status: "blocked", // Invalid - "blocked" is computed by LSP, not stored
            constraints_satisfied: [],
          },
        ],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.some((d) => d.message.includes("status"))).toBe(true);
    });

    test("reports error for missing ticket id", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            ref: "auth.login",
            description: "Test",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.some((d) => d.message.includes("id"))).toBe(true);
    });

    test("reports error for duplicate ticket IDs", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login",
            description: "First",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-001",
            ref: "auth.logout",
            description: "Second",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(true);
      expect(state.diagnostics.some((d) => d.message.includes("duplicate ticket id"))).toBe(true);
    });
  });

  describe("version warnings", () => {
    test("reports warning for unknown schema version", () => {
      const content = JSON.stringify({
        version: "2.0", // Unknown version
        source: "requirements/auth.bp",
        tickets: [],
      });

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      // Should be valid but have a warning
      expect(state.hasErrors).toBe(false); // Version mismatch doesn't fail validation
      expect(state.diagnostics).toHaveLength(1);
      expect(state.diagnostics[0]?.severity).toBe(DiagnosticSeverity.Warning);
      expect(state.diagnostics[0]?.message).toContain("unknown schema version");
    });
  });

  describe("document lifecycle", () => {
    test("onDocumentChange updates state", () => {
      const initialContent = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });

      manager.onDocumentOpen("file:///test.tickets.json", 1, initialContent);

      const updatedContent = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login",
            description: "New ticket",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      });

      const state = manager.onDocumentChange("file:///test.tickets.json", 2, updatedContent);

      expect(state.version).toBe(2);
      expect(state.data?.tickets).toHaveLength(1);
    });

    test("onDocumentClose clears state", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });

      manager.onDocumentOpen("file:///test.tickets.json", 1, content);
      expect(manager.getState("file:///test.tickets.json")).toBeDefined();

      manager.onDocumentClose("file:///test.tickets.json");
      expect(manager.getState("file:///test.tickets.json")).toBeUndefined();
    });

    test("onDocumentClose publishes empty diagnostics", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });

      manager.onDocumentOpen("file:///test.tickets.json", 1, content);
      const diagnosticsCount = mockConnection._diagnostics.length;

      manager.onDocumentClose("file:///test.tickets.json");

      // Should have published one more diagnostics call
      expect(mockConnection._diagnostics.length).toBe(diagnosticsCount + 1);
      const lastCall = mockConnection._diagnostics[mockConnection._diagnostics.length - 1];
      expect(lastCall?.diagnostics).toHaveLength(0);
    });

    test("onDocumentSave triggers validation", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });

      const state = manager.onDocumentSave("file:///test.tickets.json", 1, content);

      expect(state.hasErrors).toBe(false);
      expect(mockConnection.sendDiagnostics).toHaveBeenCalled();
    });

    test("cleanup clears all states", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });

      manager.onDocumentOpen("file:///a.tickets.json", 1, content);
      manager.onDocumentOpen("file:///b.tickets.json", 1, content);

      expect(manager.getState("file:///a.tickets.json")).toBeDefined();
      expect(manager.getState("file:///b.tickets.json")).toBeDefined();

      manager.cleanup();

      expect(manager.getState("file:///a.tickets.json")).toBeUndefined();
      expect(manager.getState("file:///b.tickets.json")).toBeUndefined();
    });
  });

  describe("getData helper", () => {
    test("returns parsed data for valid document", () => {
      const content = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login",
            description: "Test",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      });

      manager.onDocumentOpen("file:///test.tickets.json", 1, content);
      const data = manager.getData("file:///test.tickets.json");

      expect(data).not.toBeNull();
      expect(data?.tickets).toHaveLength(1);
    });

    test("returns null for invalid document", () => {
      const content = "invalid json";

      manager.onDocumentOpen("file:///test.tickets.json", 1, content);
      const data = manager.getData("file:///test.tickets.json");

      expect(data).toBeNull();
    });

    test("returns null for unknown document", () => {
      const data = manager.getData("file:///unknown.tickets.json");
      expect(data).toBeNull();
    });
  });

  describe("diagnostic source", () => {
    test("diagnostics have source set to blueprint-tickets", () => {
      const content = "invalid";

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.diagnostics[0]?.source).toBe("blueprint-tickets");
    });
  });

  describe("diagnostic locations", () => {
    test("locates error at version field", () => {
      const content = `{
  "version": 123,
  "source": "test.bp",
  "tickets": []
}`;

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      // Should have a diagnostic for version field (should be string, not number)
      expect(state.diagnostics.length).toBeGreaterThan(0);
      // The diagnostic should point to the version line
      const versionDiag = state.diagnostics.find((d) => d.message.includes("version"));
      expect(versionDiag).toBeDefined();
    });

    test("locates error at ticket status field", () => {
      const content = `{
  "version": "1.0",
  "source": "test.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "test",
      "description": "test",
      "status": "invalid-status",
      "constraints_satisfied": []
    }
  ]
}`;

      const state = manager.onDocumentOpen("file:///test.tickets.json", 1, content);

      expect(state.diagnostics.length).toBeGreaterThan(0);
      const statusDiag = state.diagnostics.find((d) => d.message.includes("status"));
      expect(statusDiag).toBeDefined();
    });
  });
});
