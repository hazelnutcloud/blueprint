/**
 * Completion support for the Blueprint LSP.
 *
 * This module provides autocompletion features for Blueprint DSL files including:
 * - Keyword completion (`@module`, `@feature`, `@requirement`, `@constraint`, `@depends-on`, `@description`)
 * - Reference completion (for `@depends-on` clauses)
 * - Path completion with dot-notation navigation
 * - Context-aware suggestions based on cursor position
 *
 * @module completion
 *
 * ## Architecture Overview
 *
 * The completion provider follows a **context-driven dispatch** architecture where the
 * cursor position is analyzed to determine what type of completions to offer. The system
 * is designed for extensibility and lazy evaluation to maintain responsiveness.
 *
 * ### Core Flow
 *
 * ```
 * ┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
 * │ LSP Completion  │────▶│ getCursorContext │────▶│ Context-Based   │
 * │ Request         │     │                  │     │ Dispatch        │
 * └─────────────────┘     └──────────────────┘     └─────────────────┘
 *                                                          │
 *         ┌────────────────────────────────────────────────┼────────────────┐
 *         ▼                    ▼                    ▼                       ▼
 * ┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
 * │   Keyword     │   │  Reference    │   │    Path       │   │   Identifier   │
 * │  Completions  │   │  Completions  │   │  Completions  │   │   Completions  │
 * └───────────────┘   └───────────────┘   └───────────────┘   └────────────────┘
 * ```
 *
 * ### Module Structure
 *
 * **1. Context Detection Layer** (`getCursorContext`)
 * - Analyzes cursor position using tree-sitter AST
 * - Determines scope (top-level, module, feature, requirement)
 * - Detects trigger contexts (@, ., @depends-on, etc.)
 * - Extracts prefix text for filtering
 * - Identifies "skip zones" (comments, code blocks)
 *
 * **2. Completion Generators**
 * - `getKeywordCompletions()` - Scope-aware keyword suggestions with snippets
 * - `getReferenceCompletions()` - Fuzzy-matched symbols for @depends-on
 * - `getPathCompletions()` - Child symbols after dot navigation
 * - `getConstraintNameCompletions()` - Workspace-learned constraint names
 * - `getIdentifierNameCompletions()` - Action-verb patterns for naming
 * - `getCodeBlockLanguageCompletions()` - Language identifiers for fenced blocks
 * - `getDescriptionCompletions()` - Documentation templates
 *
 * **3. Main Entry Points**
 * - `buildCompletions()` - Dispatches to appropriate generator based on context
 * - `resolveCompletionItem()` - Lazy-loads rich documentation on selection
 *
 * ### Key Design Decisions
 *
 * 1. **Scope-Based Filtering**: Keywords are filtered by validity in current scope.
 *    For example, `@module` only appears at top-level, `@feature` only inside modules.
 *
 * 2. **Fuzzy Matching**: Reference completions use multi-tier scoring:
 *    - Exact match (100) > Prefix match (80-90) > Substring (50-60) > Fuzzy (20)
 *    - Local symbols (same file) are boosted in ranking
 *
 * 3. **Circular Dependency Prevention**: `getReferenceCompletions()` filters out
 *    references that would create dependency cycles via `symbolIndex.wouldCreateCircularDependency()`.
 *
 * 4. **Lazy Resolution**: Rich documentation (dependencies, constraints, file location)
 *    is only loaded when user focuses on an item, reducing initial completion latency.
 *
 * 5. **Snippet Templates**: All keywords use snippet syntax for tab-stop navigation,
 *    e.g., `@module ${1:name}\n\t$0` places cursor at name, then inside the block.
 *
 * ### Integration with LSP Server
 *
 * The completion provider is registered in `index.ts` with:
 * - Trigger characters: `@` (keywords), `.` (path navigation)
 * - `resolveProvider: true` for lazy documentation loading
 *
 * The `onCompletion` handler calls `buildCompletions()` with the parsed tree-sitter
 * tree and symbol index. The `onCompletionResolve` handler calls `resolveCompletionItem()`
 * to fetch full documentation when a completion item is selected.
 *
 * ### Dependencies
 *
 * - `CrossFileSymbolIndex` - Provides workspace-wide symbol queries
 * - `tree-sitter` - Parses Blueprint DSL for AST-based context detection
 * - `vscode-languageserver` - LSP protocol types and completion item kinds
 */

import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  InsertTextFormat,
  MarkupKind,
} from "vscode-languageserver/node";
import type { Position, CompletionParams } from "vscode-languageserver/node";
import type { Tree, Node } from "./parser";
import type { CrossFileSymbolIndex, IndexedSymbol } from "./symbol-index";

// ============================================================================
// Constants
// ============================================================================

/**
 * Blueprint DSL keywords with their metadata for completion.
 */
export const COMPLETION_KEYWORDS = {
  "@module": {
    label: "@module",
    kind: CompletionItemKind.Keyword,
    detail: "Define a module",
    documentation: {
      kind: MarkupKind.Markdown,
      value:
        "Defines a module - a major system boundary.\n\n```blueprint\n@module auth\n  @feature login\n    @requirement validate-credentials\n```",
    },
    insertText: "@module ${1:name}\n\t$0",
    insertTextFormat: InsertTextFormat.Snippet,
    validScopes: ["top-level"] as const,
  },
  "@feature": {
    label: "@feature",
    kind: CompletionItemKind.Keyword,
    detail: "Define a feature",
    documentation: {
      kind: MarkupKind.Markdown,
      value:
        "Defines a feature - a user-facing capability within a module.\n\n```blueprint\n@feature login\n  @requirement validate-credentials\n  @requirement create-session\n```",
    },
    insertText: "@feature ${1:name}\n\t$0",
    insertTextFormat: InsertTextFormat.Snippet,
    validScopes: ["module"] as const,
  },
  "@requirement": {
    label: "@requirement",
    kind: CompletionItemKind.Keyword,
    detail: "Define a requirement",
    documentation: {
      kind: MarkupKind.Markdown,
      value:
        "Defines a requirement - a specific implementable unit.\n\n```blueprint\n@requirement validate-credentials\n  @constraint input-validation\n  @depends-on auth.session\n```",
    },
    insertText: "@requirement ${1:name}\n\t$0",
    insertTextFormat: InsertTextFormat.Snippet,
    validScopes: ["module", "feature"] as const,
  },
  "@constraint": {
    label: "@constraint",
    kind: CompletionItemKind.Keyword,
    detail: "Define a constraint",
    documentation: {
      kind: MarkupKind.Markdown,
      value:
        "Defines a constraint - an implementation requirement that must be satisfied.\n\n```blueprint\n@constraint input-validation\n@constraint rate-limiting\n```",
    },
    insertText: "@constraint ${1:name} $0",
    insertTextFormat: InsertTextFormat.Snippet,
    validScopes: ["module", "feature", "requirement"] as const,
  },
  "@depends-on": {
    label: "@depends-on",
    kind: CompletionItemKind.Keyword,
    detail: "Declare dependencies",
    documentation: {
      kind: MarkupKind.Markdown,
      value:
        "Declares dependencies on other modules, features, or requirements.\n\n```blueprint\n@depends-on auth.session, storage.database\n```",
    },
    insertText: "@depends-on ${1:reference}$0",
    insertTextFormat: InsertTextFormat.Snippet,
    validScopes: ["module", "feature", "requirement"] as const,
  },
  "@description": {
    label: "@description",
    kind: CompletionItemKind.Keyword,
    detail: "Add document description",
    documentation: {
      kind: MarkupKind.Markdown,
      value:
        "Adds a document-level description providing context for the requirements file.\n\n```blueprint\n@description\nThis document describes the authentication system.\n```",
    },
    insertText: "@description\n$0",
    insertTextFormat: InsertTextFormat.Snippet,
    validScopes: ["top-level"] as const,
  },
} as const;

/**
 * Type for keyword names.
 */
export type KeywordName = keyof typeof COMPLETION_KEYWORDS;

/**
 * Common language identifiers for code blocks.
 * Based on LSP language identifiers specification.
 */
export const CODE_BLOCK_LANGUAGES = [
  { id: "typescript", description: "TypeScript" },
  { id: "javascript", description: "JavaScript" },
  { id: "json", description: "JSON data format" },
  { id: "sql", description: "SQL database queries" },
  { id: "graphql", description: "GraphQL query language" },
  { id: "http", description: "HTTP request examples" },
  { id: "python", description: "Python" },
  { id: "go", description: "Go" },
  { id: "rust", description: "Rust" },
  { id: "java", description: "Java" },
  { id: "csharp", description: "C#" },
  { id: "cpp", description: "C++" },
  { id: "c", description: "C" },
  { id: "ruby", description: "Ruby" },
  { id: "php", description: "PHP" },
  { id: "swift", description: "Swift" },
  { id: "kotlin", description: "Kotlin" },
  { id: "yaml", description: "YAML configuration" },
  { id: "xml", description: "XML markup" },
  { id: "html", description: "HTML markup" },
  { id: "css", description: "CSS styles" },
  { id: "scss", description: "SCSS styles" },
  { id: "markdown", description: "Markdown" },
  { id: "bash", description: "Bash shell script" },
  { id: "shell", description: "Shell script" },
  { id: "dockerfile", description: "Dockerfile" },
] as const;

/**
 * Common description starters for @description blocks.
 * These provide templates for common documentation patterns.
 */
export const DESCRIPTION_STARTERS = [
  {
    label: "This document describes...",
    insertText: "This document describes ${1:the system/feature/component}.\n\n$0",
    detail: "Document overview template",
    documentation:
      "Template for starting a document description with an overview of what is being documented.",
  },
  {
    label: "This module provides...",
    insertText: "This module provides ${1:functionality description}.\n\n$0",
    detail: "Module description template",
    documentation: "Template for describing the primary purpose of a module.",
  },
  {
    label: "Purpose:",
    insertText: "Purpose:\n${1:Describe the main goal or objective.}\n\n$0",
    detail: "Purpose section template",
    documentation: "Template for a structured purpose section.",
  },
  {
    label: "Overview:",
    insertText: "Overview:\n${1:High-level description of the system.}\n\n$0",
    detail: "Overview section template",
    documentation: "Template for a structured overview section.",
  },
  {
    label: "Background:",
    insertText: "Background:\n${1:Context and history.}\n\n$0",
    detail: "Background section template",
    documentation: "Template for providing context and background information.",
  },
  {
    label: "Goals:",
    insertText: "Goals:\n- ${1:First goal}\n- ${2:Second goal}\n\n$0",
    detail: "Goals list template",
    documentation: "Template for listing project or feature goals.",
  },
  {
    label: "Non-Goals:",
    insertText: "Non-Goals:\n- ${1:What this does NOT cover}\n\n$0",
    detail: "Non-goals list template",
    documentation: "Template for explicitly stating what is out of scope.",
  },
  {
    label: "Requirements covered:",
    insertText: "Requirements covered:\n- ${1:Requirement category}\n\n$0",
    detail: "Requirements summary template",
    documentation: "Template for summarizing the requirements covered in this document.",
  },
] as const;

/**
 * Common action verbs for requirement naming.
 * Requirements typically follow an action-based naming pattern.
 */
export const REQUIREMENT_ACTION_VERBS = [
  { prefix: "validate", description: "Validate input or state" },
  { prefix: "create", description: "Create a new resource" },
  { prefix: "update", description: "Update an existing resource" },
  { prefix: "delete", description: "Delete/remove a resource" },
  { prefix: "get", description: "Retrieve/fetch data" },
  { prefix: "list", description: "List multiple items" },
  { prefix: "search", description: "Search for items" },
  { prefix: "filter", description: "Filter results" },
  { prefix: "authenticate", description: "Verify identity" },
  { prefix: "authorize", description: "Check permissions" },
  { prefix: "send", description: "Send a message/notification" },
  { prefix: "receive", description: "Receive data" },
  { prefix: "process", description: "Process data" },
  { prefix: "transform", description: "Transform/convert data" },
  { prefix: "encrypt", description: "Encrypt data" },
  { prefix: "decrypt", description: "Decrypt data" },
  { prefix: "store", description: "Store/persist data" },
  { prefix: "load", description: "Load data" },
  { prefix: "cache", description: "Cache data" },
  { prefix: "sync", description: "Synchronize data" },
  { prefix: "export", description: "Export data" },
  { prefix: "import", description: "Import data" },
  { prefix: "notify", description: "Send notification" },
  { prefix: "log", description: "Log activity" },
  { prefix: "handle", description: "Handle an event" },
  { prefix: "parse", description: "Parse input" },
  { prefix: "format", description: "Format output" },
  { prefix: "render", description: "Render content" },
  { prefix: "display", description: "Display to user" },
  { prefix: "connect", description: "Establish connection" },
  { prefix: "disconnect", description: "Close connection" },
  { prefix: "configure", description: "Configure settings" },
  { prefix: "initialize", description: "Initialize system/component" },
  { prefix: "reset", description: "Reset state" },
  { prefix: "retry", description: "Retry operation" },
  { prefix: "schedule", description: "Schedule task" },
  { prefix: "cancel", description: "Cancel operation" },
  { prefix: "approve", description: "Approve request" },
  { prefix: "reject", description: "Reject request" },
  { prefix: "submit", description: "Submit data" },
  { prefix: "upload", description: "Upload file" },
  { prefix: "download", description: "Download file" },
] as const;

/**
 * Naming patterns observed in codebases for identifier suggestions.
 */
export interface IdentifierPattern {
  name: string;
  count: number;
}

// ============================================================================
// Types
// ============================================================================

/**
 * The scope context for completion.
 */
export type CompletionScope = "top-level" | "module" | "feature" | "requirement";

/**
 * Context information for generating completions.
 */
export interface CompletionContext {
  /** The current scope (top-level, module, feature, or requirement) */
  scope: CompletionScope;
  /** The fully-qualified path to the current scope (e.g., "auth.login") */
  scopePath: string | null;
  /** Whether we're after an @ trigger character */
  isAfterAtTrigger: boolean;
  /** Whether we're after a . trigger character (path navigation) */
  isAfterDotTrigger: boolean;
  /** Whether we're in a @depends-on context */
  isInDependsOn: boolean;
  /** Whether we're in a @constraint context (after @constraint keyword) */
  isInConstraint: boolean;
  /** Whether we're in a @description block context (at start of line with empty/whitespace text) */
  isInDescriptionBlock: boolean;
  /** The partial text before the cursor for filtering */
  prefix: string;
  /** Whether we're inside a comment or code block (skip completion) */
  isInSkipZone: boolean;
  /** Whether we're right after opening triple backticks for code block language */
  isInCodeBlockLanguage: boolean;
  /** Current module name, if inside a module */
  currentModule: string | null;
  /** Current feature name, if inside a feature */
  currentFeature: string | null;
  /** Current requirement name, if inside a requirement */
  currentRequirement: string | null;
  /** References already present in the current @depends-on clause */
  existingReferences: string[];
  /** Whether cursor is after a comma (adding additional reference) */
  isAfterComma: boolean;
  /** Whether we're in an identifier name context (after @module/@feature/@requirement keyword) */
  isInIdentifierName: boolean;
  /** The keyword that precedes the identifier being named (module, feature, or requirement) */
  identifierKeyword: "module" | "feature" | "requirement" | null;
}

/**
 * Context for the completion handler.
 */
export interface CompletionHandlerContext {
  /** The cross-file symbol index for reference completion */
  symbolIndex: CrossFileSymbolIndex;
  /** The file URI of the document being completed */
  fileUri: string;
}

// ============================================================================
// Scope Detection
// ============================================================================

/**
 * Find the containing block node at a given position.
 * Walks up the tree to find the nearest module, feature, or requirement block.
 *
 * @param tree - The parsed tree-sitter syntax tree
 * @param position - The cursor position in the document
 * @returns The containing block node with its type, or null if at top-level
 */
export function findContainingBlock(
  tree: Tree,
  position: Position
): { node: Node; type: string } | null {
  const root = tree.rootNode;
  const deepestNode = findNodeAtPosition(root, position.line, position.character);

  if (!deepestNode) {
    return null;
  }

  // Walk up to find the containing block
  let current: Node | null = deepestNode;
  while (current) {
    if (
      current.type === "module_block" ||
      current.type === "feature_block" ||
      current.type === "requirement_block"
    ) {
      return { node: current, type: current.type };
    }
    current = current.parent;
  }

  return null;
}

/**
 * Find the deepest node at a given position.
 *
 * Uses a recursive descent through the AST to find the most specific
 * (deepest) node that contains the given position. This is essential
 * for context detection - a more specific node gives more context.
 */
function findNodeAtPosition(node: Node, line: number, column: number): Node | null {
  // Bounds check: verify position falls within this node's range
  // Tree-sitter uses 0-based row/column coordinates
  const start = node.startPosition;
  const end = node.endPosition;

  // Position is before this node starts - not contained
  if (line < start.row || (line === start.row && column < start.column)) {
    return null;
  }

  // Position is after this node ends - not contained
  if (line > end.row || (line === end.row && column > end.column)) {
    return null;
  }

  // Position is within this node - try to find a more specific child
  // Recursively descend to find the deepest containing node
  for (const child of node.children) {
    const found = findNodeAtPosition(child, line, column);
    if (found) {
      return found; // Child contains position - return the deeper result
    }
  }

  // No child contains the position, this node is the deepest match
  return node;
}

/**
 * Get the current scope based on cursor position in the tree.
 *
 * @param tree - The parsed tree-sitter syntax tree
 * @param position - The cursor position in the document
 * @returns The scope type at the cursor position (top-level, module, feature, or requirement)
 */
export function getCurrentScope(tree: Tree, position: Position): CompletionScope {
  const containingBlock = findContainingBlock(tree, position);

  if (!containingBlock) {
    return "top-level";
  }

  switch (containingBlock.type) {
    case "requirement_block":
      return "requirement";
    case "feature_block":
      return "feature";
    case "module_block":
      return "module";
    default:
      return "top-level";
  }
}

/**
 * Find the containing @depends-on node at a given position.
 * Walks up the tree to find if cursor is inside a depends_on node.
 *
 * @param tree - The parsed tree-sitter syntax tree
 * @param position - The cursor position in the document
 * @returns The depends_on node containing the cursor, or null if not in a @depends-on clause
 */
export function findContainingDependsOn(tree: Tree, position: Position): Node | null {
  const root = tree.rootNode;
  const deepestNode = findNodeAtPosition(root, position.line, position.character);

  if (!deepestNode) {
    return null;
  }

  // Walk up to find a depends_on node
  let current: Node | null = deepestNode;
  while (current) {
    if (current.type === "depends_on") {
      return current;
    }
    current = current.parent;
  }

  return null;
}

/**
 * Find the containing @description block at a given position.
 * Walks up the tree to find if cursor is inside a description_block node.
 *
 * @param tree - The parsed tree-sitter syntax tree
 * @param position - The cursor position in the document
 * @returns The description_block node containing the cursor, or null if not in a @description block
 */
export function findContainingDescriptionBlock(tree: Tree, position: Position): Node | null {
  const root = tree.rootNode;
  const deepestNode = findNodeAtPosition(root, position.line, position.character);

  if (!deepestNode) {
    return null;
  }

  // Walk up to find a description_block node
  let current: Node | null = deepestNode;
  while (current) {
    if (current.type === "description_block") {
      return current;
    }
    current = current.parent;
  }

  return null;
}

/**
 * Extract existing references from a @depends-on clause.
 * Returns an array of reference paths (e.g., ["auth.login", "storage"]).
 *
 * @param dependsOnNode - The depends_on AST node to extract references from
 * @returns Array of reference path strings found in the @depends-on clause
 */
export function extractExistingReferences(dependsOnNode: Node): string[] {
  const references: string[] = [];

  for (const child of dependsOnNode.children) {
    if (child.type === "reference") {
      // Reference text is the full dot-notation path
      references.push(child.text);
    }
  }

  return references;
}

/**
 * Get the full context for completion at a given position.
 *
 * Analyzes the cursor position to determine the completion context including:
 * - Current scope (top-level, module, feature, requirement)
 * - Trigger character context (after @, after ., in @depends-on, etc.)
 * - Partial text prefix for filtering suggestions
 * - Parent scope information for path building
 *
 * @param tree - The parsed tree-sitter syntax tree
 * @param position - The cursor position in the document
 * @param documentText - The full text content of the document
 * @returns Complete context information for generating appropriate completions
 */
export function getCursorContext(
  tree: Tree,
  position: Position,
  documentText: string
): CompletionContext {
  const scope = getCurrentScope(tree, position);
  const containingBlock = findContainingBlock(tree, position);

  // === STEP 1: Safely extract the line text before the cursor ===
  // Handle edge cases: empty documents, cursor beyond document bounds, etc.
  const lines = documentText.split("\n");

  // Clamp line index to valid range (handles cursor past end of document)
  const lineIndex = Math.max(0, Math.min(position.line, lines.length - 1));
  const currentLine = lines[lineIndex] ?? "";

  // Clamp character position to valid range within line (handles cursor past end of line)
  const charPosition = Math.max(0, Math.min(position.character, currentLine.length));
  const textBeforeCursor = currentLine.slice(0, charPosition);

  // === STEP 2: Detect trigger characters for completion dispatch ===
  // "@" trigger: user is typing a keyword like "@module", "@feature", etc.
  // Pattern: optional whitespace + @ + optional partial keyword
  const isAfterAtTrigger = /^\s*@[a-z-]*$/i.test(textBeforeCursor);
  // "." trigger: user is navigating a path like "auth.login."
  const isAfterDotTrigger = /\.$/.test(textBeforeCursor);

  // === STEP 3: Extract the prefix text for filtering completions ===
  // The prefix is the partial text the user has typed that we need to match against.
  // Regex captures: optional "@" + word characters + dots + hyphens (for paths like "auth.log")
  const prefixMatch = textBeforeCursor.match(/(@?[\w.-]*)$/);
  const prefix = prefixMatch?.[1] ?? "";

  // === STEP 4: Detect special keyword contexts ===
  // @depends-on context: user is typing a reference to another symbol
  const isInDependsOn = textBeforeCursor.includes("@depends-on");

  // @constraint context: user is typing a constraint name after the keyword
  // Matches: "@constraint " or "@constraint name" but NOT "@constraint" alone
  // (the latter is keyword completion, handled separately)
  const isInConstraint = /^\s*@constraint\s+/.test(textBeforeCursor);

  // === STEP 5: Detect @description block context for template suggestions ===
  // Description block completion should only trigger when:
  // 1. The cursor is inside a description_block AST node, OR
  // 2. The cursor is after @description but before any module (for empty descriptions)
  // AND the line is empty/whitespace-only (we don't want to be aggressive mid-sentence)
  const isAtLineStart = /^\s*$/.test(textBeforeCursor);
  let isInDescriptionBlock = false;

  if (isAtLineStart) {
    // Case 1: Check if cursor is syntactically inside a description_block
    const descriptionBlockNode = findContainingDescriptionBlock(tree, position);
    if (descriptionBlockNode !== null) {
      isInDescriptionBlock = true;
    } else {
      // Case 2: Handle empty/new descriptions not yet captured by parser
      // Look for a @description block in the document and check if cursor is
      // in the "content area" (after @description line, before first @module)
      const root = tree.rootNode;
      const descBlock = root.children.find((c) => c.type === "description_block");
      if (descBlock) {
        const descEndLine = descBlock.endPosition.row;
        const firstModuleBlock = root.children.find((c) => c.type === "module_block");
        const moduleStartLine = firstModuleBlock?.startPosition.row ?? Infinity;

        // The cursor is in the "gap" between @description end and first @module
        // This is where new description content would go
        if (position.line > descEndLine && position.line < moduleStartLine) {
          isInDescriptionBlock = true;
        }
      }
    }
  }

  // === STEP 6: Detect "skip zones" where completion should be disabled ===
  // Skip zones are areas where offering completions would be inappropriate:
  // - Inside comments (// or /* */)
  // - Inside code block content (but NOT at the language position after ```)
  const node = findNodeAtPosition(tree.rootNode, position.line, position.character);

  // Special case: right after ``` we DO want to offer language completions
  // Pattern matches: "```" or "```ts" or "```typescript" etc.
  const isInCodeBlockLanguage = /```[a-zA-Z0-9_-]*$/.test(textBeforeCursor);

  // Skip zone logic:
  // - code_content = inside the actual code content of a fenced block
  // - code_block without language position = somewhere in code block but not at lang spot
  const isInCodeBlockContent =
    node?.type === "code_content" || (node?.type === "code_block" && !isInCodeBlockLanguage);
  const isInSkipZone = node?.type === "comment" || isInCodeBlockContent;

  // === STEP 7: Parse @depends-on clause to track existing references ===
  // We need to know what references are already in the clause so we:
  // 1. Don't suggest duplicates
  // 2. Can detect comma position for multi-reference completion
  let existingReferences: string[] = [];
  let isAfterComma = false;

  if (isInDependsOn) {
    // Strategy: Combine tree-based extraction with text parsing
    // The tree gives us complete, validated references
    // Text parsing catches in-progress references the tree may not have yet
    const dependsOnNode = findContainingDependsOn(tree, position);
    if (dependsOnNode) {
      existingReferences = extractExistingReferences(dependsOnNode);
    }

    // Text-based fallback for incomplete/in-progress references
    // Example: "@depends-on ref1, ref2, " -> ["ref1", "ref2"]
    const dependsOnMatch = textBeforeCursor.match(/@depends-on\s+(.*)$/);
    if (dependsOnMatch && dependsOnMatch[1]) {
      const refsText = dependsOnMatch[1];
      // Split by comma, trim whitespace, filter out empty strings and incomplete paths
      // (incomplete paths end with "." like "auth." - user is still typing)
      const textRefs = refsText
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0 && !r.endsWith("."));

      // Merge text-based refs with tree-based refs, avoiding duplicates
      // Don't include the current prefix (that's what we're completing)
      for (const ref of textRefs) {
        if (!existingReferences.includes(ref) && ref !== prefix) {
          existingReferences.push(ref);
        }
      }
    }

    // Detect comma position for multi-reference scenarios
    // Pattern: comma followed by optional whitespace and optional partial reference
    isAfterComma = /,\s*[\w.-]*$/.test(textBeforeCursor);
  }

  // === STEP 8: Detect identifier naming context ===
  // When user is naming a new symbol (e.g., "@module auth", "@feature login")
  // we can suggest naming patterns based on conventions and workspace examples.
  // Pattern: keyword + space + partial name (NOT just the keyword alone)
  let isInIdentifierName = false;
  let identifierKeyword: "module" | "feature" | "requirement" | null = null;

  const moduleMatch = /^\s*@module\s+/.test(textBeforeCursor);
  const featureMatch = /^\s*@feature\s+/.test(textBeforeCursor);
  const requirementMatch = /^\s*@requirement\s+/.test(textBeforeCursor);

  // Determine which keyword we're in, but exclude @depends-on and @constraint
  // contexts which have their own specialized completion
  if (moduleMatch && !isInDependsOn && !isInConstraint) {
    isInIdentifierName = true;
    identifierKeyword = "module";
  } else if (featureMatch && !isInDependsOn && !isInConstraint) {
    isInIdentifierName = true;
    identifierKeyword = "feature";
  } else if (requirementMatch && !isInDependsOn && !isInConstraint) {
    isInIdentifierName = true;
    identifierKeyword = "requirement";
  }

  // === STEP 9: Extract hierarchical scope information ===
  // We need to know the current module/feature/requirement names to:
  // 1. Filter out self-references in @depends-on
  // 2. Provide contextual suggestions
  // 3. Build the fully-qualified scope path
  let currentModule: string | null = null;
  let currentFeature: string | null = null;
  let currentRequirement: string | null = null;
  let scopePath: string | null = null;

  if (containingBlock) {
    // Walk up the AST from the containing block to collect all ancestor names
    // We visit each ancestor type only once (first match wins - closest scope)
    let current: Node | null = containingBlock.node;
    while (current) {
      if (current.type === "requirement_block" && !currentRequirement) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) currentRequirement = nameNode.text;
      }
      if (current.type === "feature_block" && !currentFeature) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) currentFeature = nameNode.text;
      }
      if (current.type === "module_block" && !currentModule) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) currentModule = nameNode.text;
      }
      current = current.parent;
    }
  }

  // === STEP 10: Fallback scope detection for incomplete AST ===
  // When typing a new identifier (e.g., "@requirement " at end of file),
  // the tree-sitter parser may not have captured the containing block yet.
  // We use heuristics to determine the parent scope based on document structure.
  if (isInIdentifierName && !containingBlock) {
    const root = tree.rootNode;

    // Scan top-level blocks to find which one "contains" our cursor position
    // A block "contains" the cursor if:
    // 1. Cursor is within the block's line range, OR
    // 2. Cursor is on the line immediately after the block (adjacent continuation)
    for (const child of root.children) {
      if (child.type === "module_block") {
        const moduleNameNode = child.childForFieldName("name");
        const moduleName = moduleNameNode?.text;

        // Check positional containment with tolerance for adjacent lines
        // This handles the case where we're typing at the end of a module
        if (
          child.startPosition.row <= position.line &&
          (child.endPosition.row >= position.line ||
            child.endPosition.row === position.line - 1 ||
            (child.endPosition.row === position.line &&
              child.endPosition.column < position.character))
        ) {
          currentModule = moduleName ?? null;

          // Recursively check for containing feature within this module
          for (const moduleChild of child.children) {
            if (moduleChild.type === "feature_block") {
              const featureNameNode = moduleChild.childForFieldName("name");
              const featureName = featureNameNode?.text;

              // Same containment logic for features
              if (
                moduleChild.startPosition.row <= position.line &&
                (moduleChild.endPosition.row >= position.line ||
                  moduleChild.endPosition.row === position.line - 1 ||
                  (moduleChild.endPosition.row === position.line &&
                    moduleChild.endPosition.column < position.character))
              ) {
                currentFeature = featureName ?? null;
              }
            }
          }
        }
      }
    }
  }

  // === STEP 11: Construct fully-qualified scope path ===
  // The scope path is used for filtering (e.g., can't @depends-on yourself)
  // Format: "module.feature.requirement" or partial path
  if (currentModule) {
    scopePath = currentModule;
    if (currentFeature) {
      scopePath += `.${currentFeature}`;
      if (currentRequirement) {
        scopePath += `.${currentRequirement}`;
      }
    } else if (currentRequirement) {
      // Requirement directly under module (no feature)
      scopePath += `.${currentRequirement}`;
    }
  }

  return {
    scope,
    scopePath,
    isAfterAtTrigger,
    isAfterDotTrigger,
    isInDependsOn,
    isInConstraint,
    isInDescriptionBlock,
    prefix,
    isInSkipZone,
    isInCodeBlockLanguage,
    currentModule,
    currentFeature,
    currentRequirement,
    existingReferences,
    isAfterComma,
    isInIdentifierName,
    identifierKeyword,
  };
}

// ============================================================================
// Keyword Completion
// ============================================================================

/**
 * Check if a keyword is valid in the given scope.
 *
 * Each Blueprint keyword has specific valid contexts where it can appear.
 * For example, @module is only valid at top-level, while @constraint
 * can appear within modules, features, or requirements.
 *
 * @param keyword - The keyword name to check (e.g., "@module", "@feature")
 * @param scope - The current scope context
 * @returns True if the keyword is valid in the given scope, false otherwise
 */
export function isKeywordValidInScope(keyword: KeywordName, scope: CompletionScope): boolean {
  const keywordMeta = COMPLETION_KEYWORDS[keyword];
  return (keywordMeta.validScopes as readonly string[]).includes(scope);
}

/**
 * Get keyword completions filtered by scope and prefix.
 *
 * Returns completion items for Blueprint keywords that are valid in the
 * current scope and match the typed prefix. Each completion item includes
 * a snippet template for easy insertion.
 *
 * @param scope - The current scope context (top-level, module, feature, requirement)
 * @param prefix - The partial text typed by the user for filtering
 * @returns Array of keyword completion items valid for the current context
 */
export function getKeywordCompletions(scope: CompletionScope, prefix: string): CompletionItem[] {
  const completions: CompletionItem[] = [];

  for (const [name, meta] of Object.entries(COMPLETION_KEYWORDS)) {
    // Check if valid in current scope
    if (!isKeywordValidInScope(name as KeywordName, scope)) {
      continue;
    }

    // Check prefix filter
    if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) {
      continue;
    }

    completions.push({
      label: meta.label,
      kind: meta.kind,
      detail: meta.detail,
      documentation: meta.documentation,
      insertText: meta.insertText,
      insertTextFormat: meta.insertTextFormat,
    });
  }

  return completions;
}

// ============================================================================
// Reference Matching and Scoring
// ============================================================================

/**
 * Check if a symbol matches a query string for reference completion.
 *
 * Matching is case-insensitive and supports:
 * - Prefix matching (query matches start of name or path)
 * - Substring matching (query is contained in name or path)
 * - Fuzzy matching (query characters appear in order in name)
 *
 * @param symbol - The indexed symbol to check against the query
 * @param query - The search query string (empty query matches all symbols)
 * @returns True if the symbol matches the query, false otherwise
 */
export function matchesReferenceQuery(symbol: IndexedSymbol, query: string): boolean {
  // Empty query = show all results (no filter)
  if (!query) {
    return true;
  }

  // Case-insensitive matching throughout
  const lowerQuery = query.toLowerCase();
  const name = symbol.node.name?.toLowerCase() ?? "";
  const path = symbol.path.toLowerCase();

  // Match tier 1: Name prefix match (strongest relevance)
  // Example: "log" matches "login", "logout"
  if (name.startsWith(lowerQuery)) {
    return true;
  }

  // Match tier 2: Name substring match
  // Example: "auth" matches "authenticate", "oauth"
  if (name.includes(lowerQuery)) {
    return true;
  }

  // Match tier 3: Full path substring match
  // Example: "auth" matches "security.auth.login"
  if (path.includes(lowerQuery)) {
    return true;
  }

  // Match tier 4: Fuzzy matching - characters appear in order
  // Example: "vl" matches "validate" (v-a-l-i-d-a-t-e)
  // This is a simple sequential character matching algorithm
  let queryIdx = 0;
  for (let i = 0; i < name.length && queryIdx < lowerQuery.length; i++) {
    if (name[i] === lowerQuery[queryIdx]) {
      queryIdx++; // Found next query character, advance
    }
  }
  // If we matched all query characters, it's a fuzzy match
  if (queryIdx === lowerQuery.length) {
    return true;
  }

  return false;
}

/**
 * Calculate a relevance score for sorting reference completion results.
 * Higher scores are better matches.
 *
 * Scoring tiers:
 * - 100: Exact match on name
 * - 80-90: Prefix match on name
 * - 70: Exact match on path segment
 * - 50-60: Substring match on name (earlier position is better)
 * - 40: Substring match on path
 * - 20: Fuzzy match (fallback)
 *
 * @param symbol - The indexed symbol to score
 * @param query - The search query to score against
 * @returns A numeric score (0-100) indicating match quality, higher is better
 */
export function calculateReferenceScore(symbol: IndexedSymbol, query: string): number {
  // No query = no preference (neutral score)
  if (!query) {
    return 0;
  }

  const lowerQuery = query.toLowerCase();
  const name = symbol.node.name?.toLowerCase() ?? "";
  const path = symbol.path.toLowerCase();

  // === SCORING TIERS ===
  // Higher score = better match, shown first in completion list

  // Tier 1 (100): Exact name match - user typed the complete name
  if (name === lowerQuery) {
    return 100;
  }

  // Tier 2 (80-90): Prefix match on name - user is typing the start
  // Score increases with query coverage (longer prefix = closer to exact)
  // Formula: 80 base + up to 10 bonus for coverage ratio
  if (name.startsWith(lowerQuery)) {
    return 80 + (lowerQuery.length / name.length) * 10;
  }

  // Tier 3 (70): Exact match on a path segment
  // Example: "login" exactly matches "auth.login.validate"
  const pathParts = path.split(".");
  if (pathParts.includes(lowerQuery)) {
    return 70;
  }

  // Tier 4 (50-60): Substring match on name
  // Earlier positions score higher (searching for "auth" in "oauth" vs "authenticate")
  const nameIdx = name.indexOf(lowerQuery);
  if (nameIdx !== -1) {
    // 60 base, minus position penalty (max 10 penalty)
    return 60 - Math.min(nameIdx, 10);
  }

  // Tier 5 (40): Substring match on full path
  if (path.includes(lowerQuery)) {
    return 40;
  }

  // Tier 6 (20): Fuzzy match fallback - weakest relevance
  return 20;
}

// ============================================================================
// Reference Completion (for @depends-on)
// ============================================================================

/**
 * Get reference completions for @depends-on context.
 * Returns symbols from the symbol index that can be referenced.
 *
 * Uses fuzzy matching and scoring to rank results:
 * - exact match > prefix match > substring match > fuzzy match
 * - Local symbols (same file) are boosted in ranking
 *
 * Also filters out:
 * - Self-references (cannot depend on yourself)
 * - Circular dependencies
 * - References already in the current @depends-on clause
 *
 * @param context - The completion context with prefix and scope information
 * @param handlerContext - Context containing the symbol index and current file URI
 * @returns Array of completion items for referenceable symbols (limited to 50)
 */
export function getReferenceCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex, fileUri } = handlerContext;
  const { prefix, scopePath, existingReferences } = context;

  // === PHASE 1: Gather candidate symbols ===
  // Only modules, features, and requirements can be referenced in @depends-on
  // Constraints cannot be referenced directly
  const allSymbols = [
    ...symbolIndex.getSymbolsByKind("module"),
    ...symbolIndex.getSymbolsByKind("feature"),
    ...symbolIndex.getSymbolsByKind("requirement"),
  ];

  // Deduplication tracking - symbols may appear in multiple files
  const addedPaths = new Set<string>();

  // Fast lookup for already-referenced symbols (to avoid suggesting duplicates)
  const existingRefSet = new Set(existingReferences);

  // === PHASE 2: Filter and score symbols ===
  // Apply multiple filtering criteria and calculate relevance scores
  const scoredSymbols: Array<{ symbol: IndexedSymbol; score: number; isLocal: boolean }> = [];

  for (const symbol of allSymbols) {
    const path = symbol.path;

    // Filter 1: Deduplication - skip if we've already processed this path
    if (addedPaths.has(path)) {
      continue;
    }

    // Filter 2: Existing references - don't suggest what's already in the clause
    if (existingRefSet.has(path)) {
      continue;
    }

    // Filter 3: Self-reference prevention - can't depend on yourself or children
    // Using startsWith catches both exact match and child paths (auth.login under auth)
    if (scopePath && path.startsWith(scopePath)) {
      continue;
    }

    // Filter 4: Circular dependency detection - check if adding this dependency
    // would create a cycle (A depends on B, B depends on C, C depends on A)
    if (scopePath && symbolIndex.wouldCreateCircularDependency(scopePath, path)) {
      continue;
    }

    // Filter 5: Query matching - use fuzzy matching against the typed prefix
    if (!matchesReferenceQuery(symbol, prefix)) {
      continue;
    }

    // Calculate relevance score for sorting (higher = better match)
    const score = calculateReferenceScore(symbol, prefix);
    // Track locality - local symbols (same file) get boosted in ranking
    const isLocal = symbol.fileUri === fileUri;

    scoredSymbols.push({ symbol, score, isLocal });
    addedPaths.add(path);
  }

  // === PHASE 3: Sort results by relevance ===
  // Sort order priority: local > remote, then score (descending), then alphabetical
  scoredSymbols.sort((a, b) => {
    // Primary: Local symbols come first (same file = likely more relevant)
    if (a.isLocal !== b.isLocal) {
      return a.isLocal ? -1 : 1;
    }

    // Secondary: Higher score = better match (exact > prefix > substring > fuzzy)
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    // Tertiary: Alphabetical by path for deterministic ordering
    return a.symbol.path.localeCompare(b.symbol.path);
  });

  // === PHASE 4: Convert to CompletionItems ===
  const completions: CompletionItem[] = [];

  // Limit to 50 results to keep the completion list manageable
  for (let i = 0; i < scoredSymbols.length && i < 50; i++) {
    const entry = scoredSymbols[i]!;
    const { symbol, isLocal } = entry;
    const path = symbol.path;

    // Map Blueprint symbol kinds to LSP CompletionItemKind
    // These icons help users visually distinguish between symbol types
    let kind: CompletionItemKind;
    switch (symbol.kind) {
      case "module":
        kind = CompletionItemKind.Module; // folder-like icon
        break;
      case "feature":
        kind = CompletionItemKind.Class; // class icon (features are like classes)
        break;
      case "requirement":
        kind = CompletionItemKind.Function; // function icon (requirements are actionable)
        break;
      default:
        kind = CompletionItemKind.Reference;
    }

    const fileName = symbol.fileUri.split("/").pop() ?? symbol.fileUri;

    // Extract description for documentation preview (if available in AST)
    const description =
      "description" in symbol.node && symbol.node.description ? symbol.node.description : undefined;

    // sortText controls the display order in the completion menu
    // Format: "L" + 4-digit index where L=0 for local, L=1 for remote
    // This preserves our carefully computed sort order
    const sortText = `${isLocal ? "0" : "1"}${String(i).padStart(4, "0")}`;

    const item: CompletionItem = {
      label: path,
      kind,
      detail: `${symbol.kind} in ${fileName}`,
      sortText,
      filterText: path,
    };

    // Add documentation if description is available
    if (description) {
      item.documentation = {
        kind: MarkupKind.Markdown,
        value: description,
      };
    }

    completions.push(item);
  }

  return completions;
}

// ============================================================================
// Path Completion (dot navigation)
// ============================================================================

/**
 * Get child symbol completions for path navigation (after a dot).
 *
 * When the user types "auth." this function returns all direct children
 * of the "auth" module (features, requirements under that module).
 * Only returns one level of children - nested paths require additional dots.
 *
 * @param context - The completion context with the path prefix (e.g., "auth.")
 * @param handlerContext - Context containing the symbol index
 * @returns Array of completion items for direct child symbols of the parent path
 */
export function getPathCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex } = handlerContext;
  const { prefix } = context;
  const completions: CompletionItem[] = [];

  // Parse the parent path from the prefix (everything before the last dot)
  // Example: "auth.login." -> parentPath = "auth.login"
  const parentPathMatch = prefix.match(/^(.+)\./);
  if (!parentPathMatch || !parentPathMatch[1]) {
    return completions; // No valid parent path - can't do path completion
  }

  const parentPath = parentPathMatch[1];

  // Gather all symbol types that can be children in paths
  // Constraints are included here because they can appear in paths too
  const allSymbols = [
    ...symbolIndex.getSymbolsByKind("module"),
    ...symbolIndex.getSymbolsByKind("feature"),
    ...symbolIndex.getSymbolsByKind("requirement"),
    ...symbolIndex.getSymbolsByKind("constraint"),
  ];

  // Deduplication - a child name should only appear once
  const addedPaths = new Set<string>();

  for (const symbol of allSymbols) {
    const path = symbol.path;

    // Check if this symbol is a child of the parent path
    // Must start with "parentPath." to be a child (not just prefix match)
    if (!path.startsWith(parentPath + ".")) {
      continue;
    }

    // Extract the remaining path segment after the parent
    // Example: "auth.login.validate" with parent "auth.login" -> "validate"
    const remainingPath = path.slice(parentPath.length + 1);

    // Only show direct children (single segment, no dots)
    // Grandchildren should require another dot to navigate to
    if (remainingPath.includes(".")) {
      continue;
    }

    // Deduplication check
    if (addedPaths.has(remainingPath)) {
      continue;
    }

    // Map symbol kind to CompletionItemKind
    let kind: CompletionItemKind;
    switch (symbol.kind) {
      case "module":
        kind = CompletionItemKind.Module;
        break;
      case "feature":
        kind = CompletionItemKind.Class;
        break;
      case "requirement":
        kind = CompletionItemKind.Function;
        break;
      case "constraint":
        kind = CompletionItemKind.Property;
        break;
      default:
        kind = CompletionItemKind.Reference;
    }

    // Extract description from the symbol's AST node if available
    const description =
      "description" in symbol.node && symbol.node.description ? symbol.node.description : undefined;

    const item: CompletionItem = {
      label: remainingPath,
      kind,
      detail: `${symbol.kind}`,
      insertText: remainingPath,
    };

    // Add documentation if description is available
    if (description) {
      item.documentation = {
        kind: MarkupKind.Markdown,
        value: description,
      };
    }

    completions.push(item);

    addedPaths.add(remainingPath);
  }

  return completions;
}

// ============================================================================
// Constraint Name Completion
// ============================================================================

/**
 * Represents a constraint name with its usage frequency.
 */
interface ConstraintNameFrequency {
  name: string;
  count: number;
}

/**
 * Collect all unique constraint names from the symbol index with their usage frequency.
 * This allows suggesting common constraint patterns to users.
 *
 * @param symbolIndex - The cross-file symbol index to query for constraint symbols
 * @returns Array of constraint names with their usage counts, sorted by frequency (descending)
 */
export function collectConstraintNames(
  symbolIndex: CrossFileSymbolIndex
): ConstraintNameFrequency[] {
  const nameFrequency = new Map<string, number>();

  // Get all constraint symbols
  const constraints = symbolIndex.getSymbolsByKind("constraint");

  for (const constraint of constraints) {
    // Extract just the name (last segment of the path)
    const name = constraint.node.name;
    if (name) {
      nameFrequency.set(name, (nameFrequency.get(name) ?? 0) + 1);
    }
  }

  // Convert to array and sort by frequency (descending), then alphabetically
  const result: ConstraintNameFrequency[] = [];
  for (const [name, count] of nameFrequency) {
    result.push({ name, count });
  }

  result.sort((a, b) => {
    // Higher frequency first
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    // Alphabetical as tiebreaker
    return a.name.localeCompare(b.name);
  });

  return result;
}

/**
 * Get constraint name completions for @constraint context.
 * Suggests common constraint names from the workspace, ranked by frequency.
 *
 * @param context The completion context
 * @param handlerContext Context with symbol index
 * @returns Array of completion items for constraint names
 */
export function getConstraintNameCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex } = handlerContext;
  const { prefix } = context;

  // Extract the constraint name prefix (text after "@constraint ")
  const constraintPrefix = prefix.replace(/^@constraint\s*/, "");

  // Get all constraint names with their frequency
  const constraintNames = collectConstraintNames(symbolIndex);

  // Filter by prefix if there's a partial name
  const filtered = constraintNames.filter(({ name }) => {
    if (!constraintPrefix) {
      return true;
    }
    return name.toLowerCase().startsWith(constraintPrefix.toLowerCase());
  });

  // Limit to reasonable count
  const limited = filtered.slice(0, 30);

  // Convert to CompletionItems
  const completions: CompletionItem[] = [];

  for (let i = 0; i < limited.length; i++) {
    const entry = limited[i]!;
    const { name, count } = entry;

    // Use sortText to preserve the sorted order (by frequency)
    const sortText = String(i).padStart(4, "0");

    const item: CompletionItem = {
      label: name,
      kind: CompletionItemKind.Property,
      detail: `Used ${count} time${count === 1 ? "" : "s"} in workspace`,
      sortText,
      filterText: name,
      // Insert just the name (the @constraint keyword is already typed)
      insertText: name,
    };

    completions.push(item);
  }

  return completions;
}

// ============================================================================
// Identifier Name Completion
// ============================================================================

/**
 * Extract identifier name prefix from the text before cursor.
 * E.g., "@module auth" -> "auth", "@feature log" -> "log"
 *
 * @param prefix The full prefix from context
 * @param keyword The keyword type (module, feature, requirement)
 * @returns The identifier name portion after the keyword
 */
function extractIdentifierPrefix(prefix: string, keyword: string): string {
  const regex = new RegExp(`^@${keyword}\\s*`, "i");
  return prefix.replace(regex, "");
}

/**
 * Collect existing identifier names of a given kind from the symbol index.
 * This is used to learn from existing naming patterns in the workspace.
 *
 * @param symbolIndex The cross-file symbol index
 * @param kind The symbol kind to collect names for
 * @returns Array of unique names with their usage frequency, sorted by frequency
 */
export function collectIdentifierNames(
  symbolIndex: CrossFileSymbolIndex,
  kind: "module" | "feature" | "requirement"
): IdentifierPattern[] {
  const nameFrequency = new Map<string, number>();

  // Get all symbols of the specified kind
  const symbols = symbolIndex.getSymbolsByKind(kind);

  for (const symbol of symbols) {
    const name = symbol.node.name;
    if (name) {
      nameFrequency.set(name, (nameFrequency.get(name) ?? 0) + 1);
    }
  }

  // Convert to array and sort by frequency (descending), then alphabetically
  const result: IdentifierPattern[] = [];
  for (const [name, count] of nameFrequency) {
    result.push({ name, count });
  }

  result.sort((a, b) => {
    // Higher frequency first
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    // Alphabetical as tiebreaker
    return a.name.localeCompare(b.name);
  });

  return result;
}

/**
 * Get identifier name completions based on context and existing patterns.
 * Provides suggestions for naming modules, features, and requirements.
 *
 * For requirements inside features, suggests action-based names.
 * Also learns from existing naming patterns in the workspace.
 *
 * @param context The completion context
 * @param handlerContext Context with symbol index
 * @returns Array of completion items for identifier names
 */
export function getIdentifierNameCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex } = handlerContext;
  const { prefix, identifierKeyword, currentModule } = context;

  if (!identifierKeyword) {
    return [];
  }

  const completions: CompletionItem[] = [];

  // Extract the identifier name prefix (text after the keyword)
  const identifierPrefix = extractIdentifierPrefix(prefix, identifierKeyword);
  const lowerPrefix = identifierPrefix.toLowerCase();

  // Track added names to avoid duplicates
  const addedNames = new Set<string>();

  // For requirements, prioritize action-based name suggestions
  if (identifierKeyword === "requirement") {
    // Suggest action verb prefixes that match
    for (let i = 0; i < REQUIREMENT_ACTION_VERBS.length; i++) {
      const { prefix: verbPrefix, description } = REQUIREMENT_ACTION_VERBS[i]!;

      // Filter by typed prefix
      if (lowerPrefix && !verbPrefix.startsWith(lowerPrefix)) {
        continue;
      }

      // Skip if already added
      if (addedNames.has(verbPrefix)) {
        continue;
      }

      // Create snippet with placeholder for the noun part
      const snippetText = `${verbPrefix}-\${1:object}`;
      const sortText = String(i).padStart(4, "0");

      const item: CompletionItem = {
        label: `${verbPrefix}-...`,
        kind: CompletionItemKind.Value,
        detail: description,
        sortText,
        filterText: verbPrefix,
        insertText: snippetText,
        insertTextFormat: InsertTextFormat.Snippet,
        documentation: {
          kind: MarkupKind.Markdown,
          value: `**Action pattern:** \`${verbPrefix}-<object>\`\n\n${description}.\n\n**Examples:**\n- \`${verbPrefix}-credentials\`\n- \`${verbPrefix}-session\`\n- \`${verbPrefix}-data\``,
        },
      };

      completions.push(item);
      addedNames.add(verbPrefix);
    }
  }

  // Learn from existing names in the workspace
  const existingNames = collectIdentifierNames(symbolIndex, identifierKeyword);

  // Add existing names as suggestions (after action verbs for requirements)
  const baseIndex = completions.length;
  for (let i = 0; i < existingNames.length && i < 20; i++) {
    const { name, count } = existingNames[i]!;

    // Filter by typed prefix
    if (lowerPrefix && !name.toLowerCase().startsWith(lowerPrefix)) {
      continue;
    }

    // Skip if already added (e.g., from action verbs)
    if (addedNames.has(name)) {
      continue;
    }

    // Sort after action verbs
    const sortText = `1${String(baseIndex + i).padStart(4, "0")}`;

    const item: CompletionItem = {
      label: name,
      kind: CompletionItemKind.Value,
      detail: `Used ${count} time${count === 1 ? "" : "s"} in workspace`,
      sortText,
      filterText: name,
      insertText: name,
    };

    completions.push(item);
    addedNames.add(name);
  }

  // Add contextual suggestions based on parent scope
  if (identifierKeyword === "feature" && currentModule) {
    // Suggest feature names based on common patterns
    const contextualSuggestions = [
      { name: "create", description: "Create operations for the module" },
      { name: "read", description: "Read/query operations" },
      { name: "update", description: "Update operations" },
      { name: "delete", description: "Delete operations" },
      { name: "list", description: "List/browse operations" },
      { name: "search", description: "Search functionality" },
      { name: "settings", description: "Configuration/settings" },
      { name: "admin", description: "Administrative functions" },
    ];

    const ctxBaseIndex = completions.length;
    for (let i = 0; i < contextualSuggestions.length; i++) {
      const { name, description } = contextualSuggestions[i]!;

      // Filter by typed prefix
      if (lowerPrefix && !name.toLowerCase().startsWith(lowerPrefix)) {
        continue;
      }

      // Skip if already added
      if (addedNames.has(name)) {
        continue;
      }

      // Sort after workspace patterns
      const sortText = `2${String(ctxBaseIndex + i).padStart(4, "0")}`;

      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Value,
        detail: description,
        sortText,
        filterText: name,
        insertText: name,
        documentation: {
          kind: MarkupKind.Markdown,
          value: `Common feature pattern: \`${name}\`\n\n${description}`,
        },
      };

      completions.push(item);
      addedNames.add(name);
    }
  }

  return completions;
}

// ============================================================================
// Code Block Language Completion
// ============================================================================

/**
 * Get code block language completions for positions right after triple backticks.
 * Suggests common language identifiers used in fenced code blocks.
 *
 * @param context The completion context
 * @returns Array of completion items for language identifiers
 */
export function getCodeBlockLanguageCompletions(context: CompletionContext): CompletionItem[] {
  const { prefix } = context;

  // Extract the language prefix (text after ```)
  const languagePrefix = prefix.replace(/^.*```/, "").toLowerCase();

  // Filter languages by prefix
  const filtered = CODE_BLOCK_LANGUAGES.filter(({ id }) => {
    if (!languagePrefix) {
      return true;
    }
    return id.toLowerCase().startsWith(languagePrefix);
  });

  // Convert to CompletionItems
  const completions: CompletionItem[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const { id, description } = filtered[i]!;

    // Use sortText to preserve alphabetical order
    const sortText = String(i).padStart(4, "0");

    const item: CompletionItem = {
      label: id,
      kind: CompletionItemKind.Enum,
      detail: description,
      sortText,
      filterText: id,
      insertText: id,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `Language identifier for ${description} code blocks.\n\n\`\`\`\`blueprint\n\`\`\`${id}\n// ${description} code here\n\`\`\`\n\`\`\`\``,
      },
    };

    completions.push(item);
  }

  return completions;
}

// ============================================================================
// Description Block Completion
// ============================================================================

/**
 * Get description starter completions for @description block context.
 * Suggests common documentation templates for starting descriptions.
 * Only provides completions at the start of a line (empty or whitespace only).
 *
 * @param context The completion context
 * @returns Array of completion items for description starters
 */
export function getDescriptionCompletions(context: CompletionContext): CompletionItem[] {
  const { prefix } = context;

  // Only show suggestions when at the start of a line (empty prefix)
  // This implements "no aggressive completion inside description text"
  if (prefix.trim().length > 0) {
    return [];
  }

  // Convert to CompletionItems
  const completions: CompletionItem[] = [];

  for (let i = 0; i < DESCRIPTION_STARTERS.length; i++) {
    const starter = DESCRIPTION_STARTERS[i]!;

    // Use sortText to preserve defined order
    const sortText = String(i).padStart(4, "0");

    const item: CompletionItem = {
      label: starter.label,
      kind: CompletionItemKind.Snippet,
      detail: starter.detail,
      sortText,
      filterText: starter.label,
      insertText: starter.insertText,
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: {
        kind: MarkupKind.Markdown,
        value: starter.documentation,
      },
    };

    completions.push(item);
  }

  return completions;
}

// ============================================================================
// Main Completion Handler
// ============================================================================

/**
 * Build completion items for a Blueprint document at the given position.
 *
 * @param tree The parsed tree-sitter tree
 * @param params The completion request parameters
 * @param documentText The full document text
 * @param handlerContext Context with symbol index and file URI
 * @returns CompletionList or null if no completions available
 */
export function buildCompletions(
  tree: Tree,
  params: CompletionParams,
  documentText: string,
  handlerContext: CompletionHandlerContext
): CompletionList | null {
  const position = params.position;

  // Analyze cursor position to determine completion context
  const context = getCursorContext(tree, position, documentText);

  // Early exit for zones where completion is inappropriate
  if (context.isInSkipZone) {
    return null;
  }

  const items: CompletionItem[] = [];

  // === COMPLETION DISPATCH ===
  // Order matters! More specific contexts are checked first.
  // Each context is mutually exclusive (else-if chain).

  // Priority 1: Code block language (after ```) - most specific trigger
  if (context.isInCodeBlockLanguage) {
    items.push(...getCodeBlockLanguageCompletions(context));
  }
  // Priority 2: Description block templates (at start of line in @description)
  else if (context.isInDescriptionBlock) {
    items.push(...getDescriptionCompletions(context));
  }
  // Priority 3: Path navigation (after a dot like "auth.") - dot trigger
  else if (context.isAfterDotTrigger) {
    items.push(...getPathCompletions(context, handlerContext));
  }
  // Priority 4: Constraint names (after "@constraint ") - keyword-specific
  // Note: !isAfterAtTrigger excludes "@const" partial keyword matches
  else if (context.isInConstraint && !context.isAfterAtTrigger) {
    items.push(...getConstraintNameCompletions(context, handlerContext));
  }
  // Priority 5: References for @depends-on (symbol path completion)
  else if (context.isInDependsOn && !context.isAfterAtTrigger) {
    items.push(...getReferenceCompletions(context, handlerContext));
  }
  // Priority 6: Identifier names (after "@module ", "@feature ", "@requirement ")
  else if (context.isInIdentifierName && !context.isAfterAtTrigger) {
    items.push(...getIdentifierNameCompletions(context, handlerContext));
  }
  // Priority 7: Keywords (after @ or at empty line start)
  else if (context.isAfterAtTrigger || context.prefix === "" || context.prefix.startsWith("@")) {
    items.push(...getKeywordCompletions(context.scope, context.prefix));
  }
  // Priority 8: Fallback - reference completion for any other context
  else {
    items.push(...getReferenceCompletions(context, handlerContext));
  }

  if (items.length === 0) {
    return null;
  }

  return {
    isIncomplete: false,
    items,
  };
}

/**
 * Build rich documentation content for a symbol.
 * This includes description, dependencies, constraints, and file location.
 *
 * @param symbol The indexed symbol to document
 * @returns Markdown formatted documentation string
 */
function buildSymbolDocumentation(symbol: IndexedSymbol): string {
  const lines: string[] = [];
  const node = symbol.node;

  // Header with symbol kind and name
  const kindLabel = symbol.kind.charAt(0).toUpperCase() + symbol.kind.slice(1);
  lines.push(`**${kindLabel}** \`${symbol.path}\``);
  lines.push("");

  // Description
  if ("description" in node && node.description) {
    lines.push(node.description);
    lines.push("");
  }

  // Dependencies (for modules, features, requirements)
  if ("dependencies" in node && node.dependencies.length > 0) {
    const depCount = node.dependencies.reduce((sum, dep) => sum + dep.references.length, 0);
    lines.push(`**Dependencies:** ${depCount}`);
    for (const dep of node.dependencies) {
      for (const ref of dep.references) {
        lines.push(`- \`${ref.path}\``);
      }
    }
    lines.push("");
  }

  // Constraints (for modules, features, requirements)
  if ("constraints" in node && node.constraints.length > 0) {
    lines.push(`**Constraints:** ${node.constraints.length}`);
    for (const constraint of node.constraints) {
      if (constraint.description) {
        lines.push(`- \`${constraint.name}\`: ${constraint.description}`);
      } else {
        lines.push(`- \`${constraint.name}\``);
      }
    }
    lines.push("");
  }

  // Child counts for containers
  if (symbol.kind === "module" && "features" in node) {
    const featureCount = node.features.length;
    const reqCount =
      node.requirements.length + node.features.reduce((sum, f) => sum + f.requirements.length, 0);
    if (featureCount > 0 || reqCount > 0) {
      lines.push(`**Contains:** ${featureCount} features, ${reqCount} requirements`);
      lines.push("");
    }
  } else if (symbol.kind === "feature" && "requirements" in node) {
    const reqCount = node.requirements.length;
    if (reqCount > 0) {
      lines.push(`**Contains:** ${reqCount} requirements`);
      lines.push("");
    }
  }

  // File location
  const fileName = symbol.fileUri.split("/").pop() ?? symbol.fileUri;
  const startLine = node.location.startLine + 1; // Convert to 1-based
  lines.push(`*Defined in [${fileName}](${symbol.fileUri}#L${startLine})*`);

  return lines.join("\n");
}

/**
 * Resolve additional details for a completion item.
 * This is called when a completion item is focused in the UI.
 *
 * Implements lazy documentation loading - full documentation including
 * description, dependencies, constraints, and file location is only
 * fetched when the item is selected, reducing initial completion latency.
 *
 * @param item The completion item to resolve
 * @param handlerContext Context with symbol index
 * @returns The resolved completion item with additional details
 */
export function resolveCompletionItem(
  item: CompletionItem,
  handlerContext: CompletionHandlerContext
): CompletionItem {
  // Only resolve reference completions (Module, Class/Feature, Function/Requirement)
  if (
    item.kind === CompletionItemKind.Module ||
    item.kind === CompletionItemKind.Class ||
    item.kind === CompletionItemKind.Function
  ) {
    const { symbolIndex } = handlerContext;
    const symbols = symbolIndex.getSymbol(item.label);
    const symbol = symbols?.[0];

    if (symbol) {
      // Build rich documentation with all symbol details
      const documentation = buildSymbolDocumentation(symbol);
      item.documentation = {
        kind: MarkupKind.Markdown,
        value: documentation,
      };
    }
  }

  // Resolve constraint name completions (Property kind)
  if (item.kind === CompletionItemKind.Property && !item.documentation) {
    // Constraint names don't need additional resolution - they already have usage count
    // But we could enhance this later with examples of where the constraint is used
  }

  return item;
}
