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
});
