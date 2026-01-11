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

// Create a connection for the server using Node's IPC as transport.
// Also includes all proposed protocol features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

// Create the document manager for tracking parsed state
const documentManager = new DocumentManager(connection);

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
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log("Workspace folder change event received.");
    });
  }

  // Initialize the tree-sitter parser
  try {
    await initializeParser();
    parserInitialized = true;
    connection.console.log("Tree-sitter parser initialized successfully");
  } catch (error) {
    connection.console.error(`Failed to initialize parser: ${error}`);
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
  
  // Clean up parser resources
  cleanupParser();
  
  connection.console.log("Blueprint LSP server resources cleaned up");
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
