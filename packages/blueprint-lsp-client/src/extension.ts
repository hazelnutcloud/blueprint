import * as path from "node:path";
import * as fs from "node:fs";
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
 * Background decoration types for each requirement status.
 * Created lazily when the feature is enabled.
 * Per SPEC.md Section 5.4, requirements are highlighted with backgrounds based on status.
 */
let backgroundDecorationTypes: Map<string, TextEditorDecorationType> | undefined;

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
 * Default background colors per SPEC.md Section 5.4
 * These have low opacity for subtle highlighting effect.
 */
const DEFAULT_BACKGROUND_COLORS = {
  complete: "rgba(45, 90, 39, 0.15)", // Green background
  inProgress: "rgba(138, 109, 59, 0.15)", // Amber background
  blocked: "rgba(169, 68, 66, 0.15)", // Red background
  noTicket: "rgba(108, 117, 125, 0.10)", // Dim/gray background
  obsolete: "rgba(134, 142, 150, 0.08)", // Very dim gray
  pending: undefined, // No highlight per SPEC
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
 * Creates background decoration types for each requirement status.
 * Per SPEC.md Section 5.4, requirements are highlighted with backgrounds:
 * - No ticket: Dim/gray background
 * - pending: No highlight (default)
 * - blocked: Red underline or background
 * - in-progress: Yellow/amber background
 * - complete: Green background
 * - obsolete: Strikethrough (handled via font style, dim background for visual consistency)
 */
function createBackgroundDecorationTypes(): Map<string, TextEditorDecorationType> {
  const types = new Map<string, TextEditorDecorationType>();

  // Read user's color settings (fall back to defaults)
  const config = workspace.getConfiguration("blueprint.highlighting");

  // Helper to convert a hex color to rgba with low opacity
  function toBackgroundColor(
    hexColor: string | undefined,
    defaultRgba: string | undefined
  ): string | undefined {
    if (!defaultRgba) return undefined;
    if (!hexColor) return defaultRgba;

    // Convert hex to rgba with 0.15 opacity
    const hex = hexColor.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.15)`;
  }

  const statuses: {
    status: RequirementStatus;
    configKey: keyof typeof DEFAULT_COLORS | null;
    fontStyle?: string;
  }[] = [
    { status: "complete", configKey: "complete" },
    { status: "in-progress", configKey: "inProgress" },
    { status: "blocked", configKey: "blocked", fontStyle: "underline" }, // SPEC says "Red underline or background"
    { status: "no-ticket", configKey: "noTicket", fontStyle: "italic" },
    { status: "obsolete", configKey: "obsolete", fontStyle: "line-through" }, // SPEC says "Strikethrough"
    { status: "pending", configKey: null }, // No highlight
  ];

  for (const { status, configKey, fontStyle } of statuses) {
    const userColor = configKey ? config.get<string>(configKey) : undefined;
    const defaultBgColor =
      DEFAULT_BACKGROUND_COLORS[status as keyof typeof DEFAULT_BACKGROUND_COLORS];
    const backgroundColor = toBackgroundColor(userColor, defaultBgColor);

    // Create decoration even if no background color (for pending)
    const decorationType = window.createTextEditorDecorationType({
      backgroundColor,
      isWholeLine: true,
      overviewRulerColor: backgroundColor,
      overviewRulerLane: 2, // OverviewRulerLane.Center
      textDecoration: fontStyle ? `none; text-decoration: ${fontStyle}` : undefined,
    });
    types.set(status, decorationType);
  }

  return types;
}

/**
 * Disposes all background decoration types.
 */
function disposeBackgroundDecorationTypes(): void {
  if (backgroundDecorationTypes) {
    for (const decorationType of backgroundDecorationTypes.values()) {
      decorationType.dispose();
    }
    backgroundDecorationTypes = undefined;
  }
}

/**
 * Updates decorations (gutter and/or background) for a text editor.
 * Requests requirement statuses from the server and applies decorations.
 */
async function updateDecorations(editor: TextEditor): Promise<void> {
  const hasGutterDecorations = !!gutterDecorationTypes;
  const hasBackgroundDecorations = !!backgroundDecorationTypes;

  if (!client || (!hasGutterDecorations && !hasBackgroundDecorations)) {
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

    // Apply gutter decorations for each status
    if (gutterDecorationTypes) {
      for (const [status, decorationType] of gutterDecorationTypes) {
        const ranges = decorationsByStatus.get(status as RequirementStatus) ?? [];
        editor.setDecorations(decorationType, ranges);
      }
    }

    // Apply background decorations for each status
    if (backgroundDecorationTypes) {
      for (const [status, decorationType] of backgroundDecorationTypes) {
        const ranges = decorationsByStatus.get(status as RequirementStatus) ?? [];
        editor.setDecorations(decorationType, ranges);
      }
    }
  } catch (error) {
    // Silently ignore errors (e.g., server not ready)
    console.error("Failed to update decorations:", error);
  }
}

/**
 * Schedules a debounced update of decorations (gutter and background) for all visible editors.
 */
function scheduleDecorationUpdate(): void {
  if (gutterUpdateTimer) {
    clearTimeout(gutterUpdateTimer);
  }
  gutterUpdateTimer = setTimeout(() => {
    gutterUpdateTimer = undefined;
    for (const editor of window.visibleTextEditors) {
      updateDecorations(editor);
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
 * Clears background decorations from all visible editors.
 */
function clearAllBackgroundDecorations(): void {
  if (!backgroundDecorationTypes) {
    return;
  }
  for (const editor of window.visibleTextEditors) {
    for (const decorationType of backgroundDecorationTypes.values()) {
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
    scheduleDecorationUpdate();
  } else {
    // Clear and dispose decoration types
    clearAllGutterDecorations();
    disposeGutterDecorationTypes();
  }
}

/**
 * Initializes or disposes background decorations based on the showProgressHighlighting setting.
 * Per SPEC.md Section 5.4, requirements are highlighted with backgrounds based on status.
 */
function updateProgressHighlightingEnabled(): void {
  const config = workspace.getConfiguration("blueprint");
  const enabled = config.get<boolean>("showProgressHighlighting") ?? true;

  if (enabled) {
    // Create decoration types if not already created
    if (!backgroundDecorationTypes) {
      backgroundDecorationTypes = createBackgroundDecorationTypes();
    }
    // Update decorations for all visible editors
    scheduleDecorationUpdate();
  } else {
    // Clear and dispose decoration types
    clearAllBackgroundDecorations();
    disposeBackgroundDecorationTypes();
  }
}

export function activate(context: ExtensionContext): void {
  // The server is implemented in the blueprint-lsp-server package
  // Search order:
  // 1. out/server/ - bundled during vscode:prepublish for distribution
  // 2. node_modules/blueprint-lsp-server/dist/ - when installed as dependency
  // 3. ../blueprint-lsp-server/dist/ - monorepo development path
  const serverPaths = [
    path.join("out", "server", "server"),
    path.join("node_modules", "blueprint-lsp-server", "dist", "server"),
    path.join("..", "blueprint-lsp-server", "dist", "server"),
  ];

  let serverBin: string | undefined;
  for (const relativePath of serverPaths) {
    const fullPath = context.asAbsolutePath(relativePath);
    if (fs.existsSync(fullPath)) {
      serverBin = fullPath;
      break;
    }
  }

  if (!serverBin) {
    window.showErrorMessage(
      "Blueprint LSP server not found. Please ensure the extension is properly installed."
    );
    return;
  }

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions = {
    run: {
      command: serverBin,
      args: ["--stdio"],
      transport: TransportKind.stdio,
    },
    debug: {
      command: serverBin,
      args: ["--stdio", "--nolazy", "--inspect=6009"],
      transport: TransportKind.stdio,
    },
  } satisfies ServerOptions;

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for Blueprint documents
    // Include both 'file' scheme (saved files) and 'untitled' scheme (in-memory documents)
    // The 'untitled' scheme is needed for E2E tests that create in-memory documents
    documentSelector: [
      { scheme: "file", language: "blueprint" },
      { scheme: "untitled", language: "blueprint" },
    ],
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
  // Wait for the client to be ready before enabling decorations
  client
    .start()
    .then(() => {
      // Initialize gutter and background decorations after server is ready
      updateGutterIconsEnabled(context);
      updateProgressHighlightingEnabled();
    })
    .catch((error) => {
      window.showErrorMessage(`Blueprint LSP server failed to start: ${error.message}`);
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
      if (e.affectsConfiguration("blueprint.showProgressHighlighting")) {
        updateProgressHighlightingEnabled();
      }
      if (e.affectsConfiguration("blueprint.hoverDelay")) {
        updateHoverDelay();
      }
    })
  );

  // Update decorations when visible editors change
  context.subscriptions.push(
    window.onDidChangeVisibleTextEditors(() => {
      if (gutterDecorationTypes || backgroundDecorationTypes) {
        scheduleDecorationUpdate();
      }
    })
  );

  // Update decorations when document content changes
  context.subscriptions.push(
    workspace.onDidChangeTextDocument((e) => {
      if (
        (gutterDecorationTypes || backgroundDecorationTypes) &&
        e.document.languageId === "blueprint"
      ) {
        scheduleDecorationUpdate();
      }
    })
  );

  // Update decorations when a document is saved (ticket files may change)
  context.subscriptions.push(
    workspace.onDidSaveTextDocument((doc) => {
      if (gutterDecorationTypes || backgroundDecorationTypes) {
        // Trigger update for .bp files or when ticket files are saved
        if (doc.languageId === "blueprint" || doc.fileName.endsWith(".tickets.json")) {
          scheduleDecorationUpdate();
        }
      }
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  // Clean up decorations
  if (gutterUpdateTimer) {
    clearTimeout(gutterUpdateTimer);
    gutterUpdateTimer = undefined;
  }
  disposeGutterDecorationTypes();
  disposeBackgroundDecorationTypes();

  if (!client) {
    return undefined;
  }
  return client.stop();
}
