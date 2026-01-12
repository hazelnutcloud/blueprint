import * as path from "node:path";
import { workspace, ExtensionContext } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  // The server is implemented in the blueprint-lsp-server package
  // We look for the server module in node_modules or use a local path during development
  const serverModule = context.asAbsolutePath(
    path.join("..", "blueprint-lsp-server", "dist", "index.cjs")
  );

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ["--nolazy", "--inspect=6009"],
      },
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for Blueprint documents
    documentSelector: [{ scheme: "file", language: "blueprint" }],
    synchronize: {
      // Notify the server about file changes to '.bp' and '.tickets.json' files in the workspace
      fileEvents: [
        workspace.createFileSystemWatcher("**/*.bp"),
        workspace.createFileSystemWatcher("**/.blueprint/tickets/*.tickets.json"),
      ],
    },
    // Configure output channel for tracing
    outputChannelName: "Blueprint Language Server",
  };

  // Create the language client and start it
  client = new LanguageClient(
    "blueprint",
    "Blueprint Language Server",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server.
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
