import { URI } from "vscode-uri";
import { join, basename } from "node:path";
import { readFile } from "node:fs/promises";
import * as v from "valibot";

// ============================================================================
// Ticket Schema Types (per SPEC.md Section 4)
// ============================================================================

/**
 * Current schema version for ticket files.
 * Per SPEC.md Section 4.5: version is currently "1.0"
 */
export const TICKET_SCHEMA_VERSION = "1.0";

/**
 * Valid ticket status values.
 * Per SPEC.md Section 4.7:
 * - pending: Not yet started
 * - in-progress: Currently being implemented
 * - complete: Fully implemented and all constraints satisfied
 * - obsolete: Requirement was removed (ticket pending cleanup)
 *
 * Note: "blocked" is NOT a valid status - it's computed dynamically by the LSP.
 */
export const VALID_TICKET_STATUSES = ["pending", "in-progress", "complete", "obsolete"] as const;

export type TicketStatus = (typeof VALID_TICKET_STATUSES)[number];

// ============================================================================
// Valibot Schemas
// ============================================================================

/**
 * Schema for ticket status enum.
 */
const TicketStatusSchema = v.picklist(VALID_TICKET_STATUSES);

/**
 * Schema for implementation details.
 * Per SPEC.md Section 4.8.
 */
const TicketImplementationSchema = v.object({
  files: v.optional(v.array(v.string())),
  tests: v.optional(v.array(v.string())),
});

/**
 * Schema for a single ticket.
 * Per SPEC.md Section 4.6.
 */
const TicketSchema = v.object({
  id: v.string(),
  ref: v.string(),
  description: v.string(),
  status: TicketStatusSchema,
  constraints_satisfied: v.array(v.string()),
  implementation: v.optional(TicketImplementationSchema),
});

/**
 * Schema for the root ticket file structure.
 * Per SPEC.md Section 4.4 and 4.5.
 */
const TicketFileSchema = v.object({
  version: v.string(),
  source: v.string(),
  tickets: v.array(TicketSchema),
});

// ============================================================================
// TypeScript Types (inferred from schemas)
// ============================================================================

/**
 * Implementation details for a ticket.
 * Per SPEC.md Section 4.8.
 */
export type TicketImplementation = v.InferOutput<typeof TicketImplementationSchema>;

/**
 * A single ticket tracking implementation of a requirement.
 * Per SPEC.md Section 4.6.
 */
export type Ticket = v.InferOutput<typeof TicketSchema>;

/**
 * The root structure of a .tickets.json file.
 * Per SPEC.md Section 4.4 and 4.5.
 */
export type TicketFile = v.InferOutput<typeof TicketFileSchema>;

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Represents a validation error found in a ticket file.
 */
export interface TicketValidationError {
  /** Error message describing the issue */
  message: string;
  /** JSON path to the error location (e.g., "tickets[0].status") */
  path: string;
  /** The invalid value that caused the error (if applicable) */
  value?: unknown;
}

/**
 * Result of validating a ticket file.
 */
export interface TicketValidationResult {
  /** Whether the ticket file is valid */
  valid: boolean;
  /** The parsed ticket file if valid, null otherwise */
  data: TicketFile | null;
  /** Array of validation errors (empty if valid) */
  errors: TicketValidationError[];
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Converts a valibot issue path to a dot-notation string.
 */
function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  if (!issue.path) return "";

  return issue.path
    .map((segment) => {
      if (segment.type === "array") {
        return `[${segment.key}]`;
      }
      return `.${segment.key}`;
    })
    .join("")
    .replace(/^\./, ""); // Remove leading dot
}

/**
 * Converts a valibot issue to our TicketValidationError format.
 */
function issueToError(issue: v.BaseIssue<unknown>): TicketValidationError {
  const path = formatIssuePath(issue);

  // Create user-friendly error messages
  let message: string;

  if (issue.type === "object" && issue.expected === "Object") {
    // Check if this is a ticket in the array (path like "tickets[0]")
    if (/^tickets\[\d+\]$/.test(path)) {
      message = "ticket must be an object";
    } else if (path) {
      message = `${path} must be an object`;
    } else {
      message = "ticket file must be a JSON object";
    }
  } else if (issue.type === "array" && issue.expected === "Array") {
    message = `${path} must be an array`;
  } else if (issue.type === "string" && issue.expected === "string") {
    if (path.includes(".")) {
      const field = path.split(".").pop();
      message = `${path.replace(/\.[^.]+$/, "")}.${field} is required and must be a string`;
    } else {
      message = `${path} is required and must be a string`;
    }
  } else if (issue.type === "picklist") {
    message = `ticket.status must be one of: ${VALID_TICKET_STATUSES.join(", ")}`;
  } else {
    message = issue.message;
  }

  return {
    message,
    path,
    value: issue.input,
  };
}

/**
 * Validates a parsed ticket file object against the schema.
 * Does not check semantic validity (e.g., whether refs point to real requirements).
 *
 * @param data The parsed JSON object to validate
 * @returns Validation result with errors if invalid
 */
export function validateTicketFile(data: unknown): TicketValidationResult {
  const errors: TicketValidationError[] = [];

  // First check if it's an object at all
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      valid: false,
      data: null,
      errors: [{ message: "ticket file must be a JSON object", path: "" }],
    };
  }

  // Parse with valibot
  const result = v.safeParse(TicketFileSchema, data);

  if (!result.success) {
    // Convert valibot issues to our error format
    for (const issue of result.issues) {
      errors.push(issueToError(issue));
    }

    return {
      valid: false,
      data: null,
      errors,
    };
  }

  const ticketFile = result.output;

  // Check for version mismatch (warning, not error)
  if (ticketFile.version !== TICKET_SCHEMA_VERSION) {
    errors.push({
      message: `unknown schema version "${ticketFile.version}", expected "${TICKET_SCHEMA_VERSION}"`,
      path: "version",
      value: ticketFile.version,
    });
  }

  // Check for duplicate ticket IDs
  const ticketIds = new Set<string>();
  for (let i = 0; i < ticketFile.tickets.length; i++) {
    const ticket = ticketFile.tickets[i]!;
    if (ticketIds.has(ticket.id)) {
      errors.push({
        message: `duplicate ticket id "${ticket.id}"`,
        path: `tickets[${i}].id`,
        value: ticket.id,
      });
    }
    ticketIds.add(ticket.id);
  }

  // If we have duplicate IDs, that's a critical error
  const hasDuplicates = errors.some((e) => e.message.includes("duplicate ticket id"));
  if (hasDuplicates) {
    return {
      valid: false,
      data: null,
      errors,
    };
  }

  return {
    valid: true,
    data: ticketFile,
    errors, // May contain version warnings
  };
}

/**
 * Parses and validates a ticket file from a JSON string.
 *
 * @param jsonString The JSON string to parse
 * @returns Validation result with parsed data if valid
 */
export function parseTicketFileContent(jsonString: string): TicketValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
          path: "",
        },
      ],
    };
  }

  return validateTicketFile(parsed);
}

/**
 * Reads and validates a ticket file from disk.
 *
 * @param ticketFilePath Absolute path to the .tickets.json file
 * @returns Validation result with parsed data if valid, or errors if invalid/not found
 */
export async function parseTicketFile(ticketFilePath: string): Promise<TicketValidationResult> {
  let content: string;
  try {
    content = await readFile(ticketFilePath, "utf-8");
  } catch (e) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          message: `failed to read file: ${e instanceof Error ? e.message : String(e)}`,
          path: "",
        },
      ],
    };
  }

  return parseTicketFileContent(content);
}

/**
 * Default path for ticket files relative to workspace root.
 * Per SPEC.md Section 5.9: blueprint.ticketsPath defaults to ".blueprint/tickets"
 */
export const DEFAULT_TICKETS_PATH = ".blueprint/tickets";

/**
 * Ticket file extension per SPEC.md Section 8.1.
 */
export const TICKET_FILE_EXTENSION = ".tickets.json";

/**
 * Resolves the ticket file path for a given Blueprint file.
 *
 * Per SPEC.md Section 4.3:
 *   requirements/auth.bp → .blueprint/tickets/auth.tickets.json
 *
 * The resolution works by:
 * 1. Finding the workspace root (containing the .bp file)
 * 2. Getting the base name of the .bp file (without extension)
 * 3. Constructing the ticket path: {workspaceRoot}/{ticketsPath}/{basename}.tickets.json
 *
 * @param bpFilePath - Absolute path to the .bp file
 * @param workspaceRoot - Absolute path to the workspace root directory
 * @param ticketsPath - Relative path from workspace root to tickets directory (defaults to ".blueprint/tickets")
 * @returns Absolute path to the corresponding ticket file
 */
export function resolveTicketFilePath(
  bpFilePath: string,
  workspaceRoot: string,
  ticketsPath: string = DEFAULT_TICKETS_PATH
): string {
  // Get the base name without .bp extension
  const bpBaseName = basename(bpFilePath, ".bp");

  // Construct the ticket file path
  return join(workspaceRoot, ticketsPath, `${bpBaseName}${TICKET_FILE_EXTENSION}`);
}

/**
 * Resolves the ticket file path from a Blueprint file URI.
 *
 * @param bpFileUri - URI of the .bp file (e.g., "file:///path/to/auth.bp")
 * @param workspaceRootUri - URI of the workspace root
 * @param ticketsPath - Relative path from workspace root to tickets directory
 * @returns URI of the corresponding ticket file
 */
export function resolveTicketFileUri(
  bpFileUri: string,
  workspaceRootUri: string,
  ticketsPath: string = DEFAULT_TICKETS_PATH
): string {
  const bpPath = URI.parse(bpFileUri).fsPath;
  const workspaceRoot = URI.parse(workspaceRootUri).fsPath;
  const ticketPath = resolveTicketFilePath(bpPath, workspaceRoot, ticketsPath);
  return URI.file(ticketPath).toString();
}

/**
 * Checks if a ticket file exists for a given Blueprint file.
 *
 * @param bpFilePath - Absolute path to the .bp file
 * @param workspaceRoot - Absolute path to the workspace root directory
 * @param ticketsPath - Relative path from workspace root to tickets directory
 * @returns Promise resolving to true if the ticket file exists
 */
export async function ticketFileExists(
  bpFilePath: string,
  workspaceRoot: string,
  ticketsPath: string = DEFAULT_TICKETS_PATH
): Promise<boolean> {
  const ticketPath = resolveTicketFilePath(bpFilePath, workspaceRoot, ticketsPath);
  try {
    const stats = await stat(ticketPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the Blueprint file path from a ticket file path.
 * This is the reverse operation of resolveTicketFilePath.
 *
 * Note: This returns the expected .bp file name, but the actual location
 * of the .bp file must be found through workspace scanning since .bp files
 * can be in any directory within the workspace.
 *
 * @param ticketFilePath - Absolute path to the .tickets.json file
 * @returns The base name of the corresponding .bp file (e.g., "auth.bp")
 */
export function resolveBpFileBaseName(ticketFilePath: string): string {
  // Get the base name without .tickets.json extension
  const ticketBaseName = basename(ticketFilePath, TICKET_FILE_EXTENSION);
  return `${ticketBaseName}.bp`;
}

/**
 * Extracts the ticket file base name from a Blueprint file path.
 * This is useful for matching ticket files without full path resolution.
 *
 * @param bpFilePath - Path to the .bp file (can be relative or absolute)
 * @returns The expected ticket file name (e.g., "auth.tickets.json")
 */
export function getTicketFileName(bpFilePath: string): string {
  const bpBaseName = basename(bpFilePath, ".bp");
  return `${bpBaseName}${TICKET_FILE_EXTENSION}`;
}

/**
 * Validates that a path appears to be a valid ticket file path.
 *
 * @param filePath - Path to check
 * @returns true if the path ends with .tickets.json
 */
export function isTicketFilePath(filePath: string): boolean {
  return filePath.endsWith(TICKET_FILE_EXTENSION);
}

/**
 * Validates that a path appears to be a valid Blueprint file path.
 *
 * @param filePath - Path to check
 * @returns true if the path ends with .bp
 */
export function isBlueprintFilePath(filePath: string): boolean {
  return filePath.endsWith(".bp");
}
