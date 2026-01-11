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
import { initializeParser, cleanupParser } from "./parser";
import { DocumentManager } from "./documents";
import { WorkspaceManager } from "./workspace";

// Create a connection for the server using Node's IPC as transport.
// Also includes all proposed protocol features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

// Create the document manager for tracking parsed state
const documentManager = new DocumentManager(connection);

// Create the workspace manager for scanning workspace folders
const workspaceManager = new WorkspaceManager(connection);

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

  // Scan workspace folders for .bp files after parser is initialized
  if (hasWorkspaceFolderCapability) {
    workspaceManager.scanAllFolders().catch((error) => {
      connection.console.error(`Error scanning workspace folders: ${error}`);
    });
  }

  connection.console.log("Blueprint LSP server ready");
});

// Document lifecycle events
documents.onDidOpen((event) => {
  if (!parserInitialized) {
    connection.console.warn("Parser not initialized, skipping document parsing");
    return;
  }
  documentManager.onDocumentOpen(event.document);
});

documents.onDidChangeContent((event) => {
  if (!parserInitialized) {
    return;
  }
  documentManager.onDocumentChange(event.document);
});

documents.onDidClose((event) => {
  documentManager.onDocumentClose(event.document.uri);
});

documents.onDidSave((event) => {
  if (!parserInitialized) {
    return;
  }
  documentManager.onDocumentSave(event.document);
});

connection.onShutdown(() => {
  connection.console.log("Blueprint LSP server shutting down");
  
  // Clean up document manager resources (syntax trees)
  documentManager.cleanup();
  
  // Clean up workspace manager resources
  workspaceManager.cleanup();
  
  // Clean up parser resources
  cleanupParser();
  
  connection.console.log("Blueprint LSP server resources cleaned up");
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
