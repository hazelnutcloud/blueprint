import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
} from "vscode-languageserver/node";
import type {
  InitializeParams,
  InitializeResult,
  TextDocumentSyncOptions,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initializeParser, cleanupParser, parseDocument } from "./parser";
import { DocumentManager } from "./documents";
import { WorkspaceManager } from "./workspace";
import { CrossFileSymbolIndex } from "./symbol-index";
import { transformToAST } from "./ast";
import { readFile } from "node:fs/promises";
import { URI } from "vscode-uri";

// Create a connection for the server using Node's IPC as transport.
// Also includes all proposed protocol features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

// Create the document manager for tracking parsed state
const documentManager = new DocumentManager(connection);

// Create the workspace manager for scanning workspace folders
const workspaceManager = new WorkspaceManager(connection);

// Create the cross-file symbol index for workspace-wide symbol resolution
const symbolIndex = new CrossFileSymbolIndex();

// Track whether the client supports dynamic registration for configuration changes
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Track parser initialization state
let parserInitialized = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;

  // Check client capabilities
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
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

// Document lifecycle events
documents.onDidOpen((event) => {
  if (!parserInitialized) {
    connection.console.warn("Parser not initialized, skipping document parsing");
    return;
  }
  const state = documentManager.onDocumentOpen(event.document);
  // Update symbol index with the parsed document
  if (state.tree) {
    const ast = transformToAST(state.tree);
    symbolIndex.addFile(event.document.uri, ast);
  }
});

documents.onDidChangeContent((event) => {
  if (!parserInitialized) {
    return;
  }
  const state = documentManager.onDocumentChange(event.document);
  // Update symbol index with the changed document
  if (state.tree) {
    const ast = transformToAST(state.tree);
    symbolIndex.addFile(event.document.uri, ast);
  }
});

documents.onDidClose((event) => {
  documentManager.onDocumentClose(event.document.uri);
  // Note: We don't remove from symbol index on close because the file still exists
  // The index should reflect the workspace state, not just open documents
});

documents.onDidSave((event) => {
  if (!parserInitialized) {
    return;
  }
  const state = documentManager.onDocumentSave(event.document);
  // Update symbol index with the saved document
  if (state.tree) {
    const ast = transformToAST(state.tree);
    symbolIndex.addFile(event.document.uri, ast);
  }
});

connection.onShutdown(() => {
  connection.console.log("Blueprint LSP server shutting down");
  
  // Clean up document manager resources (syntax trees)
  documentManager.cleanup();
  
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
