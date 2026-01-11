import { URI } from "vscode-uri";
import { join, dirname, basename, relative } from "node:path";
import { stat, readFile } from "node:fs/promises";

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
