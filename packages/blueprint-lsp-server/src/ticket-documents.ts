import type { Connection, Diagnostic } from "vscode-languageserver/node";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import {
  parseTicketFileContent,
  type TicketFile,
  type TicketValidationError,
} from "./tickets";

/**
 * Represents the parsed state of a ticket document.
 */
export interface TicketDocumentState {
  /** The URI of the document */
  uri: string;
  /** The document version (increments on each change) */
  version: number;
  /** The parsed ticket file if valid, null otherwise */
  data: TicketFile | null;
  /** Whether the document has validation errors */
  hasErrors: boolean;
  /** Diagnostics for this document */
  diagnostics: Diagnostic[];
}

/**
 * Manages the state of all open .tickets.json documents.
 * Provides schema validation and diagnostics publishing.
 */
export class TicketDocumentManager {
  private states: Map<string, TicketDocumentState> = new Map();
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Called when a ticket document is opened. Validates and stores its state.
   */
  onDocumentOpen(uri: string, version: number, content: string): TicketDocumentState {
    const state = this.validateAndCreateState(uri, version, content);
    this.states.set(uri, state);
    this.publishDiagnostics(state);
    this.connection.console.log(`Ticket document opened: ${uri}`);
    return state;
  }

  /**
   * Called when a ticket document changes. Re-validates and updates the state.
   */
  onDocumentChange(uri: string, version: number, content: string): TicketDocumentState {
    const state = this.validateAndCreateState(uri, version, content);
    this.states.set(uri, state);
    this.publishDiagnostics(state);
    this.connection.console.log(`Ticket document changed: ${uri} (version ${version})`);
    return state;
  }

  /**
   * Called when a ticket document is closed. Cleans up the state.
   */
  onDocumentClose(uri: string): void {
    this.states.delete(uri);
    // Clear diagnostics for closed document
    this.connection.sendDiagnostics({ uri, diagnostics: [] });
    this.connection.console.log(`Ticket document closed: ${uri}`);
  }

  /**
   * Called when a ticket document is saved. Triggers full validation.
   */
  onDocumentSave(uri: string, version: number, content: string): TicketDocumentState {
    const state = this.validateAndCreateState(uri, version, content);
    this.states.set(uri, state);
    this.publishDiagnostics(state);
    this.connection.console.log(`Ticket document saved: ${uri}`);
    return state;
  }

  /**
   * Get the state for a ticket document, or undefined if not tracked.
   */
  getState(uri: string): TicketDocumentState | undefined {
    return this.states.get(uri);
  }

  /**
   * Get the parsed ticket file for a document, or null if not available.
   */
  getData(uri: string): TicketFile | null {
    return this.states.get(uri)?.data ?? null;
  }

  /**
   * Clean up all ticket document states.
   * Call this when the LSP server is shutting down.
   */
  cleanup(): void {
    this.states.clear();
  }

  /**
   * Get all parsed ticket files from all tracked documents.
   * Returns only valid, successfully parsed ticket files.
   * 
   * @returns Array of parsed ticket files with their URIs
   */
  getAllTicketFiles(): Array<{ uri: string; data: TicketFile }> {
    const result: Array<{ uri: string; data: TicketFile }> = [];
    for (const [uri, state] of this.states) {
      if (state.data) {
        result.push({ uri, data: state.data });
      }
    }
    return result;
  }

  /**
   * Get all tickets from all tracked documents.
   * Aggregates tickets from all valid ticket files.
   * 
   * @returns Array of all tickets with their source file URIs
   */
  getAllTickets(): Array<{ ticket: import("./tickets").Ticket; fileUri: string }> {
    const result: Array<{ ticket: import("./tickets").Ticket; fileUri: string }> = [];
    for (const [uri, state] of this.states) {
      if (state.data) {
        for (const ticket of state.data.tickets) {
          result.push({ ticket, fileUri: uri });
        }
      }
    }
    return result;
  }

  /**
   * Validate a ticket document and create its state.
   */
  private validateAndCreateState(
    uri: string,
    version: number,
    content: string
  ): TicketDocumentState {
    const result = parseTicketFileContent(content);
    const diagnostics = this.convertErrorsToDiagnostics(result.errors, content);

    return {
      uri,
      version,
      data: result.data,
      hasErrors: !result.valid,
      diagnostics,
    };
  }

  /**
   * Convert ticket validation errors to LSP diagnostics.
   */
  private convertErrorsToDiagnostics(
    errors: TicketValidationError[],
    content: string
  ): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const error of errors) {
      const { line, character, endLine, endCharacter } = this.findErrorLocation(
        error.path,
        content
      );

      // Determine severity based on error type
      // Version mismatch is a warning, everything else is an error
      const severity = error.message.includes("unknown schema version")
        ? DiagnosticSeverity.Warning
        : DiagnosticSeverity.Error;

      diagnostics.push({
        severity,
        range: {
          start: { line, character },
          end: { line: endLine, character: endCharacter },
        },
        message: error.message,
        source: "blueprint-tickets",
      });
    }

    return diagnostics;
  }

  /**
   * Find the location in the document for a given JSON path.
   * 
   * Attempts to locate the position by parsing the JSON path and
   * searching for the corresponding key in the content.
   */
  private findErrorLocation(
    path: string,
    content: string
  ): { line: number; character: number; endLine: number; endCharacter: number } {
    // Default to the beginning of the document if we can't find the path
    const defaultLocation = {
      line: 0,
      character: 0,
      endLine: 0,
      endCharacter: content.indexOf("\n") > 0 ? content.indexOf("\n") : content.length,
    };

    if (!path) {
      return defaultLocation;
    }

    // Parse the path to extract components
    // Examples: "version", "tickets[0].status", "tickets[2].constraints_satisfied"
    const parts = this.parseJsonPath(path);
    
    if (parts.length === 0) {
      return defaultLocation;
    }

    // Find the location by searching for the key pattern in the content
    return this.findPathInContent(parts, content) || defaultLocation;
  }

  /**
   * Parse a JSON path into parts.
   * Examples:
   *   "version" -> ["version"]
   *   "tickets[0].status" -> ["tickets", 0, "status"]
   *   "tickets[2].constraints_satisfied" -> ["tickets", 2, "constraints_satisfied"]
   */
  private parseJsonPath(path: string): (string | number)[] {
    const parts: (string | number)[] = [];
    const regex = /([^.\[\]]+)|\[(\d+)\]/g;
    let match;

    while ((match = regex.exec(path)) !== null) {
      if (match[1] !== undefined) {
        // String key
        parts.push(match[1]);
      } else if (match[2] !== undefined) {
        // Array index
        parts.push(parseInt(match[2], 10));
      }
    }

    return parts;
  }

  /**
   * Find the location of a JSON path in the content.
   */
  private findPathInContent(
    parts: (string | number)[],
    content: string
  ): { line: number; character: number; endLine: number; endCharacter: number } | null {
    const lines = content.split("\n");
    
    // Track our position in the path
    let currentPart = 0;
    let arrayIndex = 0;
    let inTargetArray = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum]!;
      const part = parts[currentPart];

      if (part === undefined) {
        break;
      }

      if (typeof part === "string") {
        // Looking for a key
        const keyPattern = new RegExp(`"${part}"\\s*:`);
        const match = keyPattern.exec(line);
        
        if (match) {
          // Found the key
          if (currentPart === parts.length - 1) {
            // This is the final part - return this location
            const keyStart = line.indexOf(`"${part}"`);
            return {
              line: lineNum,
              character: keyStart,
              endLine: lineNum,
              endCharacter: keyStart + part.length + 2, // +2 for quotes
            };
          }

          // Check if the next part is an array index
          const nextPart = parts[currentPart + 1];
          if (typeof nextPart === "number") {
            inTargetArray = true;
            arrayIndex = 0;
            currentPart++;
          } else {
            currentPart++;
          }
        }
      } else if (typeof part === "number") {
        // Looking for an array element
        if (inTargetArray) {
          // Count opening braces to find array elements
          if (line.includes("{")) {
            if (arrayIndex === part) {
              // Found the right array element
              if (currentPart === parts.length - 1) {
                // This is the final part - return this location
                const bracePos = line.indexOf("{");
                return {
                  line: lineNum,
                  character: bracePos,
                  endLine: lineNum,
                  endCharacter: line.length,
                };
              }
              inTargetArray = false;
              currentPart++;
            } else {
              arrayIndex++;
            }
          }
        }
      }
    }

    // If we got through most of the path, return the last good location
    if (currentPart > 0) {
      const lastPart = parts[currentPart - 1];
      if (typeof lastPart === "string") {
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum]!;
          const keyPattern = new RegExp(`"${lastPart}"\\s*:`);
          if (keyPattern.test(line)) {
            const keyStart = line.indexOf(`"${lastPart}"`);
            return {
              line: lineNum,
              character: keyStart,
              endLine: lineNum,
              endCharacter: line.length,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Publish diagnostics to the client.
   */
  private publishDiagnostics(state: TicketDocumentState): void {
    this.connection.sendDiagnostics({
      uri: state.uri,
      diagnostics: state.diagnostics,
    });
  }
}
