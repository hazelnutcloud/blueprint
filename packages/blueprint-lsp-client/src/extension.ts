import * as path from "node:path";
import { workspace, ExtensionContext, ConfigurationTarget } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/**
 * Default highlighting colors per SPEC.md Section 5.9
 */
const DEFAULT_COLORS = {
  complete: "#2d5a27",
  inProgress: "#8a6d3b",
  blocked: "#a94442",
  noTicket: "#6c757d",
  obsolete: "#868e96",
};

/**
 * Valid values for the gotoModifier setting per SPEC.md Section 5.9
 * Maps to VS Code's editor.multiCursorModifier setting.
 *
 * - "alt": Use Alt+Click for go-to-definition (Ctrl/Cmd+Click adds cursors)
 * - "ctrlCmd": Use Ctrl/Cmd+Click for go-to-definition (Alt+Click adds cursors)
 *
 * Note: VS Code's multiCursorModifier is the inverse - it specifies which key
 * adds multiple cursors, and go-to-definition uses the other key.
 */
type GotoModifier = "alt" | "ctrlCmd";

/**
 * Updates the VS Code editor.multiCursorModifier setting for Blueprint files
 * based on the blueprint.gotoModifier setting.
 *
 * The relationship is inverse:
 * - If gotoModifier is "alt", multiCursorModifier should be "ctrlCmd"
 *   (so Alt+Click does go-to-definition)
 * - If gotoModifier is "ctrlCmd", multiCursorModifier should be "alt"
 *   (so Ctrl/Cmd+Click does go-to-definition)
 */
function updateGotoModifier(): void {
  const config = workspace.getConfiguration("blueprint");
  const gotoModifier = config.get<GotoModifier>("gotoModifier") ?? "alt";

  // Inverse mapping: gotoModifier specifies what triggers definition,
  // multiCursorModifier specifies what triggers multi-cursor
  const multiCursorModifier: "alt" | "ctrlCmd" = gotoModifier === "alt" ? "ctrlCmd" : "alt";

  // Get the current language-specific settings for Blueprint
  const editorConfig = workspace.getConfiguration("editor", {
    languageId: "blueprint",
  });

  // Only update if the value differs from current setting
  const currentValue = editorConfig.get<string>("multiCursorModifier");
  if (currentValue !== multiCursorModifier) {
    // Update the language-specific setting for Blueprint files
    editorConfig.update(
      "multiCursorModifier",
      multiCursorModifier,
      ConfigurationTarget.Global,
      true // overrideInLanguage
    );
  }
}

/**
 * Updates the semantic token color customizations based on the user's
 * blueprint.highlighting.* settings. This allows users to customize
 * the colors used for requirement status highlighting.
 */
function updateSemanticTokenColors(): void {
  const config = workspace.getConfiguration("blueprint.highlighting");

  const complete = config.get<string>("complete") ?? DEFAULT_COLORS.complete;
  const inProgress = config.get<string>("inProgress") ?? DEFAULT_COLORS.inProgress;
  const blocked = config.get<string>("blocked") ?? DEFAULT_COLORS.blocked;
  const noTicket = config.get<string>("noTicket") ?? DEFAULT_COLORS.noTicket;
  const obsolete = config.get<string>("obsolete") ?? DEFAULT_COLORS.obsolete;

  // Build the rules object for semantic token colors
  const rules: Record<string, { foreground: string; fontStyle?: string }> = {
    "*.noTicket:blueprint": {
      foreground: noTicket,
      fontStyle: "italic",
    },
    "*.blocked:blueprint": {
      foreground: blocked,
      fontStyle: "underline",
    },
    "*.inProgress:blueprint": {
      foreground: inProgress,
    },
    "*.complete:blueprint": {
      foreground: complete,
    },
    "*.obsolete:blueprint": {
      foreground: obsolete,
      fontStyle: "strikethrough",
    },
  };

  // Get current user-level semantic token color customizations
  const editorConfig = workspace.getConfiguration("editor");
  const currentCustomizations = editorConfig.get<Record<string, unknown>>(
    "semanticTokenColorCustomizations"
  );

  // Merge with existing customizations (preserving user's other rules)
  const existingRules = (currentCustomizations?.rules as Record<string, unknown> | undefined) ?? {};
  const mergedRules = { ...existingRules, ...rules };

  // Update the configuration at the global level
  editorConfig.update(
    "semanticTokenColorCustomizations",
    { ...currentCustomizations, rules: mergedRules },
    ConfigurationTarget.Global
  );
}

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

  // Apply initial settings
  updateSemanticTokenColors();
  updateGotoModifier();

  // Listen for configuration changes to update settings dynamically
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blueprint.highlighting")) {
        updateSemanticTokenColors();
      }
      if (e.affectsConfiguration("blueprint.gotoModifier")) {
        updateGotoModifier();
      }
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
