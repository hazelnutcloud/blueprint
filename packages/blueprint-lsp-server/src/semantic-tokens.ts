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
 */
export const TokenModifiers = {
  /** No modifiers */
  none: 0,
  /** Declaration modifier for identifiers that declare a new symbol */
  declaration: 1 << 0,
  /** Definition modifier for identifiers that define a symbol */
  definition: 1 << 1,
} as const;

/**
 * The semantic tokens legend defining the token types and modifiers
 * that the Blueprint LSP provides.
 *
 * This legend must be registered with the LSP client during initialization.
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
 * @param tree The tree-sitter parse tree
 * @returns SemanticTokens object ready to be sent to the client
 */
export function buildSemanticTokens(tree: Tree): SemanticTokens {
  const tokens: TokenData[] = [];

  // Walk the tree and collect tokens
  walkTree(tree.rootNode, tokens);

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
 */
function walkTree(node: Node, tokens: TokenData[]): void {
  // Process the current node
  processNode(node, tokens);

  // Recursively process children
  for (const child of node.children) {
    walkTree(child, tokens);
  }
}

/**
 * Process a single tree-sitter node and collect semantic tokens if applicable.
 *
 * @param node The tree-sitter node to process
 * @param tokens The array to collect tokens into
 */
function processNode(node: Node, tokens: TokenData[]): void {
  const nodeType = node.type;

  // Handle block nodes that contain keywords
  const keyword = BLOCK_KEYWORDS[nodeType];
  if (keyword) {
    // The keyword is at the start of the block
    tokens.push({
      line: node.startPosition.row,
      char: node.startPosition.column,
      length: keyword.length,
      tokenType: TokenTypes.keyword,
      tokenModifiers: TokenModifiers.none,
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
        // This is a declaration identifier
        tokens.push({
          line: node.startPosition.row,
          char: node.startPosition.column,
          length: node.endIndex - node.startIndex,
          tokenType: TokenTypes.variable,
          tokenModifiers: TokenModifiers.declaration | TokenModifiers.definition,
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
