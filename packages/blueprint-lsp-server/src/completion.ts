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
import type { CrossFileSymbolIndex } from "./symbol-index";

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
  /** The partial text before the cursor for filtering */
  prefix: string;
  /** Whether we're inside a comment or code block (skip completion) */
  isInSkipZone: boolean;
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
 */
function findNodeAtPosition(node: Node, line: number, column: number): Node | null {
  // Check if position is within this node
  const start = node.startPosition;
  const end = node.endPosition;

  // Before start
  if (line < start.row || (line === start.row && column < start.column)) {
    return null;
  }

  // After end
  if (line > end.row || (line === end.row && column > end.column)) {
    return null;
  }

  // Try to find a more specific child
  for (const child of node.children) {
    const found = findNodeAtPosition(child, line, column);
    if (found) {
      return found;
    }
  }

  // No child contains the position, return this node
  return node;
}

/**
 * Get the current scope based on cursor position in the tree.
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
 * Extract existing references from a @depends-on clause.
 * Returns an array of reference paths (e.g., ["auth.login", "storage"]).
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
 */
export function getCursorContext(
  tree: Tree,
  position: Position,
  documentText: string
): CompletionContext {
  const scope = getCurrentScope(tree, position);
  const containingBlock = findContainingBlock(tree, position);

  // Get the current line text up to the cursor
  const lines = documentText.split("\n");
  const currentLine = lines[position.line] ?? "";
  const textBeforeCursor = currentLine.slice(0, position.character);

  // Detect trigger contexts
  const isAfterAtTrigger = /^\s*@[a-z-]*$/i.test(textBeforeCursor);
  const isAfterDotTrigger = /\.$/.test(textBeforeCursor);

  // Extract prefix for filtering (text after last whitespace or @)
  const prefixMatch = textBeforeCursor.match(/(@?[\w.-]*)$/);
  const prefix = prefixMatch?.[1] ?? "";

  // Check if we're in a @depends-on context
  const isInDependsOn = textBeforeCursor.includes("@depends-on");

  // Check if we're in a comment or code block
  const node = findNodeAtPosition(tree.rootNode, position.line, position.character);
  const isInSkipZone = node?.type === "comment" || node?.type === "code_block";

  // Parse existing references in the @depends-on clause
  let existingReferences: string[] = [];
  let isAfterComma = false;

  if (isInDependsOn) {
    // Try to find the depends_on node from the tree
    const dependsOnNode = findContainingDependsOn(tree, position);
    if (dependsOnNode) {
      existingReferences = extractExistingReferences(dependsOnNode);
    }

    // Also parse from the text for incomplete references (tree may not have them yet)
    // Extract references from text: "@depends-on ref1, ref2, " -> ["ref1", "ref2"]
    const dependsOnMatch = textBeforeCursor.match(/@depends-on\s+(.*)$/);
    if (dependsOnMatch && dependsOnMatch[1]) {
      const refsText = dependsOnMatch[1];
      // Split by comma and extract complete references
      const textRefs = refsText
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0 && !r.endsWith(".")); // Filter out incomplete refs

      // Merge with tree-based refs (tree has complete refs, text may have partial)
      for (const ref of textRefs) {
        if (!existingReferences.includes(ref) && ref !== prefix) {
          existingReferences.push(ref);
        }
      }
    }

    // Detect if we're after a comma (adding additional reference)
    // Check if there's a comma followed by optional whitespace before the prefix
    isAfterComma = /,\s*[\w.-]*$/.test(textBeforeCursor);
  }

  // Extract scope path information
  let currentModule: string | null = null;
  let currentFeature: string | null = null;
  let currentRequirement: string | null = null;
  let scopePath: string | null = null;

  if (containingBlock) {
    // Walk up to find all parent context
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

    // Build scope path
    if (currentModule) {
      scopePath = currentModule;
      if (currentFeature) {
        scopePath += `.${currentFeature}`;
        if (currentRequirement) {
          scopePath += `.${currentRequirement}`;
        }
      } else if (currentRequirement) {
        scopePath += `.${currentRequirement}`;
      }
    }
  }

  return {
    scope,
    scopePath,
    isAfterAtTrigger,
    isAfterDotTrigger,
    isInDependsOn,
    prefix,
    isInSkipZone,
    currentModule,
    currentFeature,
    currentRequirement,
    existingReferences,
    isAfterComma,
  };
}

// ============================================================================
// Keyword Completion
// ============================================================================

/**
 * Check if a keyword is valid in the given scope.
 */
export function isKeywordValidInScope(keyword: KeywordName, scope: CompletionScope): boolean {
  const keywordMeta = COMPLETION_KEYWORDS[keyword];
  return (keywordMeta.validScopes as readonly string[]).includes(scope);
}

/**
 * Get keyword completions filtered by scope and prefix.
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
// Reference Completion (for @depends-on)
// ============================================================================

/**
 * Get reference completions for @depends-on context.
 * Returns symbols from the symbol index that can be referenced.
 */
export function getReferenceCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex, fileUri } = handlerContext;
  const { prefix, scopePath, existingReferences } = context;
  const completions: CompletionItem[] = [];

  // Collect all referenceable symbols (modules, features, requirements)
  const allSymbols = [
    ...symbolIndex.getSymbolsByKind("module"),
    ...symbolIndex.getSymbolsByKind("feature"),
    ...symbolIndex.getSymbolsByKind("requirement"),
  ];

  // Track paths we've already added to avoid duplicates
  const addedPaths = new Set<string>();

  // Create set of existing references for fast lookup
  const existingRefSet = new Set(existingReferences);

  for (const symbol of allSymbols) {
    const path = symbol.path;

    // Skip if already added (can happen with multi-file duplicates)
    if (addedPaths.has(path)) {
      continue;
    }

    // Skip references already in the @depends-on clause
    if (existingRefSet.has(path)) {
      continue;
    }

    // Skip self-references (can't depend on yourself)
    if (scopePath && path.startsWith(scopePath)) {
      continue;
    }

    // Skip symbols that would create circular dependencies
    if (scopePath && symbolIndex.wouldCreateCircularDependency(scopePath, path)) {
      continue;
    }

    // Filter by prefix if provided
    if (prefix && !path.toLowerCase().includes(prefix.toLowerCase())) {
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
      default:
        kind = CompletionItemKind.Reference;
    }

    // Boost local symbols (same file) by adding them with higher sort priority
    const isLocal = symbol.fileUri === fileUri;
    const sortText = isLocal ? `0${path}` : `1${path}`;
    const fileName = symbol.fileUri.split("/").pop() ?? symbol.fileUri;

    // Extract description from the symbol's AST node if available
    const description =
      "description" in symbol.node && symbol.node.description ? symbol.node.description : undefined;

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

    addedPaths.add(path);
  }

  // Limit results to prevent overwhelming the UI
  return completions.slice(0, 50);
}

// ============================================================================
// Path Completion (dot navigation)
// ============================================================================

/**
 * Get child symbol completions for path navigation (after a dot).
 */
export function getPathCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex } = handlerContext;
  const { prefix } = context;
  const completions: CompletionItem[] = [];

  // Extract the parent path (everything before the last dot)
  const parentPathMatch = prefix.match(/^(.+)\./);
  if (!parentPathMatch || !parentPathMatch[1]) {
    return completions;
  }

  const parentPath = parentPathMatch[1];

  // Collect all symbols that could be children
  const allSymbols = [
    ...symbolIndex.getSymbolsByKind("module"),
    ...symbolIndex.getSymbolsByKind("feature"),
    ...symbolIndex.getSymbolsByKind("requirement"),
    ...symbolIndex.getSymbolsByKind("constraint"),
  ];

  // Track paths we've already added to avoid duplicates
  const addedPaths = new Set<string>();

  for (const symbol of allSymbols) {
    const path = symbol.path;

    // Check if this is a direct child of the parent path
    if (!path.startsWith(parentPath + ".")) {
      continue;
    }

    // Get the remaining path after the parent
    const remainingPath = path.slice(parentPath.length + 1);

    // Only include direct children (no dots in remaining path)
    if (remainingPath.includes(".")) {
      continue;
    }

    // Skip if already added
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

  // Get the cursor context
  const context = getCursorContext(tree, position, documentText);

  // Skip completion in comments and code blocks
  if (context.isInSkipZone) {
    return null;
  }

  const items: CompletionItem[] = [];

  // Path completion (after a dot)
  if (context.isAfterDotTrigger) {
    items.push(...getPathCompletions(context, handlerContext));
  }
  // Reference completion (in @depends-on context)
  else if (context.isInDependsOn && !context.isAfterAtTrigger) {
    items.push(...getReferenceCompletions(context, handlerContext));
  }
  // Keyword completion (after @ or at line start)
  else if (context.isAfterAtTrigger || context.prefix === "" || context.prefix.startsWith("@")) {
    items.push(...getKeywordCompletions(context.scope, context.prefix));
  }
  // General reference completion (fallback)
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
 * Resolve additional details for a completion item.
 * This is called when a completion item is focused in the UI.
 *
 * @param item The completion item to resolve
 * @param handlerContext Context with symbol index
 * @returns The resolved completion item with additional details
 */
export function resolveCompletionItem(
  item: CompletionItem,
  handlerContext: CompletionHandlerContext
): CompletionItem {
  // If this is a reference completion, load full documentation
  if (
    item.kind === CompletionItemKind.Module ||
    item.kind === CompletionItemKind.Class ||
    item.kind === CompletionItemKind.Function
  ) {
    const { symbolIndex } = handlerContext;
    const symbols = symbolIndex.getSymbol(item.label);
    const symbol = symbols?.[0];

    if (symbol && "description" in symbol.node) {
      const description = symbol.node.description;
      if (description) {
        item.documentation = {
          kind: MarkupKind.Markdown,
          value: description,
        };
      }
    }
  }

  return item;
}
