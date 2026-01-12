import * as path from "node:path";
import {
  workspace,
  ExtensionContext,
  ConfigurationTarget,
  window,
  TextEditor,
  TextEditorDecorationType,
  Range,
  Uri,
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/**
 * Gutter decoration types for each requirement status.
 * Created lazily when the feature is enabled.
 */
let gutterDecorationTypes: Map<string, TextEditorDecorationType> | undefined;

/**
 * Debounce timer for updating gutter decorations.
 */
let gutterUpdateTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounce delay for gutter updates in milliseconds.
 */
const GUTTER_UPDATE_DEBOUNCE_MS = 100;

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
 * Requirement status types that match the server's RequirementHighlightStatus.
 */
type RequirementStatus =
  | "no-ticket"
  | "pending"
  | "blocked"
  | "in-progress"
  | "complete"
  | "obsolete";

/**
 * Response from the blueprint/requirementStatuses request.
 */
interface RequirementStatusItem {
  line: number;
  status: RequirementStatus;
  path: string;
}

interface RequirementStatusesResult {
  requirements: RequirementStatusItem[];
}

/**
 * Creates gutter decoration types for each requirement status.
 * Icons are loaded from the icons directory.
 */
function createGutterDecorationTypes(
  context: ExtensionContext
): Map<string, TextEditorDecorationType> {
  const types = new Map<string, TextEditorDecorationType>();

  const statuses: { status: RequirementStatus; icon: string }[] = [
    { status: "complete", icon: "complete.svg" },
    { status: "in-progress", icon: "in-progress.svg" },
    { status: "blocked", icon: "blocked.svg" },
    { status: "no-ticket", icon: "no-ticket.svg" },
    { status: "obsolete", icon: "obsolete.svg" },
    { status: "pending", icon: "pending.svg" },
  ];

  for (const { status, icon } of statuses) {
    const iconPath = Uri.file(context.asAbsolutePath(path.join("icons", icon)));
    const decorationType = window.createTextEditorDecorationType({
      gutterIconPath: iconPath,
      gutterIconSize: "contain",
    });
    types.set(status, decorationType);
  }

  return types;
}

/**
 * Disposes all gutter decoration types.
 */
function disposeGutterDecorationTypes(): void {
  if (gutterDecorationTypes) {
    for (const decorationType of gutterDecorationTypes.values()) {
      decorationType.dispose();
    }
    gutterDecorationTypes = undefined;
  }
}

/**
 * Updates gutter decorations for a text editor.
 * Requests requirement statuses from the server and applies decorations.
 */
async function updateGutterDecorations(editor: TextEditor): Promise<void> {
  if (!client || !gutterDecorationTypes) {
    return;
  }

  // Only apply to Blueprint files
  if (editor.document.languageId !== "blueprint") {
    return;
  }

  try {
    // Request requirement statuses from the server
    const result = await client.sendRequest<RequirementStatusesResult>(
      "blueprint/requirementStatuses",
      { uri: editor.document.uri.toString() }
    );

    // Group requirements by status
    const decorationsByStatus = new Map<RequirementStatus, Range[]>();
    for (const { line, status } of result.requirements) {
      const ranges = decorationsByStatus.get(status) ?? [];
      // Create a range that covers just the line number gutter area
      ranges.push(new Range(line, 0, line, 0));
      decorationsByStatus.set(status, ranges);
    }

    // Apply decorations for each status
    for (const [status, decorationType] of gutterDecorationTypes) {
      const ranges = decorationsByStatus.get(status as RequirementStatus) ?? [];
      editor.setDecorations(decorationType, ranges);
    }
  } catch (error) {
    // Silently ignore errors (e.g., server not ready)
    console.error("Failed to update gutter decorations:", error);
  }
}

/**
 * Schedules a debounced update of gutter decorations for all visible editors.
 */
function scheduleGutterUpdate(): void {
  if (gutterUpdateTimer) {
    clearTimeout(gutterUpdateTimer);
  }
  gutterUpdateTimer = setTimeout(() => {
    gutterUpdateTimer = undefined;
    for (const editor of window.visibleTextEditors) {
      updateGutterDecorations(editor);
    }
  }, GUTTER_UPDATE_DEBOUNCE_MS);
}

/**
 * Clears gutter decorations from all visible editors.
 */
function clearAllGutterDecorations(): void {
  if (!gutterDecorationTypes) {
    return;
  }
  for (const editor of window.visibleTextEditors) {
    for (const decorationType of gutterDecorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
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

/**
 * Updates the VS Code editor.hover.delay setting for Blueprint files
 * based on the blueprint.hoverDelay setting.
 *
 * This allows users to configure a custom hover delay specifically for
 * Blueprint files without affecting other languages.
 */
function updateHoverDelay(): void {
  const config = workspace.getConfiguration("blueprint");
  const hoverDelay = config.get<number>("hoverDelay") ?? 300;

  // Get the current language-specific settings for Blueprint
  const editorConfig = workspace.getConfiguration("editor", {
    languageId: "blueprint",
  });

  // Only update if the value differs from current setting
  const currentValue = editorConfig.get<number>("hover.delay");
  if (currentValue !== hoverDelay) {
    // Update the language-specific setting for Blueprint files
    editorConfig.update(
      "hover.delay",
      hoverDelay,
      ConfigurationTarget.Global,
      true // overrideInLanguage
    );
  }
}

/**
 * Initializes or disposes gutter decorations based on the showProgressInGutter setting.
 */
function updateGutterIconsEnabled(context: ExtensionContext): void {
  const config = workspace.getConfiguration("blueprint");
  const enabled = config.get<boolean>("showProgressInGutter") ?? true;

  if (enabled) {
    // Create decoration types if not already created
    if (!gutterDecorationTypes) {
      gutterDecorationTypes = createGutterDecorationTypes(context);
    }
    // Update decorations for all visible editors
    scheduleGutterUpdate();
  } else {
    // Clear and dispose decoration types
    clearAllGutterDecorations();
    disposeGutterDecorationTypes();
  }
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
  // Wait for the client to be ready before enabling gutter decorations
  client.start().then(() => {
    // Initialize gutter decorations after server is ready
    updateGutterIconsEnabled(context);
  });

  // Apply initial settings
  updateSemanticTokenColors();
  updateGotoModifier();
  updateHoverDelay();

  // Listen for configuration changes to update settings dynamically
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blueprint.highlighting")) {
        updateSemanticTokenColors();
      }
      if (e.affectsConfiguration("blueprint.gotoModifier")) {
        updateGotoModifier();
      }
      if (e.affectsConfiguration("blueprint.showProgressInGutter")) {
        updateGutterIconsEnabled(context);
      }
      if (e.affectsConfiguration("blueprint.hoverDelay")) {
        updateHoverDelay();
      }
    })
  );

  // Update gutter decorations when visible editors change
  context.subscriptions.push(
    window.onDidChangeVisibleTextEditors(() => {
      if (gutterDecorationTypes) {
        scheduleGutterUpdate();
      }
    })
  );

  // Update gutter decorations when document content changes
  context.subscriptions.push(
    workspace.onDidChangeTextDocument((e) => {
      if (gutterDecorationTypes && e.document.languageId === "blueprint") {
        scheduleGutterUpdate();
      }
    })
  );

  // Update gutter decorations when a document is saved (ticket files may change)
  context.subscriptions.push(
    workspace.onDidSaveTextDocument((doc) => {
      if (gutterDecorationTypes) {
        // Trigger update for .bp files or when ticket files are saved
        if (doc.languageId === "blueprint" || doc.fileName.endsWith(".tickets.json")) {
          scheduleGutterUpdate();
        }
      }
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  // Clean up gutter decorations
  if (gutterUpdateTimer) {
    clearTimeout(gutterUpdateTimer);
    gutterUpdateTimer = undefined;
  }
  disposeGutterDecorationTypes();

  if (!client) {
    return undefined;
  }
  return client.stop();
}
