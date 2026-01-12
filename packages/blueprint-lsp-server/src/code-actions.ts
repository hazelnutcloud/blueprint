import type {
  CodeAction,
  CodeActionParams,
  Diagnostic,
  TextEdit,
  WorkspaceEdit,
  Location,
  Command,
} from "vscode-languageserver/node";
import { CodeActionKind, DiagnosticSeverity } from "vscode-languageserver/node";
import type { CrossFileSymbolIndex, IndexedSymbol } from "./symbol-index";
import type { TicketDocumentManager } from "./ticket-documents";
import type { RequirementNode, SourceLocation } from "./ast";
import type { Ticket, TicketFile } from "./tickets";
import { resolveTicketFileUri, DEFAULT_TICKETS_PATH, TICKET_SCHEMA_VERSION } from "./tickets";
import { URI } from "vscode-uri";
import type { DependencyGraph } from "./dependency-graph";
import type { Tree } from "./parser";

/**
 * Context needed to build code actions.
 */
export interface CodeActionsContext {
  /** Cross-file symbol index for looking up requirements */
  symbolIndex: CrossFileSymbolIndex;
  /** Ticket document manager for accessing ticket data */
  ticketDocumentManager: TicketDocumentManager;
  /** Workspace folder URIs for resolving ticket file paths */
  workspaceFolderUris?: string[];
  /** The dependency graph for dependency-related actions */
  dependencyGraph?: DependencyGraph;
  /** The parse tree for the current document */
  tree?: Tree;
}

// ============================================================================
// String Similarity Functions (for did-you-mean suggestions)
// ============================================================================

/**
 * Compute the Levenshtein distance between two strings.
 * This measures the minimum number of single-character edits (insertions,
 * deletions, or substitutions) required to change one string into the other.
 *
 * @param a First string
 * @param b Second string
 * @returns The edit distance between the two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  // Early termination for empty strings
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Create a 2D array for dynamic programming
  // We only need two rows at a time to save memory
  let prevRow = new Array<number>(bLen + 1);
  let currRow = new Array<number>(bLen + 1);

  // Initialize the first row
  for (let j = 0; j <= bLen; j++) {
    prevRow[j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= aLen; i++) {
    currRow[0] = i;

    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j]! + 1, // deletion
        currRow[j - 1]! + 1, // insertion
        prevRow[j - 1]! + cost // substitution
      );
    }

    // Swap rows
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[bLen]!;
}

/**
 * Calculate a normalized similarity score between two strings.
 * Returns a value between 0 and 1, where 1 means identical strings.
 *
 * @param a First string
 * @param b Second string
 * @returns Similarity score between 0 and 1
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);
  return 1 - distance / maxLen;
}

/**
 * Information about a similar symbol suggestion.
 */
export interface SimilarSymbol {
  /** The symbol that is similar to the query */
  symbol: IndexedSymbol;
  /** Similarity score between 0 and 1 */
  similarity: number;
}

/**
 * Find symbols that are similar to the given path.
 * Uses Levenshtein distance to find potential typo corrections.
 *
 * @param query The unresolved reference path to find suggestions for
 * @param symbolIndex The cross-file symbol index
 * @param maxSuggestions Maximum number of suggestions to return (default: 3)
 * @param minSimilarity Minimum similarity threshold (default: 0.5)
 * @returns Array of similar symbols sorted by similarity (highest first)
 */
export function findSimilarSymbols(
  query: string,
  symbolIndex: CrossFileSymbolIndex,
  maxSuggestions: number = 3,
  minSimilarity: number = 0.5
): SimilarSymbol[] {
  const results: SimilarSymbol[] = [];
  const queryLower = query.toLowerCase();
  const queryParts = queryLower.split(".");

  // Get all symbols from the index
  const allSymbols: IndexedSymbol[] = [
    ...symbolIndex.getSymbolsByKind("module"),
    ...symbolIndex.getSymbolsByKind("feature"),
    ...symbolIndex.getSymbolsByKind("requirement"),
  ];

  for (const symbol of allSymbols) {
    const symbolPath = symbol.path.toLowerCase();
    const symbolParts = symbolPath.split(".");

    // Calculate similarity in multiple ways and take the best score
    let similarity = 0;

    // 1. Full path similarity
    similarity = Math.max(similarity, stringSimilarity(queryLower, symbolPath));

    // 2. If query has same number of parts, compare each part
    if (queryParts.length === symbolParts.length) {
      let partSimilaritySum = 0;
      for (let i = 0; i < queryParts.length; i++) {
        partSimilaritySum += stringSimilarity(queryParts[i]!, symbolParts[i]!);
      }
      const avgPartSimilarity = partSimilaritySum / queryParts.length;
      similarity = Math.max(similarity, avgPartSimilarity);
    }

    // 3. If the query is shorter, check if any suffix of symbol matches
    if (queryParts.length < symbolParts.length) {
      // Check if query matches the end of the symbol path
      const suffix = symbolParts.slice(-queryParts.length).join(".");
      similarity = Math.max(similarity, stringSimilarity(queryLower, suffix));
    }

    // 4. Check if just the last part (identifier) is similar
    const queryLastPart = queryParts[queryParts.length - 1]!;
    const symbolLastPart = symbolParts[symbolParts.length - 1]!;
    const lastPartSimilarity = stringSimilarity(queryLastPart, symbolLastPart);
    // Weight last-part similarity less since the full path matters
    similarity = Math.max(similarity, lastPartSimilarity * 0.8);

    if (similarity >= minSimilarity) {
      results.push({ symbol, similarity });
    }
  }

  // Sort by similarity (highest first) and limit results
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, maxSuggestions);
}

/**
 * Extract the unresolved reference path from an "unresolved-reference" diagnostic message.
 * The message format is: "Reference to non-existent element: 'path.to.element'"
 *
 * @param message The diagnostic message
 * @returns The reference path, or null if not found
 */
export function extractUnresolvedReferenceFromMessage(message: string): string | null {
  const match = message.match(/Reference to non-existent element: '([^']+)'/);
  return match ? match[1]! : null;
}

// ============================================================================
// Message Extraction Functions
// ============================================================================

/**
 * Extracts the requirement path from a "no-ticket" diagnostic message.
 * The message format is: "Requirement 'path.to.requirement' has no associated ticket"
 *
 * @param message The diagnostic message
 * @returns The requirement path, or null if not found
 */
export function extractRequirementPathFromMessage(message: string): string | null {
  const match = message.match(/Requirement '([^']+)' has no associated ticket/);
  return match ? match[1]! : null;
}

/**
 * Information extracted from an orphaned-ticket diagnostic message.
 */
export interface OrphanedTicketInfo {
  /** The ticket ID (e.g., "TKT-001") */
  ticketId: string;
  /** The requirement ref path that no longer exists */
  requirementRef: string;
}

/**
 * Extracts ticket information from an "orphaned-ticket" diagnostic message.
 * The message format is: "Ticket 'TKT-XXX' references removed requirement 'path.to.requirement'"
 *
 * @param message The diagnostic message
 * @returns The ticket info, or null if not found
 */
export function extractOrphanedTicketInfo(message: string): OrphanedTicketInfo | null {
  const match = message.match(/Ticket '([^']+)' references removed requirement '([^']+)'/);
  if (!match) return null;
  return {
    ticketId: match[1]!,
    requirementRef: match[2]!,
  };
}

/**
 * Generates a new ticket ID based on existing tickets.
 * Format: TKT-XXX where XXX is a zero-padded number.
 *
 * @param existingTickets Array of existing tickets
 * @returns A new unique ticket ID
 */
export function generateTicketId(existingTickets: Ticket[]): string {
  // Find the highest existing ticket number
  let maxNumber = 0;

  for (const ticket of existingTickets) {
    const match = ticket.id.match(/^TKT-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxNumber) {
        maxNumber = num;
      }
    }
  }

  // Generate the next ID
  const nextNumber = maxNumber + 1;
  return `TKT-${String(nextNumber).padStart(3, "0")}`;
}

/**
 * Creates a new ticket object for a requirement.
 *
 * @param ticketId The unique ticket ID
 * @param requirementPath The full path to the requirement
 * @param description Optional description for the ticket
 * @returns A new Ticket object
 */
export function createTicket(
  ticketId: string,
  requirementPath: string,
  description?: string
): Ticket {
  return {
    id: ticketId,
    ref: requirementPath,
    description: description || `Implement ${requirementPath}`,
    status: "pending",
    constraints_satisfied: [],
  };
}

/**
 * Finds the workspace folder that contains a given file URI.
 *
 * @param fileUri The file URI to check
 * @param workspaceFolderUris Array of workspace folder URIs
 * @returns The matching workspace folder URI, or undefined if not found
 */
export function findWorkspaceFolder(
  fileUri: string,
  workspaceFolderUris: string[]
): string | undefined {
  const filePath = URI.parse(fileUri).fsPath;

  for (const folderUri of workspaceFolderUris) {
    const folderPath = URI.parse(folderUri).fsPath;
    if (filePath.startsWith(folderPath)) {
      return folderUri;
    }
  }

  return undefined;
}

/**
 * Creates a WorkspaceEdit to add a ticket to an existing ticket file.
 *
 * @param ticketFileUri The URI of the ticket file
 * @param ticketFileContent The current content of the ticket file
 * @param newTicket The ticket to add
 * @returns A WorkspaceEdit that adds the ticket
 */
export function createAddTicketEdit(
  ticketFileUri: string,
  ticketFileContent: string,
  newTicket: Ticket
): WorkspaceEdit {
  // Parse the existing content to find where to insert
  const lines = ticketFileContent.split("\n");

  // Find the closing bracket of the tickets array
  // We look for the pattern: ]  (with optional whitespace before it)
  // that is inside the "tickets" array
  let insertLine = -1;
  let insertIndent = "    "; // Default 4-space indent for ticket objects
  let needsComma = false;

  // Track if we're inside the tickets array
  let inTicketsArray = false;
  let bracketDepth = 0;
  let lastTicketEndLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.includes('"tickets"') && line.includes("[")) {
      inTicketsArray = true;
      bracketDepth = 1;
      // Check if tickets array is empty: "tickets": []
      if (line.includes("[]")) {
        insertLine = i;
        // We'll need to expand the empty array
        break;
      }
      continue;
    }

    if (inTicketsArray) {
      // Count brackets to track depth
      for (const char of line) {
        if (char === "[") bracketDepth++;
        if (char === "]") {
          bracketDepth--;
          if (bracketDepth === 0) {
            // Found the closing bracket of tickets array
            insertLine = i;
            inTicketsArray = false;
            break;
          }
        }
      }

      // Track the last ticket object end (looking for closing brace)
      if (line.trim().startsWith("}")) {
        lastTicketEndLine = i;
        // Get the indent from this line
        const match = line.match(/^(\s*)/);
        if (match) {
          insertIndent = match[1]!;
        }
      }
    }
  }

  if (insertLine === -1) {
    // Couldn't find the tickets array, return empty edit
    return { changes: {} };
  }

  // Check if the line contains an empty array
  const insertLineContent = lines[insertLine]!;
  if (insertLineContent.includes("[]")) {
    // Replace empty array with array containing new ticket
    const ticketJson = formatTicketJson(newTicket, "    ");
    const newContent = insertLineContent.replace("[]", `[\n${ticketJson}\n  ]`);

    const edit: TextEdit = {
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: insertLineContent.length },
      },
      newText: newContent,
    };

    return {
      changes: {
        [ticketFileUri]: [edit],
      },
    };
  }

  // Check if we need a comma after the last ticket
  if (lastTicketEndLine >= 0) {
    const lastTicketLine = lines[lastTicketEndLine]!;
    needsComma = !lastTicketLine.trim().endsWith(",");
  }

  // Build the text to insert
  const ticketJson = formatTicketJson(newTicket, insertIndent);
  let insertText = "";

  if (needsComma && lastTicketEndLine >= 0) {
    // Add comma to the last ticket, then add new ticket
    const edits: TextEdit[] = [];

    // Add comma to last ticket line
    const lastLine = lines[lastTicketEndLine]!;
    edits.push({
      range: {
        start: { line: lastTicketEndLine, character: lastLine.length },
        end: { line: lastTicketEndLine, character: lastLine.length },
      },
      newText: ",",
    });

    // Add new ticket before the closing bracket
    insertText = `${ticketJson}\n`;
    const closingLine = lines[insertLine]!;
    const closingIndent = closingLine.match(/^(\s*)/)?.[1] || "  ";

    edits.push({
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: insertText,
    });

    return {
      changes: {
        [ticketFileUri]: edits,
      },
    };
  }

  // Simple case: just add the ticket before closing bracket
  insertText = `${ticketJson}\n`;
  const edit: TextEdit = {
    range: {
      start: { line: insertLine, character: 0 },
      end: { line: insertLine, character: 0 },
    },
    newText: insertText,
  };

  return {
    changes: {
      [ticketFileUri]: [edit],
    },
  };
}

/**
 * Creates a WorkspaceEdit to remove a ticket from a ticket file.
 *
 * @param ticketFileUri The URI of the ticket file
 * @param ticketFileContent The current content of the ticket file
 * @param ticketId The ID of the ticket to remove
 * @returns A WorkspaceEdit that removes the ticket, or null if ticket not found
 */
export function createRemoveTicketEdit(
  ticketFileUri: string,
  ticketFileContent: string,
  ticketId: string
): WorkspaceEdit | null {
  const lines = ticketFileContent.split("\n");

  // Find the ticket object in the JSON content
  // We need to find the ticket with the matching ID and remove it along with any trailing comma

  let ticketStartLine = -1;
  let ticketEndLine = -1;
  let braceDepth = 0;
  let inTicketsArray = false;
  let foundTicketId = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Track when we enter the tickets array
    if (line.includes('"tickets"') && line.includes("[")) {
      inTicketsArray = true;
      continue;
    }

    if (!inTicketsArray) continue;

    // Look for the start of a ticket object
    if (ticketStartLine === -1 && line.includes("{")) {
      ticketStartLine = i;
      braceDepth = 1;
      foundTicketId = false;
      continue;
    }

    if (ticketStartLine !== -1) {
      // Check if this line contains the ticket ID we're looking for
      const idMatch = line.match(/"id"\s*:\s*"([^"]+)"/);
      if (idMatch && idMatch[1] === ticketId) {
        foundTicketId = true;
      }

      // Track brace depth
      for (const char of line) {
        if (char === "{") braceDepth++;
        if (char === "}") braceDepth--;
      }

      // Found the end of a ticket object
      if (braceDepth === 0) {
        ticketEndLine = i;

        if (foundTicketId) {
          // Found the ticket to remove!
          break;
        }

        // Reset for next ticket
        ticketStartLine = -1;
        ticketEndLine = -1;
        foundTicketId = false;
      }
    }

    // Check if we've exited the tickets array
    if (line.includes("]") && !line.includes("[")) {
      // If we're at the closing bracket and haven't found the ticket yet, it's not here
      if (ticketStartLine === -1) {
        break;
      }
    }
  }

  if (ticketStartLine === -1 || ticketEndLine === -1 || !foundTicketId) {
    return null;
  }

  // Determine what to remove:
  // - The ticket object itself
  // - Any trailing comma on the previous ticket if this is not the first ticket
  // - Any trailing comma on this ticket if it exists

  const removeStartLine = ticketStartLine;
  const removeEndLine = ticketEndLine;

  // Check if there's a trailing comma after this ticket
  const endLine = lines[ticketEndLine]!;
  const hasTrailingComma = endLine.trimEnd().endsWith(",");

  // Check if there's a ticket before this one (by looking for a comma on the previous non-empty line)
  let prevTicketLine = -1;
  for (let i = ticketStartLine - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) {
      if (line.endsWith("},") || line.endsWith("}")) {
        prevTicketLine = i;
      }
      break;
    }
  }

  // Check if there's a ticket after this one
  let nextTicketExists = false;
  for (let i = ticketEndLine + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (line.startsWith("{")) {
      nextTicketExists = true;
      break;
    }
    if (line === "]") break;
    break;
  }

  // Build the edit
  const edits: TextEdit[] = [];

  if (prevTicketLine !== -1 && !nextTicketExists) {
    // This is the last ticket and there are tickets before it
    // We need to remove the comma from the previous ticket
    const prevLine = lines[prevTicketLine]!;
    if (prevLine.trimEnd().endsWith(",")) {
      edits.push({
        range: {
          start: { line: prevTicketLine, character: prevLine.length - 1 },
          end: { line: prevTicketLine, character: prevLine.length },
        },
        newText: "",
      });
    }
  }

  // Remove the ticket lines (including trailing newline)
  edits.push({
    range: {
      start: { line: removeStartLine, character: 0 },
      end: { line: removeEndLine + 1, character: 0 },
    },
    newText: "",
  });

  return {
    changes: {
      [ticketFileUri]: edits,
    },
  };
}

/**
 * Creates a WorkspaceEdit to create a new ticket file with a single ticket.
 *
 * @param ticketFileUri The URI for the new ticket file
 * @param sourceFilePath The relative path to the source .bp file
 * @param newTicket The ticket to add
 * @returns A WorkspaceEdit that creates the file
 */
export function createNewTicketFileEdit(
  ticketFileUri: string,
  sourceFilePath: string,
  newTicket: Ticket
): WorkspaceEdit {
  const ticketFile: TicketFile = {
    version: TICKET_SCHEMA_VERSION,
    source: sourceFilePath,
    tickets: [newTicket],
  };

  const content = JSON.stringify(ticketFile, null, 2) + "\n";

  return {
    changes: {
      [ticketFileUri]: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: content,
        },
      ],
    },
    // Note: documentChanges with createFile would be better but requires
    // checking client capabilities. For now, we use a simple text edit
    // which works if the client supports creating files via edits.
  };
}

/**
 * Formats a ticket object as a JSON string with proper indentation.
 *
 * @param ticket The ticket to format
 * @param baseIndent The base indentation for the ticket object
 * @returns Formatted JSON string
 */
function formatTicketJson(ticket: Ticket, baseIndent: string): string {
  const innerIndent = baseIndent + "  ";
  const lines = [
    `${baseIndent}{`,
    `${innerIndent}"id": ${JSON.stringify(ticket.id)},`,
    `${innerIndent}"ref": ${JSON.stringify(ticket.ref)},`,
    `${innerIndent}"description": ${JSON.stringify(ticket.description)},`,
    `${innerIndent}"status": ${JSON.stringify(ticket.status)},`,
    `${innerIndent}"constraints_satisfied": []`,
    `${baseIndent}}`,
  ];
  return lines.join("\n");
}

/**
 * Builds code actions for a given document and range.
 *
 * @param params The code action request parameters
 * @param context The context needed to build code actions
 * @returns Array of code actions
 */
export function buildCodeActions(
  params: CodeActionParams,
  context: CodeActionsContext
): CodeAction[] {
  const actions: CodeAction[] = [];

  // Process each diagnostic in the context
  for (const diagnostic of params.context.diagnostics) {
    // Handle "no-ticket" diagnostics
    if (diagnostic.code === "no-ticket" && diagnostic.severity === DiagnosticSeverity.Warning) {
      const requirementPath = extractRequirementPathFromMessage(diagnostic.message);
      if (!requirementPath) {
        continue;
      }

      // Find the requirement symbol to get more information
      const symbols = context.symbolIndex.getSymbol(requirementPath);
      const reqSymbol = symbols?.find((s) => s.kind === "requirement");

      // Get the requirement description for the ticket
      let description: string | undefined;
      if (reqSymbol) {
        const reqNode = reqSymbol.node as RequirementNode;
        // Use first line of description or requirement name
        const firstLine = reqNode.description?.split("\n")[0]?.trim();
        if (firstLine && firstLine.length > 0) {
          description = firstLine;
        }
      }

      // Find the workspace folder for this file
      const workspaceFolder = context.workspaceFolderUris
        ? findWorkspaceFolder(params.textDocument.uri, context.workspaceFolderUris)
        : undefined;

      if (!workspaceFolder) {
        // Can't determine ticket file location without workspace folder
        continue;
      }

      // Get all existing tickets to generate a unique ID
      const allTickets = context.ticketDocumentManager.getAllTickets().map((t) => t.ticket);

      // Generate the new ticket
      const ticketId = generateTicketId(allTickets);
      const newTicket = createTicket(ticketId, requirementPath, description);

      // Determine the ticket file URI
      const ticketFileUri = resolveTicketFileUri(
        params.textDocument.uri,
        workspaceFolder,
        DEFAULT_TICKETS_PATH
      );

      // Check if the ticket file already exists
      const existingTicketFile = context.ticketDocumentManager
        .getAllTicketFilesWithContent()
        .find((tf) => tf.uri === ticketFileUri);

      let edit: WorkspaceEdit;
      let title: string;

      if (existingTicketFile) {
        // Add ticket to existing file
        edit = createAddTicketEdit(ticketFileUri, existingTicketFile.content, newTicket);
        title = `Create ticket ${ticketId} for '${requirementPath}'`;
      } else {
        // Create new ticket file
        // Compute the relative source path
        const bpFilePath = URI.parse(params.textDocument.uri).fsPath;
        const workspacePath = URI.parse(workspaceFolder).fsPath;
        const relativePath = bpFilePath.startsWith(workspacePath)
          ? bpFilePath.slice(workspacePath.length + 1) // +1 for the separator
          : bpFilePath;

        edit = createNewTicketFileEdit(ticketFileUri, relativePath, newTicket);
        title = `Create ticket ${ticketId} for '${requirementPath}' (new file)`;
      }

      const action: CodeAction = {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit,
      };

      actions.push(action);
    }

    // Handle "orphaned-ticket" diagnostics
    if (
      diagnostic.code === "orphaned-ticket" &&
      diagnostic.severity === DiagnosticSeverity.Warning
    ) {
      const orphanedInfo = extractOrphanedTicketInfo(diagnostic.message);
      if (!orphanedInfo) {
        continue;
      }

      // Find the ticket file that contains this orphaned ticket
      // The diagnostic is reported on the ticket file, so params.textDocument.uri is the ticket file
      const ticketFileUri = params.textDocument.uri;

      const ticketFile = context.ticketDocumentManager
        .getAllTicketFilesWithContent()
        .find((tf) => tf.uri === ticketFileUri);

      if (!ticketFile) {
        continue;
      }

      // Create an edit to remove the orphaned ticket
      const edit = createRemoveTicketEdit(ticketFileUri, ticketFile.content, orphanedInfo.ticketId);

      if (!edit) {
        continue;
      }

      const action: CodeAction = {
        title: `Remove orphaned ticket '${orphanedInfo.ticketId}'`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit,
      };

      actions.push(action);
    }

    // Handle "unresolved-reference" diagnostics (did-you-mean suggestions)
    if (
      diagnostic.code === "unresolved-reference" &&
      diagnostic.severity === DiagnosticSeverity.Error
    ) {
      const unresolvedPath = extractUnresolvedReferenceFromMessage(diagnostic.message);
      if (!unresolvedPath) {
        continue;
      }

      // Find similar symbols that might be what the user meant
      const suggestions = findSimilarSymbols(unresolvedPath, context.symbolIndex);

      // Create a code action for each suggestion
      for (let i = 0; i < suggestions.length; i++) {
        const suggestion = suggestions[i]!;
        const suggestedPath = suggestion.symbol.path;

        // Create an edit that replaces the unresolved reference with the suggested one
        const edit: WorkspaceEdit = {
          changes: {
            [params.textDocument.uri]: [
              {
                range: diagnostic.range,
                newText: suggestedPath,
              },
            ],
          },
        };

        const action: CodeAction = {
          title: `Did you mean '${suggestedPath}'?`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          // First suggestion is preferred
          isPreferred: i === 0,
          edit,
        };

        actions.push(action);
      }
    }
  }

  // Add source code actions for showing dependencies/dependents
  // These are available on modules, features, and requirements
  const dependencyActions = buildDependencyCodeActions(params, context);
  actions.push(...dependencyActions);

  return actions;
}

// ============================================================================
// Dependency Code Actions (Show all dependencies / Show all dependents)
// ============================================================================

/**
 * Information about a symbol at a position.
 */
export interface SymbolAtPosition {
  /** The symbol path */
  path: string;
  /** The kind of symbol */
  kind: "module" | "feature" | "requirement";
}

/**
 * Find the symbol at a given position in the parse tree.
 * Returns the module, feature, or requirement that contains the position.
 */
export function findSymbolAtPosition(
  tree: Tree,
  position: { line: number; character: number },
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): SymbolAtPosition | null {
  const root = tree.rootNode;

  // Find the deepest node at the position
  const node = findDeepestNodeAt(root, position.line, position.character);
  if (!node) {
    return null;
  }

  // Walk up to find a module, feature, or requirement block
  let current = node;
  while (current) {
    if (current.type === "requirement_block") {
      return buildSymbolPath(current, "requirement", symbolIndex, fileUri);
    }
    if (current.type === "feature_block") {
      return buildSymbolPath(current, "feature", symbolIndex, fileUri);
    }
    if (current.type === "module_block") {
      return buildSymbolPath(current, "module", symbolIndex, fileUri);
    }
    current = current.parent;
  }

  return null;
}

/**
 * Find the deepest node containing a position.
 */
function findDeepestNodeAt(
  node: {
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: any[];
    type: string;
  },
  line: number,
  column: number
): any | null {
  const start = node.startPosition;
  const end = node.endPosition;

  // Check if position is within this node
  if (line < start.row || (line === start.row && column < start.column)) {
    return null;
  }
  if (line > end.row || (line === end.row && column > end.column)) {
    return null;
  }

  // Try to find a more specific child
  for (const child of node.children) {
    const found = findDeepestNodeAt(child, line, column);
    if (found) {
      return found;
    }
  }

  return node;
}

/**
 * Build the symbol path for a block node.
 */
function buildSymbolPath(
  blockNode: any,
  kind: "module" | "feature" | "requirement",
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): SymbolAtPosition | null {
  const nameNode = blockNode.childForFieldName?.("name");
  if (!nameNode) return null;

  let path = nameNode.text;

  // Walk up to find parent scope and build full path
  let parent = blockNode.parent;
  while (parent) {
    if (parent.type === "feature_block" && kind === "requirement") {
      const featureNameNode = parent.childForFieldName?.("name");
      if (featureNameNode) {
        path = `${featureNameNode.text}.${path}`;
      }
    }
    if (parent.type === "module_block") {
      const moduleNameNode = parent.childForFieldName?.("name");
      if (moduleNameNode) {
        path = `${moduleNameNode.text}.${path}`;
      }
      break;
    }
    parent = parent.parent;
  }

  return { path, kind };
}

/**
 * Convert a SourceLocation to an LSP Location.
 */
function sourceLocationToLocation(location: SourceLocation, fileUri: string): Location {
  return {
    uri: fileUri,
    range: {
      start: { line: location.startLine, character: location.startColumn },
      end: { line: location.endLine, character: location.endColumn },
    },
  };
}

/**
 * Build code actions for showing dependencies and dependents.
 */
function buildDependencyCodeActions(
  params: CodeActionParams,
  context: CodeActionsContext
): CodeAction[] {
  const actions: CodeAction[] = [];

  // Need the dependency graph and parse tree to build dependency actions
  if (!context.dependencyGraph || !context.tree) {
    return actions;
  }

  // Find the symbol at the cursor position
  const symbol = findSymbolAtPosition(
    context.tree,
    params.range.start,
    context.symbolIndex,
    params.textDocument.uri
  );

  if (!symbol) {
    return actions;
  }

  // Get dependencies (what this symbol depends on)
  const dependencies = context.dependencyGraph.getDependencies(symbol.path);

  // Get dependents (what depends on this symbol)
  const dependents = context.dependencyGraph.getDependents(symbol.path);

  // Create "Show all dependencies" action if there are dependencies
  if (dependencies.length > 0) {
    const locations = getDependencyLocations(dependencies, context.symbolIndex);

    if (locations.length > 0) {
      const action: CodeAction = {
        title: `Show ${dependencies.length} dependenc${dependencies.length === 1 ? "y" : "ies"} of '${symbol.path}'`,
        kind: CodeActionKind.Source,
        command: {
          title: "Show Dependencies",
          command: "blueprint.showLocations",
          arguments: [locations, `Dependencies of ${symbol.path}`],
        },
      };
      actions.push(action);
    }
  }

  // Create "Show all dependents" action if there are dependents
  if (dependents.length > 0) {
    const locations = getDependencyLocations(dependents, context.symbolIndex);

    if (locations.length > 0) {
      const action: CodeAction = {
        title: `Show ${dependents.length} dependent${dependents.length === 1 ? "" : "s"} of '${symbol.path}'`,
        kind: CodeActionKind.Source,
        command: {
          title: "Show Dependents",
          command: "blueprint.showLocations",
          arguments: [locations, `Dependents of ${symbol.path}`],
        },
      };
      actions.push(action);
    }
  }

  return actions;
}

/**
 * Get the locations of dependency symbols.
 */
function getDependencyLocations(paths: string[], symbolIndex: CrossFileSymbolIndex): Location[] {
  const locations: Location[] = [];

  for (const path of paths) {
    const symbols = symbolIndex.getSymbol(path);
    if (symbols && symbols.length > 0) {
      const symbol = symbols[0]!;
      locations.push(sourceLocationToLocation(symbol.node.location, symbol.fileUri));
    }
  }

  return locations;
}
