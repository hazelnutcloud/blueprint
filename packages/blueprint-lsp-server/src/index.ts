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
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initializeParser, cleanupParser, parseDocument } from "./parser";
import { DocumentManager } from "./documents";
import { TicketDocumentManager } from "./ticket-documents";
import { WorkspaceManager } from "./workspace";
import { CrossFileSymbolIndex } from "./symbol-index";
import { transformToAST } from "./ast";
import { isTicketFilePath, isBlueprintFilePath } from "./tickets";
import { computeWorkspaceDiagnostics, computeOrphanedTicketDiagnostics } from "./workspace-diagnostics";
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

/**
 * Publish workspace-level diagnostics (circular dependencies, unresolved references, no-ticket warnings, orphaned tickets).
 * 
 * This function computes diagnostics across all indexed files and publishes them.
 * It also clears diagnostics from files that no longer have issues.
 */
function publishWorkspaceDiagnostics(): void {
  // Get all tickets from the ticket document manager
  const allTickets = ticketDocumentManager.getAllTickets().map(t => t.ticket);
  const result = computeWorkspaceDiagnostics(symbolIndex, allTickets);
  
  // Compute orphaned ticket diagnostics (tickets referencing removed requirements)
  const ticketFiles = ticketDocumentManager.getAllTicketFiles();
  const orphanedResult = computeOrphanedTicketDiagnostics(symbolIndex, ticketFiles);
  
  // Clear diagnostics from files that no longer have workspace-level issues
  for (const fileUri of filesWithWorkspaceDiagnostics) {
    if (!result.byFile.has(fileUri) && !orphanedResult.byFile.has(fileUri)) {
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
  
  // Publish orphaned ticket diagnostics for .tickets.json files, merging with ticket document diagnostics
  for (const [fileUri, orphanedDiagnostics] of orphanedResult.byFile) {
    const ticketState = ticketDocumentManager.getState(fileUri);
    const ticketDocumentDiagnostics = ticketState?.diagnostics ?? [];
    
    // Merge ticket document diagnostics with orphaned ticket diagnostics
    const allDiagnostics = [...ticketDocumentDiagnostics, ...orphanedDiagnostics];
    
    connection.sendDiagnostics({
      uri: fileUri,
      diagnostics: allDiagnostics,
    });
  }
  
  // Update the set of files with workspace diagnostics
  filesWithWorkspaceDiagnostics = new Set([
    ...result.filesWithDiagnostics,
    ...orphanedResult.filesWithDiagnostics,
  ]);
  
  const totalFiles = result.filesWithDiagnostics.length + orphanedResult.filesWithDiagnostics.length;
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
    publishWorkspaceDiagnostics();
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
            publishWorkspaceDiagnostics();
          }
          break;
        }
        case FileChangeType.Changed: {
          // Re-index the file (only if not currently open in editor)
          // When a file is open, document change events handle updates
          if (!documents.get(change.uri) && parserInitialized) {
            await indexFile(change.uri, filePath);
            publishWorkspaceDiagnostics();
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
          publishWorkspaceDiagnostics();
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
      publishWorkspaceDiagnostics();
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
      publishWorkspaceDiagnostics();
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
      publishWorkspaceDiagnostics();
    }
  }
});

connection.onShutdown(() => {
  connection.console.log("Blueprint LSP server shutting down");
  
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
