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

  // Check if we're in a @constraint context (after @constraint keyword with a space)
  // Matches: "@constraint " or "@constraint name" but not "@constraint" alone (which is keyword completion)
  const isInConstraint = /^\s*@constraint\s+/.test(textBeforeCursor);

  // Check if we're in a comment or code block
  const node = findNodeAtPosition(tree.rootNode, position.line, position.character);

  // Check if we're right after opening backticks for code block language
  // Matches: "```" at end of line OR "```lang" where cursor is right after backticks
  const isInCodeBlockLanguage = /```[a-zA-Z0-9_-]*$/.test(textBeforeCursor);

  // Skip zone is inside code block content but NOT at the language position
  // We want to allow completion for the language identifier right after ```
  const isInCodeBlockContent =
    node?.type === "code_content" || (node?.type === "code_block" && !isInCodeBlockLanguage);
  const isInSkipZone = node?.type === "comment" || isInCodeBlockContent;

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
    isInConstraint,
    prefix,
    isInSkipZone,
    isInCodeBlockLanguage,
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
// Reference Matching and Scoring
// ============================================================================

/**
 * Check if a symbol matches a query string for reference completion.
 * Matching is case-insensitive and supports:
 * - Prefix matching (query matches start of name or path)
 * - Substring matching (query is contained in name or path)
 * - Fuzzy matching (query characters appear in order in name)
 */
export function matchesReferenceQuery(symbol: IndexedSymbol, query: string): boolean {
  if (!query) {
    return true; // Empty query matches everything
  }

  const lowerQuery = query.toLowerCase();
  const name = symbol.node.name?.toLowerCase() ?? "";
  const path = symbol.path.toLowerCase();

  // Exact prefix match on name
  if (name.startsWith(lowerQuery)) {
    return true;
  }

  // Substring match on name
  if (name.includes(lowerQuery)) {
    return true;
  }

  // Substring match on full path
  if (path.includes(lowerQuery)) {
    return true;
  }

  // Fuzzy match: query characters appear in order in name
  let queryIdx = 0;
  for (let i = 0; i < name.length && queryIdx < lowerQuery.length; i++) {
    if (name[i] === lowerQuery[queryIdx]) {
      queryIdx++;
    }
  }
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
 */
export function calculateReferenceScore(symbol: IndexedSymbol, query: string): number {
  if (!query) {
    return 0;
  }

  const lowerQuery = query.toLowerCase();
  const name = symbol.node.name?.toLowerCase() ?? "";
  const path = symbol.path.toLowerCase();

  // Exact match on name
  if (name === lowerQuery) {
    return 100;
  }

  // Prefix match on name
  if (name.startsWith(lowerQuery)) {
    return 80 + (lowerQuery.length / name.length) * 10;
  }

  // Exact match on path segment
  const pathParts = path.split(".");
  if (pathParts.includes(lowerQuery)) {
    return 70;
  }

  // Substring match on name (earlier position is better)
  const nameIdx = name.indexOf(lowerQuery);
  if (nameIdx !== -1) {
    return 60 - Math.min(nameIdx, 10);
  }

  // Substring match on path
  if (path.includes(lowerQuery)) {
    return 40;
  }

  // Fuzzy match (fallback)
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
 */
export function getReferenceCompletions(
  context: CompletionContext,
  handlerContext: CompletionHandlerContext
): CompletionItem[] {
  const { symbolIndex, fileUri } = handlerContext;
  const { prefix, scopePath, existingReferences } = context;

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

  // Collect matching symbols with their scores
  const scoredSymbols: Array<{ symbol: IndexedSymbol; score: number; isLocal: boolean }> = [];

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

    // Use fuzzy matching to filter symbols
    if (!matchesReferenceQuery(symbol, prefix)) {
      continue;
    }

    // Calculate relevance score
    const score = calculateReferenceScore(symbol, prefix);
    const isLocal = symbol.fileUri === fileUri;

    scoredSymbols.push({ symbol, score, isLocal });
    addedPaths.add(path);
  }

  // Sort by: local boost first, then by score (descending), then by name (ascending)
  scoredSymbols.sort((a, b) => {
    // Local symbols come first
    if (a.isLocal !== b.isLocal) {
      return a.isLocal ? -1 : 1;
    }

    // Higher score is better
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    // Alphabetical by path as tiebreaker
    return a.symbol.path.localeCompare(b.symbol.path);
  });

  // Convert to CompletionItems with sortText based on sorted order
  const completions: CompletionItem[] = [];

  for (let i = 0; i < scoredSymbols.length && i < 50; i++) {
    const entry = scoredSymbols[i]!;
    const { symbol, isLocal } = entry;
    const path = symbol.path;

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

    const fileName = symbol.fileUri.split("/").pop() ?? symbol.fileUri;

    // Extract description from the symbol's AST node if available
    const description =
      "description" in symbol.node && symbol.node.description ? symbol.node.description : undefined;

    // Use sortText to preserve the sorted order (0-padded index)
    // Local symbols get "0" prefix, remote get "1" prefix
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

  // Code block language completion (after ```)
  if (context.isInCodeBlockLanguage) {
    items.push(...getCodeBlockLanguageCompletions(context));
  }
  // Path completion (after a dot)
  else if (context.isAfterDotTrigger) {
    items.push(...getPathCompletions(context, handlerContext));
  }
  // Constraint name completion (in @constraint context)
  else if (context.isInConstraint && !context.isAfterAtTrigger) {
    items.push(...getConstraintNameCompletions(context, handlerContext));
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
