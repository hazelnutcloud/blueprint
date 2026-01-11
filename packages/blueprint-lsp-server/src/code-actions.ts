import type {
  CodeAction,
  CodeActionParams,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { CodeActionKind, DiagnosticSeverity } from "vscode-languageserver/node";
import type { CrossFileSymbolIndex } from "./symbol-index";
import type { TicketDocumentManager } from "./ticket-documents";
import type { RequirementNode } from "./ast";
import type { Ticket, TicketFile } from "./tickets";
import { resolveTicketFileUri, DEFAULT_TICKETS_PATH, TICKET_SCHEMA_VERSION } from "./tickets";
import { URI } from "vscode-uri";

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
}

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
    const newContent = insertLineContent.replace(
      "[]",
      `[\n${ticketJson}\n  ]`
    );

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
    if (
      diagnostic.code === "no-ticket" &&
      diagnostic.severity === DiagnosticSeverity.Warning
    ) {
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
      const allTickets = context.ticketDocumentManager
        .getAllTickets()
        .map((t) => t.ticket);

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
        edit = createAddTicketEdit(
          ticketFileUri,
          existingTicketFile.content,
          newTicket
        );
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
  }

  return actions;
}
