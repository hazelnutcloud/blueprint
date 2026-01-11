import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  WatchKind,
} from "vscode-languageserver/node";
import type {
  InitializeParams,
  InitializeResult,
  TextDocumentSyncOptions,
  SemanticTokensParams,
  HoverParams,
  DefinitionParams,
} from "vscode-languageserver/node";
import { semanticTokensLegend, buildSemanticTokens } from "./semantic-tokens";
import { findHoverTarget, buildHover, type HoverContext } from "./hover";
import { findDefinitionTarget, buildDefinition, type DefinitionContext } from "./definition";
import { buildRequirementTicketMapFromSymbols } from "./requirement-ticket-map";
import { DependencyGraph } from "./dependency-graph";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initializeParser, cleanupParser, parseDocument } from "./parser";
import { DocumentManager } from "./documents";
import { TicketDocumentManager } from "./ticket-documents";
import { WorkspaceManager } from "./workspace";
import { CrossFileSymbolIndex } from "./symbol-index";
import { transformToAST } from "./ast";
import { isTicketFilePath, isBlueprintFilePath } from "./tickets";
import { computeWorkspaceDiagnostics, computeOrphanedTicketDiagnostics, computeConstraintMismatchDiagnostics, mergeDiagnosticResults } from "./workspace-diagnostics";
import { readFile } from "node:fs/promises";
import { URI } from "vscode-uri";

// Create a connection for the server using Node's IPC as transport.
// Also includes all proposed protocol features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

// Create the document manager for tracking parsed state of .bp files
const documentManager = new DocumentManager(connection);

// Create the ticket document manager for tracking parsed state of .tickets.json files
const ticketDocumentManager = new TicketDocumentManager(connection);

// Create the workspace manager for scanning workspace folders
const workspaceManager = new WorkspaceManager(connection);

// Create the cross-file symbol index for workspace-wide symbol resolution
const symbolIndex = new CrossFileSymbolIndex();

// Track whether the client supports dynamic registration for configuration changes
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDidChangeWatchedFilesCapability = false;

// Track parser initialization state
let parserInitialized = false;

// Track files that have workspace-level diagnostics
// Used to clear diagnostics when they're no longer relevant
let filesWithWorkspaceDiagnostics = new Set<string>();

// Debounce timer for workspace diagnostics publishing
let workspaceDiagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Debounce delay in milliseconds for workspace diagnostics
// This allows batching rapid changes together for better performance
const WORKSPACE_DIAGNOSTICS_DEBOUNCE_MS = 150;

/**
 * Schedule workspace diagnostics to be published after a debounce delay.
 * If called multiple times within the delay period, only the last call will execute.
 * This prevents excessive recomputation during rapid typing.
 */
function scheduleWorkspaceDiagnostics(): void {
  // Clear any existing timer
  if (workspaceDiagnosticsDebounceTimer !== null) {
    clearTimeout(workspaceDiagnosticsDebounceTimer);
  }
  
  // Schedule new diagnostic computation
  workspaceDiagnosticsDebounceTimer = setTimeout(() => {
    workspaceDiagnosticsDebounceTimer = null;
    publishWorkspaceDiagnosticsImmediate();
  }, WORKSPACE_DIAGNOSTICS_DEBOUNCE_MS);
}

/**
 * Publish workspace-level diagnostics immediately (internal implementation).
 * For debounced publishing, use scheduleWorkspaceDiagnostics() instead.
 * 
 * This function computes diagnostics across all indexed files and publishes them.
 * It also clears diagnostics from files that no longer have issues.
 */
function publishWorkspaceDiagnosticsImmediate(): void {
  // Get all tickets from the ticket document manager
  const allTickets = ticketDocumentManager.getAllTickets().map(t => t.ticket);
  const result = computeWorkspaceDiagnostics(symbolIndex, allTickets);
  
  // Compute orphaned ticket diagnostics (tickets referencing removed requirements)
  const ticketFiles = ticketDocumentManager.getAllTicketFiles();
  const orphanedResult = computeOrphanedTicketDiagnostics(symbolIndex, ticketFiles);
  
  // Compute constraint mismatch diagnostics (tickets claiming undefined constraints)
  const constraintMismatchResult = computeConstraintMismatchDiagnostics(symbolIndex, ticketFiles);
  
  // Merge ticket file diagnostics (orphaned + constraint mismatch)
  const ticketFileDiagnostics = mergeDiagnosticResults(orphanedResult, constraintMismatchResult);
  
  // Clear diagnostics from files that no longer have workspace-level issues
  for (const fileUri of filesWithWorkspaceDiagnostics) {
    if (!result.byFile.has(fileUri) && !ticketFileDiagnostics.byFile.has(fileUri)) {
      // This file no longer has workspace diagnostics, but we need to preserve
      // its document-level diagnostics. We send an empty array for workspace diagnostics
      // which will be merged with document diagnostics by the document manager.
      // 
      // Actually, we need to re-publish the document's own diagnostics.
      // For now, we'll trigger a re-validation by getting the document state.
      const state = documentManager.getState(fileUri);
      if (state) {
        // Re-publish document diagnostics (this will clear workspace diagnostics)
        connection.sendDiagnostics({
          uri: fileUri,
          diagnostics: state.diagnostics,
        });
      } else {
        // Check if it's a ticket file
        const ticketState = ticketDocumentManager.getState(fileUri);
        if (ticketState) {
          connection.sendDiagnostics({
            uri: fileUri,
            diagnostics: ticketState.diagnostics,
          });
        } else {
          // Document not open, just clear all diagnostics
          connection.sendDiagnostics({
            uri: fileUri,
            diagnostics: [],
          });
        }
      }
    }
  }
  
  // Publish new workspace diagnostics for .bp files, merging with document diagnostics
  for (const [fileUri, workspaceDiagnostics] of result.byFile) {
    const state = documentManager.getState(fileUri);
    const documentDiagnostics = state?.diagnostics ?? [];
    
    // Merge document and workspace diagnostics
    const allDiagnostics = [...documentDiagnostics, ...workspaceDiagnostics];
    
    connection.sendDiagnostics({
      uri: fileUri,
      diagnostics: allDiagnostics,
    });
  }
  
  // Publish ticket file diagnostics (orphaned + constraint mismatch), merging with ticket document diagnostics
  for (const [fileUri, workspaceDiagnostics] of ticketFileDiagnostics.byFile) {
    const ticketState = ticketDocumentManager.getState(fileUri);
    const ticketDocumentDiagnostics = ticketState?.diagnostics ?? [];
    
    // Merge ticket document diagnostics with workspace diagnostics
    const allDiagnostics = [...ticketDocumentDiagnostics, ...workspaceDiagnostics];
    
    connection.sendDiagnostics({
      uri: fileUri,
      diagnostics: allDiagnostics,
    });
  }
  
  // Update the set of files with workspace diagnostics
  filesWithWorkspaceDiagnostics = new Set([
    ...result.filesWithDiagnostics,
    ...ticketFileDiagnostics.filesWithDiagnostics,
  ]);
  
  const totalFiles = result.filesWithDiagnostics.length + ticketFileDiagnostics.filesWithDiagnostics.length;
  if (totalFiles > 0) {
    connection.console.log(
      `Published workspace diagnostics for ${totalFiles} files`
    );
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;

  // Check client capabilities
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDidChangeWatchedFilesCapability = !!(
    capabilities.workspace &&
    !!capabilities.workspace.didChangeWatchedFiles?.dynamicRegistration
  );

  // Store initial workspace folders
  if (hasWorkspaceFolderCapability && params.workspaceFolders) {
    workspaceManager.setWorkspaceFolders(params.workspaceFolders);
  }

  // Configure text document sync with save notifications
  const textDocumentSync: TextDocumentSyncOptions = {
    openClose: true,
    change: TextDocumentSyncKind.Full,
    save: {
      includeText: true,
    },
  };

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync,
      hoverProvider: true,
      definitionProvider: true,
      semanticTokensProvider: {
        legend: semanticTokensLegend,
        full: true,
        range: false,
      },
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  connection.console.log("Blueprint LSP server initialized");
  return result;
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    // Register for configuration changes
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(async (event) => {
      connection.console.log("Workspace folder change event received.");
      await workspaceManager.handleWorkspaceFoldersChange(event);
    });
  }

  // Register file watchers for .bp and .tickets.json files
  if (hasDidChangeWatchedFilesCapability) {
    connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        {
          // Watch all .bp files in the workspace
          globPattern: "**/*.bp",
          kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
        },
        {
          // Watch all .tickets.json files in the .blueprint/tickets directory
          globPattern: "**/.blueprint/tickets/*.tickets.json",
          kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
        },
      ],
    });
    connection.console.log("Registered file watchers for .bp and .tickets.json files");
  }

  // Initialize the tree-sitter parser
  try {
    await initializeParser();
    parserInitialized = true;
    connection.console.log("Tree-sitter parser initialized successfully");
  } catch (error) {
    connection.console.error(`Failed to initialize parser: ${error}`);
    // Notify the client about degraded functionality
    connection.window.showErrorMessage(
      "Blueprint LSP: Parser initialization failed. Syntax highlighting and diagnostics will be unavailable. Please check that the tree-sitter-blueprint WASM file is properly installed."
    );
  }

  // Register callback to index files when discovered
  workspaceManager.onFilesChanged(async (files) => {
    if (!parserInitialized) {
      return;
    }
    
    // Index all discovered files
    for (const file of files) {
      await indexFile(file.uri, file.path);
    }
    
    connection.console.log(
      `Symbol index updated: ${symbolIndex.getSymbolCount()} symbols from ${symbolIndex.getFileCount()} files`
    );
    
    // Publish workspace-level diagnostics after indexing
    scheduleWorkspaceDiagnostics();
  });

  // Scan workspace folders for .bp files after parser is initialized
  if (hasWorkspaceFolderCapability) {
    workspaceManager.scanAllFolders().catch((error) => {
      connection.console.error(`Error scanning workspace folders: ${error}`);
    });
  }

  connection.console.log("Blueprint LSP server ready");
});

/**
 * Index a Blueprint file into the cross-file symbol index.
 */
async function indexFile(fileUri: string, filePath: string): Promise<void> {
  try {
    const content = await readFile(filePath, "utf-8");
    const tree = parseDocument(content);
    if (tree) {
      const ast = transformToAST(tree);
      symbolIndex.addFile(fileUri, ast);
      tree.delete(); // Clean up the tree after indexing
    }
  } catch (error) {
    connection.console.error(`Error indexing file ${filePath}: ${error}`);
  }
}

/**
 * Get the file path from a document URI.
 */
function getFilePath(uri: string): string {
  return URI.parse(uri).fsPath;
}

// Handle file system changes for watched files (.bp and .tickets.json)
connection.onDidChangeWatchedFiles(async (params) => {
  for (const change of params.changes) {
    const filePath = getFilePath(change.uri);
    const changeTypeStr = 
      change.type === FileChangeType.Created ? "created" : 
      change.type === FileChangeType.Changed ? "changed" : "deleted";

    // Process .bp files
    if (isBlueprintFilePath(filePath)) {
      connection.console.log(`Blueprint file ${changeTypeStr}: ${filePath}`);

      switch (change.type) {
        case FileChangeType.Created: {
          // Add to workspace manager and index the file
          workspaceManager.addFile(change.uri, filePath);
          if (parserInitialized) {
            await indexFile(change.uri, filePath);
            scheduleWorkspaceDiagnostics();
          }
          break;
        }
        case FileChangeType.Changed: {
          // Re-index the file (only if not currently open in editor)
          // When a file is open, document change events handle updates
          if (!documents.get(change.uri) && parserInitialized) {
            await indexFile(change.uri, filePath);
            scheduleWorkspaceDiagnostics();
          }
          break;
        }
        case FileChangeType.Deleted: {
          // Remove from workspace manager and symbol index
          workspaceManager.removeFile(change.uri);
          symbolIndex.removeFile(change.uri);
          // Also clean up document manager state if it exists
          documentManager.onDocumentClose(change.uri);
          // Re-publish workspace diagnostics after file removal
          scheduleWorkspaceDiagnostics();
          break;
        }
      }
      continue;
    }

    // Process .tickets.json files
    if (isTicketFilePath(filePath)) {
      connection.console.log(`Ticket file ${changeTypeStr}: ${filePath}`);

      switch (change.type) {
        case FileChangeType.Created:
        case FileChangeType.Changed: {
          // Read the file and update the ticket document manager
          try {
            const content = await readFile(filePath, "utf-8");
            // Use onDocumentChange to validate and update state
            // We use version 0 for external file changes since we don't have a real version
            ticketDocumentManager.onDocumentChange(change.uri, 0, content);
            // Re-publish workspace diagnostics since ticket status affects
            // no-ticket warnings and blocked requirement info
            scheduleWorkspaceDiagnostics();
          } catch (error) {
            connection.console.error(
              `Error reading ticket file ${filePath}: ${error}`
            );
          }
          break;
        }
        case FileChangeType.Deleted: {
          // Clean up the ticket document state
          ticketDocumentManager.onDocumentClose(change.uri);
          // Re-publish workspace diagnostics after ticket file removal
          scheduleWorkspaceDiagnostics();
          break;
        }
      }
    }
  }
});

// Document lifecycle events
documents.onDidOpen((event) => {
  const filePath = getFilePath(event.document.uri);
  
  // Handle .tickets.json files
  if (isTicketFilePath(filePath)) {
    ticketDocumentManager.onDocumentOpen(
      event.document.uri,
      event.document.version,
      event.document.getText()
    );
    // Re-publish workspace diagnostics since ticket status affects
    // no-ticket warnings and blocked requirement info
    scheduleWorkspaceDiagnostics();
    return;
  }
  
  // Handle .bp files
  if (isBlueprintFilePath(filePath)) {
    if (!parserInitialized) {
      connection.console.warn("Parser not initialized, skipping document parsing");
      return;
    }
    const state = documentManager.onDocumentOpen(event.document);
    // Update symbol index with the parsed document
    if (state.tree) {
      const ast = transformToAST(state.tree);
      symbolIndex.addFile(event.document.uri, ast);
      // Publish workspace diagnostics after indexing
      scheduleWorkspaceDiagnostics();
    }
  }
});

documents.onDidChangeContent((event) => {
  const filePath = getFilePath(event.document.uri);
  
  // Handle .tickets.json files
  if (isTicketFilePath(filePath)) {
    ticketDocumentManager.onDocumentChange(
      event.document.uri,
      event.document.version,
      event.document.getText()
    );
    // Re-publish workspace diagnostics since ticket status affects
    // no-ticket warnings and blocked requirement info
    scheduleWorkspaceDiagnostics();
    return;
  }
  
  // Handle .bp files
  if (isBlueprintFilePath(filePath)) {
    if (!parserInitialized) {
      return;
    }
    const state = documentManager.onDocumentChange(event.document);
    // Update symbol index with the changed document
    if (state.tree) {
      const ast = transformToAST(state.tree);
      symbolIndex.addFile(event.document.uri, ast);
      // Publish workspace diagnostics after indexing
      scheduleWorkspaceDiagnostics();
    }
  }
});

documents.onDidClose((event) => {
  const filePath = getFilePath(event.document.uri);
  
  // Handle .tickets.json files
  if (isTicketFilePath(filePath)) {
    ticketDocumentManager.onDocumentClose(event.document.uri);
    return;
  }
  
  // Handle .bp files
  if (isBlueprintFilePath(filePath)) {
    documentManager.onDocumentClose(event.document.uri);
    // Note: We don't remove from symbol index on close because the file still exists
    // The index should reflect the workspace state, not just open documents
  }
});

documents.onDidSave((event) => {
  const filePath = getFilePath(event.document.uri);
  
  // Handle .tickets.json files
  if (isTicketFilePath(filePath)) {
    ticketDocumentManager.onDocumentSave(
      event.document.uri,
      event.document.version,
      event.document.getText()
    );
    // Re-publish workspace diagnostics since ticket status affects
    // no-ticket warnings and blocked requirement info
    scheduleWorkspaceDiagnostics();
    return;
  }
  
  // Handle .bp files
  if (isBlueprintFilePath(filePath)) {
    if (!parserInitialized) {
      return;
    }
    const state = documentManager.onDocumentSave(event.document);
    // Update symbol index with the saved document
    if (state.tree) {
      const ast = transformToAST(state.tree);
      symbolIndex.addFile(event.document.uri, ast);
      // Publish workspace diagnostics after indexing
      scheduleWorkspaceDiagnostics();
    }
  }
});

// Handle semantic tokens request
connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }

  const filePath = getFilePath(params.textDocument.uri);
  if (!isBlueprintFilePath(filePath)) {
    return { data: [] };
  }

  if (!parserInitialized) {
    connection.console.warn("Parser not initialized, cannot provide semantic tokens");
    return { data: [] };
  }

  // Get the parse tree from the document manager
  const state = documentManager.getState(params.textDocument.uri);
  if (!state?.tree) {
    // Try to parse the document if not already parsed
    const tree = parseDocument(document.getText());
    if (!tree) {
      return { data: [] };
    }
    const tokens = buildSemanticTokens(tree);
    tree.delete();
    return tokens;
  }

  return buildSemanticTokens(state.tree);
});

// Handle hover request
connection.onHover((params: HoverParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const filePath = getFilePath(params.textDocument.uri);
  if (!isBlueprintFilePath(filePath)) {
    return null;
  }

  if (!parserInitialized) {
    return null;
  }

  // Get the parse tree from the document manager
  const state = documentManager.getState(params.textDocument.uri);
  if (!state?.tree) {
    return null;
  }

  // Find what we're hovering over
  const target = findHoverTarget(
    state.tree,
    params.position,
    symbolIndex,
    params.textDocument.uri
  );

  if (!target) {
    return null;
  }

  // Build the hover context with ticket and dependency information
  const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
  const allTickets = ticketDocumentManager.getAllTickets().map(t => t.ticket);
  
  // Create a mock ticket file for the map builder
  const ticketFile = allTickets.length > 0 
    ? { version: "1.0", source: "", tickets: allTickets }
    : null;
  
  const { map: ticketMap } = buildRequirementTicketMapFromSymbols(
    requirementSymbols,
    ticketFile
  );

  // Build the dependency graph
  const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

  const hoverContext: HoverContext = {
    symbolIndex,
    ticketMap,
    dependencyGraph,
    cycles,
    fileUri: params.textDocument.uri,
  };

  return buildHover(target, hoverContext);
});

// Handle definition request (go-to-definition)
connection.onDefinition((params: DefinitionParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const filePath = getFilePath(params.textDocument.uri);
  if (!isBlueprintFilePath(filePath)) {
    return null;
  }

  if (!parserInitialized) {
    return null;
  }

  // Get the parse tree from the document manager
  const state = documentManager.getState(params.textDocument.uri);
  if (!state?.tree) {
    return null;
  }

  // Find what we're requesting definition for
  const target = findDefinitionTarget(
    state.tree,
    params.position,
    symbolIndex,
    params.textDocument.uri
  );

  if (!target) {
    return null;
  }

  // Build the definition context with ticket information
  const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
  const allTickets = ticketDocumentManager.getAllTickets().map(t => t.ticket);
  
  // Create a mock ticket file for the map builder
  const ticketFile = allTickets.length > 0 
    ? { version: "1.0", source: "", tickets: allTickets }
    : null;
  
  const { map: ticketMap } = buildRequirementTicketMapFromSymbols(
    requirementSymbols,
    ticketFile
  );

  // Build the ticket files map for position lookup
  const ticketFilesMap = new Map<string, { uri: string; content: string; tickets: import("./tickets").Ticket[] }>();
  for (const ticketFileInfo of ticketDocumentManager.getAllTicketFilesWithContent()) {
    ticketFilesMap.set(ticketFileInfo.uri, {
      uri: ticketFileInfo.uri,
      content: ticketFileInfo.content,
      tickets: ticketFileInfo.data.tickets,
    });
  }

  const definitionContext: DefinitionContext = {
    symbolIndex,
    ticketMap,
    ticketFiles: ticketFilesMap,
    fileUri: params.textDocument.uri,
  };

  return buildDefinition(target, definitionContext);
});

connection.onShutdown(() => {
  connection.console.log("Blueprint LSP server shutting down");
  
  // Cancel any pending debounced diagnostics
  if (workspaceDiagnosticsDebounceTimer !== null) {
    clearTimeout(workspaceDiagnosticsDebounceTimer);
    workspaceDiagnosticsDebounceTimer = null;
  }
  
  // Clean up document manager resources (syntax trees)
  documentManager.cleanup();
  
  // Clean up ticket document manager resources
  ticketDocumentManager.cleanup();
  
  // Clean up workspace manager resources
  workspaceManager.cleanup();
  
  // Clean up symbol index
  symbolIndex.clear();
  
  // Clean up parser resources
  cleanupParser();
  
  connection.console.log("Blueprint LSP server resources cleaned up");
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
