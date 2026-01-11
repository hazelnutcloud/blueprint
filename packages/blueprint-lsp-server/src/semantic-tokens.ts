/**
 * Semantic tokens support for the Blueprint LSP.
 *
 * This module provides semantic token types and modifiers for syntax highlighting
 * of Blueprint DSL files. The token types follow the VS Code semantic token
 * conventions and map to the Blueprint language elements as specified in SPEC.md
 * Section 5.3.
 *
 * Token Type Mapping (from SPEC.md):
 * - @description, @module, @feature, @requirement, @depends-on, @constraint -> keyword
 * - Identifiers (names after keywords) -> variable
 * - References (in @depends-on) -> type
 * - Comments -> comment
 *
 * @module semantic-tokens
 */

import {
  SemanticTokenTypes,
  SemanticTokenModifiers,
  SemanticTokensBuilder,
} from "vscode-languageserver/node";
import type { SemanticTokensLegend, SemanticTokens } from "vscode-languageserver/node";
import type { Tree, Node } from "./parser";
import type { RequirementTicketMap, RequirementStatus } from "./requirement-ticket-map";
import type { BlockingStatusResult } from "./blocking-status";

/**
 * The token types used by the Blueprint LSP.
 *
 * These are indices into the tokenTypes array in the legend.
 * We use standard VS Code token types for maximum compatibility.
 */
export const TokenTypes = {
  /** Keywords: @description, @module, @feature, @requirement, @depends-on, @constraint */
  keyword: 0,
  /** Identifiers: names after keywords (module name, feature name, etc.) */
  variable: 1,
  /** References: dot-notation paths in @depends-on */
  type: 2,
  /** Comments: single-line and multi-line */
  comment: 3,
  /** Strings: used for description text (optional, for future use) */
  string: 4,
} as const;

/**
 * The token modifiers used by the Blueprint LSP.
 *
 * These are bit flags that can be combined.
 * 
 * Status modifiers (from SPEC.md Section 5.4):
 * - noTicket: Dim/gray background (no ticket exists)
 * - pending: No highlight (default)
 * - blocked: Red underline or background
 * - inProgress: Yellow/amber background
 * - complete: Green background
 * - obsolete: Strikethrough
 */
export const TokenModifiers = {
  /** No modifiers */
  none: 0,
  /** Declaration modifier for identifiers that declare a new symbol */
  declaration: 1 << 0,
  /** Definition modifier for identifiers that define a symbol */
  definition: 1 << 1,
  /** No ticket exists for this requirement - dim/gray styling */
  noTicket: 1 << 2,
  /** Requirement is blocked by incomplete dependencies - error styling */
  blocked: 1 << 3,
  /** Requirement is in progress - warning/amber styling */
  inProgress: 1 << 4,
  /** Requirement is complete - success/green styling */
  complete: 1 << 5,
  /** Requirement is obsolete - strikethrough styling */
  obsolete: 1 << 6,
} as const;

/**
 * Custom token modifier names for Blueprint status highlighting.
 * These are registered alongside standard modifiers.
 */
const CustomTokenModifiers = {
  noTicket: "noTicket",
  blocked: "blocked",
  inProgress: "inProgress",
  complete: "complete",
  obsolete: "obsolete",
} as const;

/**
 * The semantic tokens legend defining the token types and modifiers
 * that the Blueprint LSP provides.
 *
 * This legend must be registered with the LSP client during initialization.
 * 
 * Modifiers are ordered to match the bit positions in TokenModifiers:
 * - Index 0 (bit 0): declaration
 * - Index 1 (bit 1): definition
 * - Index 2 (bit 2): noTicket
 * - Index 3 (bit 3): blocked
 * - Index 4 (bit 4): inProgress
 * - Index 5 (bit 5): complete
 * - Index 6 (bit 6): obsolete
 */
export const semanticTokensLegend: SemanticTokensLegend = {
  tokenTypes: [
    SemanticTokenTypes.keyword,
    SemanticTokenTypes.variable,
    SemanticTokenTypes.type,
    SemanticTokenTypes.comment,
    SemanticTokenTypes.string,
  ],
  tokenModifiers: [
    SemanticTokenModifiers.declaration,
    SemanticTokenModifiers.definition,
    CustomTokenModifiers.noTicket,
    CustomTokenModifiers.blocked,
    CustomTokenModifiers.inProgress,
    CustomTokenModifiers.complete,
    CustomTokenModifiers.obsolete,
  ],
};

/**
 * Mapping of block node types to their keyword text.
 * The keyword appears at the start of the block node.
 */
const BLOCK_KEYWORDS: Record<string, string> = {
  description_block: "@description",
  module_block: "@module",
  feature_block: "@feature",
  requirement_block: "@requirement",
  depends_on: "@depends-on",
  constraint: "@constraint",
};

/**
 * Status information for a requirement used in progress-based highlighting.
 * This combines ticket status with blocking status from dependency analysis.
 */
export type RequirementHighlightStatus =
  | "no-ticket"      // No tickets exist for this requirement
  | "pending"        // All tickets are pending (default styling)
  | "blocked"        // Blocked by incomplete dependencies
  | "in-progress"    // At least one ticket is in-progress
  | "complete"       // All constraints satisfied, all tickets complete
  | "obsolete";      // All tickets are obsolete

/**
 * Map from requirement identifier name to its highlight status.
 * The key is the requirement name (not the full path).
 */
export type RequirementStatusMap = Map<string, RequirementHighlightStatus>;

/**
 * Context passed to walkTree for status-aware token generation.
 */
interface WalkContext {
  /** Current module name, if inside a module */
  currentModule: string | null;
  /** Current feature name, if inside a feature */
  currentFeature: string | null;
  /** Map of requirement full paths to their highlight status */
  statusMap: Map<string, RequirementHighlightStatus> | null;
}

/**
 * Gets the token modifier for a requirement based on its status.
 * Per SPEC.md Section 5.4 (Progress Highlighting).
 */
function getStatusModifier(status: RequirementHighlightStatus): number {
  switch (status) {
    case "no-ticket":
      return TokenModifiers.noTicket;
    case "blocked":
      return TokenModifiers.blocked;
    case "in-progress":
      return TokenModifiers.inProgress;
    case "complete":
      return TokenModifiers.complete;
    case "obsolete":
      return TokenModifiers.obsolete;
    case "pending":
    default:
      // Pending gets no special modifier (default styling)
      return TokenModifiers.none;
  }
}

/**
 * Token data for sorting and building.
 */
interface TokenData {
  line: number;
  char: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

/**
 * Build semantic tokens for a parsed Blueprint document.
 *
 * Walks the tree-sitter parse tree and emits tokens for:
 * - Keywords (@description, @module, @feature, @requirement, @depends-on, @constraint)
 * - Identifiers (names after keywords)
 * - References (dot-notation paths in @depends-on)
 * - Comments (single-line and multi-line)
 *
 * When a statusMap is provided, requirement keywords and identifiers will have
 * status-based modifiers applied per SPEC.md Section 5.4 (Progress Highlighting):
 * - No ticket → noTicket modifier (dim/gray styling)
 * - pending → no special modifier (default styling)
 * - blocked → blocked modifier (red/error styling)
 * - in-progress → inProgress modifier (yellow/amber styling)
 * - complete → complete modifier (green styling)
 * - obsolete → obsolete modifier (strikethrough styling)
 *
 * @param tree The tree-sitter parse tree
 * @param statusMap Optional map of requirement paths to their highlight status
 * @returns SemanticTokens object ready to be sent to the client
 */
export function buildSemanticTokens(
  tree: Tree,
  statusMap?: Map<string, RequirementHighlightStatus>
): SemanticTokens {
  const tokens: TokenData[] = [];

  // Initialize context for tracking current scope
  const context: WalkContext = {
    currentModule: null,
    currentFeature: null,
    statusMap: statusMap ?? null,
  };

  // Walk the tree and collect tokens
  walkTree(tree.rootNode, tokens, context);

  // Sort tokens by line, then by character position
  // This is required because the SemanticTokensBuilder expects tokens in order
  tokens.sort((a, b) => {
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.char - b.char;
  });

  // Build the semantic tokens
  const builder = new SemanticTokensBuilder();
  for (const token of tokens) {
    if (token.length > 0) {
      builder.push(
        token.line,
        token.char,
        token.length,
        token.tokenType,
        token.tokenModifiers
      );
    }
  }

  return builder.build();
}

/**
 * Recursively walk the tree-sitter parse tree and collect semantic tokens.
 *
 * @param node The current tree-sitter node
 * @param tokens The array to collect tokens into
 * @param context The walk context with current scope and status information
 */
function walkTree(node: Node, tokens: TokenData[], context: WalkContext): void {
  const nodeType = node.type;

  // Track scope changes for building requirement paths
  let savedModule = context.currentModule;
  let savedFeature = context.currentFeature;

  if (nodeType === "module_block") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      context.currentModule = nameNode.text;
      context.currentFeature = null; // Reset feature when entering a new module
    }
  } else if (nodeType === "feature_block") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      context.currentFeature = nameNode.text;
    }
  }

  // Process the current node
  processNode(node, tokens, context);

  // Recursively process children
  for (const child of node.children) {
    walkTree(child, tokens, context);
  }

  // Restore scope when exiting blocks
  if (nodeType === "module_block") {
    context.currentModule = savedModule;
    context.currentFeature = savedFeature;
  } else if (nodeType === "feature_block") {
    context.currentFeature = savedFeature;
  }
}

/**
 * Builds the full path for a requirement given the current context.
 * Returns null if we don't have complete scope information.
 */
function buildRequirementPath(
  requirementName: string,
  context: WalkContext
): string | null {
  if (!context.currentModule) {
    return null;
  }
  if (context.currentFeature) {
    return `${context.currentModule}.${context.currentFeature}.${requirementName}`;
  }
  // Requirement directly under module (no feature)
  return `${context.currentModule}.${requirementName}`;
}

/**
 * Gets the status modifier for a requirement block based on the status map.
 */
function getRequirementStatusModifier(
  node: Node,
  context: WalkContext
): number {
  if (!context.statusMap) {
    return TokenModifiers.none;
  }

  const nameNode = node.childForFieldName("name");
  if (!nameNode) {
    return TokenModifiers.none;
  }

  const requirementName = nameNode.text;
  const fullPath = buildRequirementPath(requirementName, context);

  if (!fullPath) {
    return TokenModifiers.none;
  }

  const status = context.statusMap.get(fullPath);
  if (!status) {
    // No status found - this could mean no ticket exists
    return TokenModifiers.noTicket;
  }

  return getStatusModifier(status);
}

/**
 * Process a single tree-sitter node and collect semantic tokens if applicable.
 *
 * @param node The tree-sitter node to process
 * @param tokens The array to collect tokens into
 * @param context The walk context with current scope and status information
 */
function processNode(node: Node, tokens: TokenData[], context: WalkContext): void {
  const nodeType = node.type;

  // Handle block nodes that contain keywords
  const keyword = BLOCK_KEYWORDS[nodeType];
  if (keyword) {
    // Determine if this is a requirement block that needs status highlighting
    let statusModifier: number = TokenModifiers.none;
    if (nodeType === "requirement_block" && context.statusMap) {
      statusModifier = getRequirementStatusModifier(node, context);
    }

    // The keyword is at the start of the block
    tokens.push({
      line: node.startPosition.row,
      char: node.startPosition.column,
      length: keyword.length,
      tokenType: TokenTypes.keyword,
      tokenModifiers: statusModifier,
    });
    return;
  }

  // Handle identifier nodes
  if (nodeType === "identifier") {
    const parent = node.parent;

    // Check if this identifier is within a reference (in @depends-on)
    if (parent && parent.type === "reference") {
      tokens.push({
        line: node.startPosition.row,
        char: node.startPosition.column,
        length: node.endIndex - node.startIndex,
        tokenType: TokenTypes.type,
        tokenModifiers: TokenModifiers.none,
      });
      return;
    }

    // Check if this is a declaration identifier (the "name" field of a block)
    if (parent) {
      const nameNode = parent.childForFieldName("name");
      if (nameNode && nameNode.id === node.id) {
        // Determine base modifiers for declaration
        let modifiers = TokenModifiers.declaration | TokenModifiers.definition;

        // Add status modifier for requirement identifiers
        if (parent.type === "requirement_block" && context.statusMap) {
          const statusModifier = getRequirementStatusModifier(parent, context);
          modifiers |= statusModifier;
        }

        // This is a declaration identifier
        tokens.push({
          line: node.startPosition.row,
          char: node.startPosition.column,
          length: node.endIndex - node.startIndex,
          tokenType: TokenTypes.variable,
          tokenModifiers: modifiers,
        });
        return;
      }
    }

    // Default: treat as a regular variable
    tokens.push({
      line: node.startPosition.row,
      char: node.startPosition.column,
      length: node.endIndex - node.startIndex,
      tokenType: TokenTypes.variable,
      tokenModifiers: TokenModifiers.none,
    });
    return;
  }

  // Handle comment nodes
  if (nodeType === "comment") {
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;

    if (startLine === endLine) {
      // Single-line comment
      tokens.push({
        line: startLine,
        char: node.startPosition.column,
        length: node.endIndex - node.startIndex,
        tokenType: TokenTypes.comment,
        tokenModifiers: TokenModifiers.none,
      });
    } else {
      // Multi-line comment: emit a token for each line
      const text = node.text;
      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? "";
        const lineNum = startLine + i;
        const startCol = i === 0 ? node.startPosition.column : 0;
        // For the last line, calculate the actual length
        const length =
          i === lines.length - 1
            ? node.endPosition.column
            : lineText.length;

        if (length > 0) {
          tokens.push({
            line: lineNum,
            char: startCol,
            length: i === 0 ? lineText.length : length,
            tokenType: TokenTypes.comment,
            tokenModifiers: TokenModifiers.none,
          });
        }
      }
    }
    return;
  }
}

/**
 * Builds a RequirementHighlightStatus map from requirement-ticket mapping
 * and blocking status information.
 * 
 * The status priority is:
 * 1. If blocked by dependencies → "blocked"
 * 2. Otherwise use ticket status (no-ticket, pending, in-progress, complete, obsolete)
 * 
 * @param ticketMap The requirement-ticket mapping with status info
 * @param blockingStatus Optional blocking status from dependency analysis
 * @returns Map from requirement path to highlight status
 */
export function buildRequirementStatusMap(
  ticketMap: RequirementTicketMap,
  blockingStatus?: BlockingStatusResult
): Map<string, RequirementHighlightStatus> {
  const statusMap = new Map<string, RequirementHighlightStatus>();

  for (const [path, info] of ticketMap) {
    // Check if blocked by dependencies (takes precedence)
    if (blockingStatus) {
      const blockingInfo = blockingStatus.blockingInfo.get(path);
      if (blockingInfo && (blockingInfo.status === "blocked" || blockingInfo.status === "in-cycle")) {
        statusMap.set(path, "blocked");
        continue;
      }
    }

    // Use ticket status
    statusMap.set(path, convertToHighlightStatus(info.status));
  }

  return statusMap;
}

/**
 * Converts a RequirementStatus to RequirementHighlightStatus.
 * These are compatible but we need to handle the type conversion.
 */
function convertToHighlightStatus(status: RequirementStatus): RequirementHighlightStatus {
  // The types are compatible, but TypeScript needs explicit mapping
  switch (status) {
    case "no-ticket":
      return "no-ticket";
    case "pending":
      return "pending";
    case "in-progress":
      return "in-progress";
    case "complete":
      return "complete";
    case "obsolete":
      return "obsolete";
    default:
      return "pending";
  }
}
