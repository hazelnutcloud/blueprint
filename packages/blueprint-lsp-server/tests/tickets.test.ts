import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveTicketFilePath,
  resolveTicketFileUri,
  ticketFileExists,
  resolveBpFileBaseName,
  getTicketFileName,
  isTicketFilePath,
  isBlueprintFilePath,
  DEFAULT_TICKETS_PATH,
  TICKET_FILE_EXTENSION,
  TICKET_SCHEMA_VERSION,
  VALID_TICKET_STATUSES,
  validateTicketFile,
  parseTicketFileContent,
  parseTicketFile,
  type Ticket,
  type TicketFile,
  type TicketImplementation,
  type TicketStatus,
  type TicketValidationError,
  type TicketValidationResult,
} from "../src/tickets";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { URI } from "vscode-uri";

describe("tickets", () => {
  describe("constants", () => {
    test("DEFAULT_TICKETS_PATH is .blueprint/tickets", () => {
      expect(DEFAULT_TICKETS_PATH).toBe(".blueprint/tickets");
    });

    test("TICKET_FILE_EXTENSION is .tickets.json", () => {
      expect(TICKET_FILE_EXTENSION).toBe(".tickets.json");
    });
  });

  describe("resolveTicketFilePath", () => {
    test("resolves basic path with default tickets path", () => {
      const bpPath = "/project/requirements/auth.bp";
      const workspaceRoot = "/project";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot);
      
      expect(result).toBe("/project/.blueprint/tickets/auth.tickets.json");
    });

    test("resolves path with custom tickets path", () => {
      const bpPath = "/project/requirements/auth.bp";
      const workspaceRoot = "/project";
      const ticketsPath = "tickets";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot, ticketsPath);
      
      expect(result).toBe("/project/tickets/auth.tickets.json");
    });

    test("resolves path with nested custom tickets path", () => {
      const bpPath = "/project/auth.bp";
      const workspaceRoot = "/project";
      const ticketsPath = "data/tracking/tickets";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot, ticketsPath);
      
      expect(result).toBe("/project/data/tracking/tickets/auth.tickets.json");
    });

    test("handles .bp file in workspace root", () => {
      const bpPath = "/project/auth.bp";
      const workspaceRoot = "/project";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot);
      
      expect(result).toBe("/project/.blueprint/tickets/auth.tickets.json");
    });

    test("handles .bp file in deep subdirectory", () => {
      const bpPath = "/project/specs/requirements/v2/auth.bp";
      const workspaceRoot = "/project";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot);
      
      // Only the basename is used, not the full relative path
      expect(result).toBe("/project/.blueprint/tickets/auth.tickets.json");
    });

    test("handles hyphenated file names", () => {
      const bpPath = "/project/user-authentication.bp";
      const workspaceRoot = "/project";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot);
      
      expect(result).toBe("/project/.blueprint/tickets/user-authentication.tickets.json");
    });

    test("handles underscored file names", () => {
      const bpPath = "/project/user_authentication.bp";
      const workspaceRoot = "/project";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot);
      
      expect(result).toBe("/project/.blueprint/tickets/user_authentication.tickets.json");
    });

    test("handles file names with multiple dots", () => {
      const bpPath = "/project/auth.v2.bp";
      const workspaceRoot = "/project";
      
      const result = resolveTicketFilePath(bpPath, workspaceRoot);
      
      expect(result).toBe("/project/.blueprint/tickets/auth.v2.tickets.json");
    });
  });

  describe("resolveTicketFileUri", () => {
    test("resolves URI with default tickets path", () => {
      const bpUri = URI.file("/project/requirements/auth.bp").toString();
      const workspaceUri = URI.file("/project").toString();
      
      const result = resolveTicketFileUri(bpUri, workspaceUri);
      
      expect(result).toBe(URI.file("/project/.blueprint/tickets/auth.tickets.json").toString());
    });

    test("resolves URI with custom tickets path", () => {
      const bpUri = URI.file("/project/auth.bp").toString();
      const workspaceUri = URI.file("/project").toString();
      
      const result = resolveTicketFileUri(bpUri, workspaceUri, "custom/tickets");
      
      expect(result).toBe(URI.file("/project/custom/tickets/auth.tickets.json").toString());
    });
  });

  describe("ticketFileExists", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `blueprint-tickets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    test("returns true when ticket file exists", async () => {
      // Create ticket directory and file
      const ticketsDir = join(testDir, ".blueprint", "tickets");
      await mkdir(ticketsDir, { recursive: true });
      await writeFile(join(ticketsDir, "auth.tickets.json"), "{}");
      
      const bpPath = join(testDir, "requirements", "auth.bp");
      
      const result = await ticketFileExists(bpPath, testDir);
      
      expect(result).toBe(true);
    });

    test("returns false when ticket file does not exist", async () => {
      const bpPath = join(testDir, "auth.bp");
      
      const result = await ticketFileExists(bpPath, testDir);
      
      expect(result).toBe(false);
    });

    test("returns false when tickets directory does not exist", async () => {
      const bpPath = join(testDir, "auth.bp");
      
      const result = await ticketFileExists(bpPath, testDir);
      
      expect(result).toBe(false);
    });

    test("returns false when path exists but is a directory", async () => {
      // Create a directory with the ticket file name
      const ticketsDir = join(testDir, ".blueprint", "tickets");
      const dirAsFile = join(ticketsDir, "auth.tickets.json");
      await mkdir(dirAsFile, { recursive: true });
      
      const bpPath = join(testDir, "auth.bp");
      
      const result = await ticketFileExists(bpPath, testDir);
      
      expect(result).toBe(false);
    });

    test("works with custom tickets path", async () => {
      // Create custom ticket directory and file
      const ticketsDir = join(testDir, "custom-tickets");
      await mkdir(ticketsDir, { recursive: true });
      await writeFile(join(ticketsDir, "auth.tickets.json"), "{}");
      
      const bpPath = join(testDir, "auth.bp");
      
      const result = await ticketFileExists(bpPath, testDir, "custom-tickets");
      
      expect(result).toBe(true);
    });
  });

  describe("resolveBpFileBaseName", () => {
    test("extracts .bp base name from ticket file path", () => {
      const ticketPath = "/project/.blueprint/tickets/auth.tickets.json";
      
      const result = resolveBpFileBaseName(ticketPath);
      
      expect(result).toBe("auth.bp");
    });

    test("handles hyphenated names", () => {
      const ticketPath = "/project/.blueprint/tickets/user-auth.tickets.json";
      
      const result = resolveBpFileBaseName(ticketPath);
      
      expect(result).toBe("user-auth.bp");
    });

    test("handles names with multiple dots", () => {
      const ticketPath = "/project/.blueprint/tickets/auth.v2.tickets.json";
      
      const result = resolveBpFileBaseName(ticketPath);
      
      expect(result).toBe("auth.v2.bp");
    });
  });

  describe("getTicketFileName", () => {
    test("returns ticket file name from .bp path", () => {
      const bpPath = "/project/requirements/auth.bp";
      
      const result = getTicketFileName(bpPath);
      
      expect(result).toBe("auth.tickets.json");
    });

    test("works with just file name", () => {
      const bpPath = "auth.bp";
      
      const result = getTicketFileName(bpPath);
      
      expect(result).toBe("auth.tickets.json");
    });

    test("handles complex file names", () => {
      const bpPath = "user-authentication-v2.bp";
      
      const result = getTicketFileName(bpPath);
      
      expect(result).toBe("user-authentication-v2.tickets.json");
    });
  });

  describe("isTicketFilePath", () => {
    test("returns true for .tickets.json files", () => {
      expect(isTicketFilePath("/project/.blueprint/tickets/auth.tickets.json")).toBe(true);
      expect(isTicketFilePath("auth.tickets.json")).toBe(true);
    });

    test("returns false for non-ticket files", () => {
      expect(isTicketFilePath("/project/auth.bp")).toBe(false);
      expect(isTicketFilePath("/project/auth.json")).toBe(false);
      expect(isTicketFilePath("/project/tickets.json")).toBe(false);
      expect(isTicketFilePath("/project/auth.tickets")).toBe(false);
    });
  });

  describe("isBlueprintFilePath", () => {
    test("returns true for .bp files", () => {
      expect(isBlueprintFilePath("/project/requirements/auth.bp")).toBe(true);
      expect(isBlueprintFilePath("auth.bp")).toBe(true);
    });

    test("returns false for non-.bp files", () => {
      expect(isBlueprintFilePath("/project/auth.tickets.json")).toBe(false);
      expect(isBlueprintFilePath("/project/auth.json")).toBe(false);
      expect(isBlueprintFilePath("/project/auth.bpp")).toBe(false);
      expect(isBlueprintFilePath("/project/bp")).toBe(false);
    });
  });

  // ==========================================================================
  // Ticket Schema Validation Tests
  // ==========================================================================

  describe("schema constants", () => {
    test("TICKET_SCHEMA_VERSION is 1.0", () => {
      expect(TICKET_SCHEMA_VERSION).toBe("1.0");
    });

    test("VALID_TICKET_STATUSES contains all valid statuses", () => {
      expect(VALID_TICKET_STATUSES).toContain("pending");
      expect(VALID_TICKET_STATUSES).toContain("in-progress");
      expect(VALID_TICKET_STATUSES).toContain("complete");
      expect(VALID_TICKET_STATUSES).toContain("obsolete");
      expect(VALID_TICKET_STATUSES).toHaveLength(4);
    });

    test("blocked is NOT a valid ticket status (per SPEC)", () => {
      expect(VALID_TICKET_STATUSES).not.toContain("blocked");
    });
  });

  describe("validateTicketFile", () => {
    const validTicket: Ticket = {
      id: "TKT-001",
      ref: "authentication.login.basic-auth",
      description: "Implement email/password login endpoint",
      status: "in-progress",
      constraints_satisfied: ["bcrypt-cost"],
      implementation: {
        files: ["src/auth/login.ts"],
        tests: ["tests/auth/login.test.ts"],
      },
    };

    const validTicketFile: TicketFile = {
      version: "1.0",
      source: "requirements/auth.bp",
      tickets: [validTicket],
    };

    test("validates a correct ticket file", () => {
      const result = validateTicketFile(validTicketFile);
      
      expect(result.valid).toBe(true);
      expect(result.data).not.toBeNull();
      expect(result.errors).toHaveLength(0);
    });

    test("validates ticket file with empty tickets array", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/empty.bp",
        tickets: [],
      });
      
      expect(result.valid).toBe(true);
      expect(result.data?.tickets).toHaveLength(0);
    });

    test("validates ticket file with multiple tickets", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          { ...validTicket, id: "TKT-001" },
          { ...validTicket, id: "TKT-002", status: "pending" },
          { ...validTicket, id: "TKT-003", status: "complete" },
        ],
      });
      
      expect(result.valid).toBe(true);
      expect(result.data?.tickets).toHaveLength(3);
    });

    test("validates ticket without implementation (optional field)", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
        }],
      });
      
      expect(result.valid).toBe(true);
    });

    test("validates ticket with empty implementation object", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
          implementation: {},
        }],
      });
      
      expect(result.valid).toBe(true);
    });

    test("validates all ticket statuses", () => {
      for (const status of VALID_TICKET_STATUSES) {
        const result = validateTicketFile({
          version: "1.0",
          source: "requirements/auth.bp",
          tickets: [{
            id: "TKT-001",
            ref: "module.feature.req",
            description: "Test",
            status,
            constraints_satisfied: [],
          }],
        });
        
        expect(result.valid).toBe(true);
      }
    });

    // Error cases

    test("rejects non-object input", () => {
      expect(validateTicketFile(null).valid).toBe(false);
      expect(validateTicketFile(undefined).valid).toBe(false);
      expect(validateTicketFile("string").valid).toBe(false);
      expect(validateTicketFile(123).valid).toBe(false);
      expect(validateTicketFile([]).valid).toBe(false);
    });

    test("rejects missing version", () => {
      const result = validateTicketFile({
        source: "requirements/auth.bp",
        tickets: [],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "version")).toBe(true);
    });

    test("rejects non-string version", () => {
      const result = validateTicketFile({
        version: 1.0,
        source: "requirements/auth.bp",
        tickets: [],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "version")).toBe(true);
    });

    test("warns about unknown version but still validates", () => {
      const result = validateTicketFile({
        version: "2.0",
        source: "requirements/auth.bp",
        tickets: [],
      });
      
      // Valid because version warning is non-critical
      expect(result.valid).toBe(true);
      expect(result.errors.some(e => e.message.includes("unknown schema version"))).toBe(true);
    });

    test("rejects missing source", () => {
      const result = validateTicketFile({
        version: "1.0",
        tickets: [],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "source")).toBe(true);
    });

    test("rejects missing tickets array", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets")).toBe(true);
    });

    test("rejects non-array tickets", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: {},
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets")).toBe(true);
    });

    test("rejects duplicate ticket IDs", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [
          { ...validTicket, id: "TKT-001" },
          { ...validTicket, id: "TKT-001" }, // duplicate
        ],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes("duplicate ticket id"))).toBe(true);
    });

    test("rejects non-object ticket", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: ["not an object"],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message === "ticket must be an object")).toBe(true);
    });

    test("rejects missing ticket.id", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].id")).toBe(true);
    });

    test("rejects missing ticket.ref", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].ref")).toBe(true);
    });

    test("rejects missing ticket.description", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          status: "pending",
          constraints_satisfied: [],
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].description")).toBe(true);
    });

    test("rejects missing ticket.status", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          constraints_satisfied: [],
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].status")).toBe(true);
    });

    test("rejects invalid ticket.status", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "blocked", // Not a valid status per SPEC
          constraints_satisfied: [],
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].status")).toBe(true);
    });

    test("rejects missing ticket.constraints_satisfied", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].constraints_satisfied")).toBe(true);
    });

    test("rejects non-array constraints_satisfied", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: "bcrypt-cost",
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].constraints_satisfied")).toBe(true);
    });

    test("rejects non-string in constraints_satisfied", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: ["valid", 123, "also-valid"],
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].constraints_satisfied[1]")).toBe(true);
    });

    test("rejects non-object implementation", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
          implementation: "not an object",
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].implementation")).toBe(true);
    });

    test("rejects non-array implementation.files", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
          implementation: { files: "not an array" },
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].implementation.files")).toBe(true);
    });

    test("rejects non-string in implementation.files", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
          implementation: { files: ["valid.ts", 123] },
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].implementation.files[1]")).toBe(true);
    });

    test("rejects non-array implementation.tests", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
          implementation: { tests: "not an array" },
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].implementation.tests")).toBe(true);
    });

    test("rejects non-string in implementation.tests", () => {
      const result = validateTicketFile({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "module.feature.req",
          description: "Test",
          status: "pending",
          constraints_satisfied: [],
          implementation: { tests: [null] },
        }],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "tickets[0].implementation.tests[0]")).toBe(true);
    });

    test("collects multiple errors", () => {
      const result = validateTicketFile({
        version: 1.0, // error: not a string
        // missing source
        tickets: [
          {
            // missing id
            ref: 123, // error: not a string
            description: "Test",
            status: "invalid", // error: invalid status
            constraints_satisfied: [],
          },
        ],
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(3);
    });
  });

  describe("parseTicketFileContent", () => {
    test("parses valid JSON", () => {
      const json = JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [],
      });
      
      const result = parseTicketFileContent(json);
      
      expect(result.valid).toBe(true);
      expect(result.data).not.toBeNull();
    });

    test("returns error for invalid JSON", () => {
      const result = parseTicketFileContent("{ not valid json }");
      
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("invalid JSON");
    });

    test("returns error for empty string", () => {
      const result = parseTicketFileContent("");
      
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("invalid JSON");
    });

    test("validates parsed content", () => {
      const json = JSON.stringify({
        version: "1.0",
        // missing source and tickets
      });
      
      const result = parseTicketFileContent(json);
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === "source")).toBe(true);
    });
  });

  describe("parseTicketFile (from disk)", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `blueprint-tickets-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    test("reads and validates a valid ticket file", async () => {
      const ticketPath = join(testDir, "auth.tickets.json");
      await writeFile(ticketPath, JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          ref: "auth.login.basic",
          description: "Implement login",
          status: "pending",
          constraints_satisfied: [],
        }],
      }));
      
      const result = await parseTicketFile(ticketPath);
      
      expect(result.valid).toBe(true);
      expect(result.data?.tickets).toHaveLength(1);
    });

    test("returns error for non-existent file", async () => {
      const result = await parseTicketFile(join(testDir, "nonexistent.tickets.json"));
      
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("failed to read file");
    });

    test("returns error for invalid JSON in file", async () => {
      const ticketPath = join(testDir, "invalid.tickets.json");
      await writeFile(ticketPath, "{ not valid }");
      
      const result = await parseTicketFile(ticketPath);
      
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("invalid JSON");
    });

    test("returns validation errors for invalid schema", async () => {
      const ticketPath = join(testDir, "bad-schema.tickets.json");
      await writeFile(ticketPath, JSON.stringify({
        version: "1.0",
        source: "requirements/auth.bp",
        tickets: [{
          id: "TKT-001",
          // missing required fields
        }],
      }));
      
      const result = await parseTicketFile(ticketPath);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
