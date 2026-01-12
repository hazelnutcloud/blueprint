import type { Location, Position, Range } from "vscode-languageserver/node";
import type { Tree, Node } from "./parser";
import type { CrossFileSymbolIndex, IndexedSymbol } from "./symbol-index";
import type { SourceLocation } from "./ast";
import type { RequirementTicketMap } from "./requirement-ticket-map";
import type { Ticket, TicketFile } from "./tickets";

// ============================================================================
// Types
// ============================================================================

/**
 * Context for resolving definitions.
 */
export interface DefinitionContext {
  /** The cross-file symbol index */
  symbolIndex: CrossFileSymbolIndex;
  /** The requirement-ticket mapping */
  ticketMap: RequirementTicketMap;
  /** All ticket files indexed by their URI */
  ticketFiles: Map<string, { uri: string; content: string; tickets: Ticket[] }>;
  /** The file URI of the document where definition was requested */
  fileUri: string;
}

/**
 * Result of finding a definition target.
 */
export interface DefinitionTarget {
  /** The type of element */
  kind: "module" | "feature" | "requirement" | "constraint" | "reference" | "keyword";
  /** The symbol path if applicable */
  path?: string;
  /** The resolved symbol if available */
  symbol?: IndexedSymbol;
  /** For references, the referenced path */
  referencePath?: string;
}

// ============================================================================
// Tree-sitter Node Walking (shared with hover.ts)
// ============================================================================

/**
 * Find the most specific node at a given position.
 */
export function findNodeAtPosition(tree: Tree, position: Position): Node | null {
  const root = tree.rootNode;
  return findDeepestNodeAt(root, position.line, position.character);
}

/**
 * Recursively find the deepest node containing the given position.
 */
function findDeepestNodeAt(node: Node, line: number, column: number): Node | null {
  // Check if position is within this node
  if (!isPositionInNode(node, line, column)) {
    return null;
  }

  // Try to find a more specific child
  for (const child of node.children) {
    const found = findDeepestNodeAt(child, line, column);
    if (found) {
      return found;
    }
  }

  // No child contains the position, return this node
  return node;
}

/**
 * Check if a position is within a node's range.
 */
function isPositionInNode(node: Node, line: number, column: number): boolean {
  const start = node.startPosition;
  const end = node.endPosition;

  // Before start
  if (line < start.row || (line === start.row && column < start.column)) {
    return false;
  }

  // After end
  if (line > end.row || (line === end.row && column > end.column)) {
    return false;
  }

  return true;
}

/**
 * Find the definition target at a given position.
 */
export function findDefinitionTarget(
  tree: Tree,
  position: Position,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): DefinitionTarget | null {
  const node = findNodeAtPosition(tree, position);
  if (!node) {
    return null;
  }

  // Walk up to find a meaningful context
  let current: Node | null = node;
  let identifierNode: Node | null = null;

  while (current) {
    const type = current.type;

    // Check if we're on an identifier within a block
    if (type === "identifier") {
      identifierNode = current;
      current = current.parent;
      continue;
    }

    // Check for reference (in @depends-on) - highest priority
    if (type === "reference") {
      return buildReferenceDefinitionTarget(current, symbolIndex);
    }

    // Check for block types - navigate to the symbol's definition
    if (type === "module_block") {
      return buildModuleDefinitionTarget(current, identifierNode, symbolIndex, fileUri);
    }

    if (type === "feature_block") {
      return buildFeatureDefinitionTarget(current, identifierNode, symbolIndex, fileUri);
    }

    if (type === "requirement_block") {
      return buildRequirementDefinitionTarget(current, identifierNode, symbolIndex, fileUri);
    }

    if (type === "constraint") {
      return buildConstraintDefinitionTarget(current, identifierNode, symbolIndex, fileUri);
    }

    // Check for keyword tokens - no definition for keywords
    if (isKeywordNode(current)) {
      return { kind: "keyword" };
    }

    current = current.parent;
  }

  return null;
}

/**
 * Check if a node is a keyword.
 */
function isKeywordNode(node: Node): boolean {
  const text = node.text;
  return (
    text === "@module" ||
    text === "@feature" ||
    text === "@requirement" ||
    text === "@constraint" ||
    text === "@depends-on" ||
    text === "@description"
  );
}

/**
 * Build definition target for a module.
 */
function buildModuleDefinitionTarget(
  blockNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): DefinitionTarget | null {
  const nameNode = blockNode.childForFieldName("name");
  if (!nameNode) return null;

  const moduleName = nameNode.text;
  const symbols = symbolIndex.getSymbol(moduleName);
  const symbol = symbols?.find((s) => s.fileUri === fileUri && s.kind === "module");

  return {
    kind: "module",
    path: moduleName,
    symbol,
  };
}

/**
 * Build definition target for a feature.
 */
function buildFeatureDefinitionTarget(
  blockNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): DefinitionTarget | null {
  const nameNode = blockNode.childForFieldName("name");
  if (!nameNode) return null;

  // Find parent module to build full path
  let parent = blockNode.parent;
  let moduleName: string | null = null;

  while (parent) {
    if (parent.type === "module_block") {
      const moduleNameNode = parent.childForFieldName("name");
      if (moduleNameNode) {
        moduleName = moduleNameNode.text;
      }
      break;
    }
    parent = parent.parent;
  }

  if (!moduleName) return null;

  const featurePath = `${moduleName}.${nameNode.text}`;
  const symbols = symbolIndex.getSymbol(featurePath);
  const symbol = symbols?.find((s) => s.fileUri === fileUri && s.kind === "feature");

  return {
    kind: "feature",
    path: featurePath,
    symbol,
  };
}

/**
 * Build definition target for a requirement.
 */
function buildRequirementDefinitionTarget(
  blockNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): DefinitionTarget | null {
  const nameNode = blockNode.childForFieldName("name");
  if (!nameNode) return null;

  // Find parent feature/module to build full path
  let parent = blockNode.parent;
  let featureName: string | null = null;
  let moduleName: string | null = null;

  while (parent) {
    if (parent.type === "feature_block" && !featureName) {
      const featureNameNode = parent.childForFieldName("name");
      if (featureNameNode) {
        featureName = featureNameNode.text;
      }
    }
    if (parent.type === "module_block") {
      const moduleNameNode = parent.childForFieldName("name");
      if (moduleNameNode) {
        moduleName = moduleNameNode.text;
      }
      break;
    }
    parent = parent.parent;
  }

  if (!moduleName) return null;

  const reqPath = featureName
    ? `${moduleName}.${featureName}.${nameNode.text}`
    : `${moduleName}.${nameNode.text}`;

  const symbols = symbolIndex.getSymbol(reqPath);
  const symbol = symbols?.find((s) => s.fileUri === fileUri && s.kind === "requirement");

  return {
    kind: "requirement",
    path: reqPath,
    symbol,
  };
}

/**
 * Build definition target for a constraint.
 */
function buildConstraintDefinitionTarget(
  constraintNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): DefinitionTarget | null {
  const nameNode = constraintNode.childForFieldName("name");
  if (!nameNode) return null;

  // Find parent requirement/feature/module to build full path
  let parent = constraintNode.parent;
  let requirementName: string | null = null;
  let featureName: string | null = null;
  let moduleName: string | null = null;

  while (parent) {
    if (parent.type === "requirement_block" && !requirementName) {
      const reqNameNode = parent.childForFieldName("name");
      if (reqNameNode) {
        requirementName = reqNameNode.text;
      }
    }
    if (parent.type === "feature_block" && !featureName) {
      const featureNameNode = parent.childForFieldName("name");
      if (featureNameNode) {
        featureName = featureNameNode.text;
      }
    }
    if (parent.type === "module_block") {
      const moduleNameNode = parent.childForFieldName("name");
      if (moduleNameNode) {
        moduleName = moduleNameNode.text;
      }
      break;
    }
    parent = parent.parent;
  }

  if (!moduleName) return null;

  // Build constraint path based on where it's defined
  let basePath: string;
  if (requirementName && featureName) {
    basePath = `${moduleName}.${featureName}.${requirementName}`;
  } else if (requirementName) {
    basePath = `${moduleName}.${requirementName}`;
  } else if (featureName) {
    basePath = `${moduleName}.${featureName}`;
  } else {
    basePath = moduleName;
  }

  const constraintPath = `${basePath}.${nameNode.text}`;
  const symbols = symbolIndex.getSymbol(constraintPath);
  const symbol = symbols?.find((s) => s.fileUri === fileUri && s.kind === "constraint");

  return {
    kind: "constraint",
    path: constraintPath,
    symbol,
  };
}

/**
 * Build definition target for a reference in @depends-on.
 */
function buildReferenceDefinitionTarget(
  referenceNode: Node,
  symbolIndex: CrossFileSymbolIndex
): DefinitionTarget {
  // Extract the reference path from identifiers
  const parts: string[] = [];
  for (const child of referenceNode.children) {
    if (child.type === "identifier") {
      parts.push(child.text);
    }
  }
  const refPath = parts.join(".");

  // Try to resolve the reference
  const resolved = symbolIndex.resolveReference({
    type: "reference",
    parts,
    path: refPath,
    location: {
      startLine: referenceNode.startPosition.row,
      startColumn: referenceNode.startPosition.column,
      endLine: referenceNode.endPosition.row,
      endColumn: referenceNode.endPosition.column,
      startOffset: referenceNode.startIndex,
      endOffset: referenceNode.endIndex,
    },
  });

  return {
    kind: "reference",
    referencePath: refPath,
    symbol: resolved.symbol ?? undefined,
  };
}

// ============================================================================
// Definition Building
// ============================================================================

/**
 * Convert a SourceLocation to an LSP Range.
 */
function sourceLocationToRange(location: SourceLocation): Range {
  return {
    start: {
      line: location.startLine,
      character: location.startColumn,
    },
    end: {
      line: location.endLine,
      character: location.endColumn,
    },
  };
}

/**
 * Find the position of a ticket in the ticket file content.
 * Returns the range of the ticket object in the JSON file.
 */
function findTicketPositionInContent(content: string, ticketId: string): Range | null {
  // Find the ticket by searching for its ID in the JSON
  // Look for: "id": "TKT-001"
  const idPattern = `"id"\\s*:\\s*"${escapeRegExp(ticketId)}"`;
  const regex = new RegExp(idPattern);
  const match = regex.exec(content);

  if (!match) {
    return null;
  }

  // Find the opening brace of this ticket object by searching backwards
  let braceCount = 0;
  let ticketStart = match.index;
  for (let i = match.index; i >= 0; i--) {
    if (content[i] === "}") {
      braceCount++;
    } else if (content[i] === "{") {
      if (braceCount === 0) {
        ticketStart = i;
        break;
      }
      braceCount--;
    }
  }

  // Convert offset to line/column
  const lines = content.substring(0, ticketStart).split("\n");
  const startLine = lines.length - 1;
  const startColumn = lines[lines.length - 1]?.length ?? 0;

  // Find the closing brace of this ticket object
  braceCount = 0;
  let ticketEnd = ticketStart;
  for (let i = ticketStart; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
    } else if (content[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        ticketEnd = i + 1;
        break;
      }
    }
  }

  // Convert end offset to line/column
  const endLines = content.substring(0, ticketEnd).split("\n");
  const endLine = endLines.length - 1;
  const endColumn = endLines[endLines.length - 1]?.length ?? 0;

  return {
    start: { line: startLine, character: startColumn },
    end: { line: endLine, character: endColumn },
  };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the definition location for a target.
 *
 * Navigation behavior per SPEC.md Section 5.6:
 * - Requirement identifier → ticket in .tickets.json (if exists), else symbol definition
 * - @depends-on reference → referenced requirement
 * - Constraint identifier → constraint definition
 * - Module/Feature identifiers → their definition (for cross-file navigation)
 */
export function buildDefinition(
  target: DefinitionTarget,
  context: DefinitionContext
): Location | Location[] | null {
  switch (target.kind) {
    case "reference":
      return buildReferenceDefinition(target, context);
    case "requirement":
      return buildRequirementDefinition(target, context);
    case "constraint":
      return buildSymbolDefinition(target);
    case "module":
    case "feature":
      return buildSymbolDefinition(target);
    case "keyword":
      // No definition for keywords
      return null;
    default:
      return null;
  }
}

/**
 * Build definition for a reference (in @depends-on).
 * Navigates to the referenced symbol's definition.
 */
function buildReferenceDefinition(
  target: DefinitionTarget,
  context: DefinitionContext
): Location | null {
  if (!target.symbol) {
    // Unresolved reference - no definition
    return null;
  }

  return {
    uri: target.symbol.fileUri,
    range: sourceLocationToRange(target.symbol.node.location),
  };
}

/**
 * Build definition for a requirement.
 * First tries to navigate to the ticket, then falls back to symbol definition.
 */
function buildRequirementDefinition(
  target: DefinitionTarget,
  context: DefinitionContext
): Location | Location[] | null {
  if (!target.path) {
    return null;
  }

  // Try to find tickets for this requirement
  const ticketInfo = context.ticketMap.get(target.path);

  if (ticketInfo && ticketInfo.tickets.length > 0) {
    // Find which ticket file contains these tickets
    const ticketLocations: Location[] = [];

    for (const ticket of ticketInfo.tickets) {
      // Search through all ticket files to find where this ticket is defined
      for (const [uri, ticketFile] of context.ticketFiles) {
        const hasTicket = ticketFile.tickets.some((t) => t.id === ticket.id);
        if (hasTicket) {
          const range = findTicketPositionInContent(ticketFile.content, ticket.id);
          if (range) {
            ticketLocations.push({ uri, range });
          }
          break;
        }
      }
    }

    if (ticketLocations.length === 1) {
      return ticketLocations[0]!;
    } else if (ticketLocations.length > 1) {
      return ticketLocations;
    }
  }

  // Fall back to symbol definition if no tickets found
  return buildSymbolDefinition(target);
}

/**
 * Build definition for a symbol (module, feature, constraint).
 * Navigates to the symbol's definition in its source file.
 */
function buildSymbolDefinition(target: DefinitionTarget): Location | null {
  if (!target.symbol) {
    return null;
  }

  return {
    uri: target.symbol.fileUri,
    range: sourceLocationToRange(target.symbol.node.location),
  };
}
