import type { Location, Position, Range } from "vscode-languageserver/node";
import type { Tree, Node } from "./parser";
import type { CrossFileSymbolIndex, IndexedSymbol } from "./symbol-index";
import type { SourceLocation } from "./ast";
import type { DependencyGraph, DependencyEdge } from "./dependency-graph";

// ============================================================================
// Types
// ============================================================================

/**
 * Context for finding references.
 */
export interface ReferencesContext {
  /** The cross-file symbol index */
  symbolIndex: CrossFileSymbolIndex;
  /** The dependency graph */
  dependencyGraph: DependencyGraph;
  /** All dependency edges for location lookup */
  edges: DependencyEdge[];
  /** The file URI of the document where references was requested */
  fileUri: string;
  /** Whether to include the declaration itself in results */
  includeDeclaration: boolean;
}

/**
 * Result of finding a references target.
 */
export interface ReferencesTarget {
  /** The type of element */
  kind: "module" | "feature" | "requirement" | "constraint" | "reference" | "keyword";
  /** The symbol path if applicable */
  path?: string;
  /** The resolved symbol if available */
  symbol?: IndexedSymbol;
}

// ============================================================================
// Tree-sitter Node Walking
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
 * Find the references target at a given position.
 * Returns the symbol that we want to find references TO.
 */
export function findReferencesTarget(
  tree: Tree,
  position: Position,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): ReferencesTarget | null {
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

    // Check for reference (in @depends-on) - find references to the referenced symbol
    if (type === "reference") {
      return buildReferenceTarget(current, symbolIndex);
    }

    // Check for block types - find references to this symbol
    if (type === "module_block") {
      return buildModuleTarget(current, symbolIndex, fileUri);
    }

    if (type === "feature_block") {
      return buildFeatureTarget(current, symbolIndex, fileUri);
    }

    if (type === "requirement_block") {
      return buildRequirementTarget(current, symbolIndex, fileUri);
    }

    if (type === "constraint") {
      return buildConstraintTarget(current, symbolIndex, fileUri);
    }

    // Check for keyword tokens - no references for keywords
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
 * Build references target for a module.
 */
function buildModuleTarget(
  blockNode: Node,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): ReferencesTarget | null {
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
 * Build references target for a feature.
 */
function buildFeatureTarget(
  blockNode: Node,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): ReferencesTarget | null {
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
 * Build references target for a requirement.
 */
function buildRequirementTarget(
  blockNode: Node,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): ReferencesTarget | null {
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
 * Build references target for a constraint.
 */
function buildConstraintTarget(
  constraintNode: Node,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): ReferencesTarget | null {
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
 * Build references target for a reference in @depends-on.
 * When finding references on a @depends-on reference, we want to find
 * all other references to the same symbol.
 */
function buildReferenceTarget(
  referenceNode: Node,
  symbolIndex: CrossFileSymbolIndex
): ReferencesTarget {
  // Extract the reference path from identifiers
  const parts: string[] = [];
  for (const child of referenceNode.children) {
    if (child.type === "identifier") {
      parts.push(child.text);
    }
  }
  const refPath = parts.join(".");

  // Try to resolve the reference to find the symbol
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

  // Determine the kind based on the resolved symbol
  const kind = resolved.symbol?.kind ?? "module";

  return {
    kind: kind as ReferencesTarget["kind"],
    path: refPath,
    symbol: resolved.symbol ?? undefined,
  };
}

// ============================================================================
// References Building
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
 * Find all references to a target symbol.
 * 
 * References in Blueprint are @depends-on declarations that reference a symbol.
 * This function finds all places where the target symbol is referenced.
 * 
 * Per SPEC.md Section 5.7:
 * - Find all @depends-on declarations referencing an element
 * - Find tickets tracking a requirement (handled separately via tickets)
 * - Find source files implementing a requirement (via ticket data - future)
 */
export function buildReferences(
  target: ReferencesTarget,
  context: ReferencesContext
): Location[] | null {
  // Keywords don't have references
  if (target.kind === "keyword") {
    return null;
  }

  // Need a path to find references
  if (!target.path) {
    return null;
  }

  const locations: Location[] = [];

  // Optionally include the declaration itself
  if (context.includeDeclaration && target.symbol) {
    locations.push({
      uri: target.symbol.fileUri,
      range: sourceLocationToRange(target.symbol.node.location),
    });
  }

  // Find all references using the dependency graph edges
  // Each edge's "to" field points to a symbol that is depended on
  // We want edges where "to" matches our target path (or is a child of it)
  const referencingEdges = findReferencingEdges(target.path, context.edges);

  for (const edge of referencingEdges) {
    // The reference location is stored in the edge's ReferenceNode
    locations.push({
      uri: edge.fileUri,
      range: sourceLocationToRange(edge.reference.location),
    });
  }

  return locations.length > 0 ? locations : null;
}

/**
 * Find all edges that reference the target path.
 * 
 * This includes:
 * - Exact matches: @depends-on target.path
 * - Prefix matches: When referencing a parent (e.g., @depends-on module 
 *   implicitly references all children)
 */
function findReferencingEdges(
  targetPath: string,
  edges: DependencyEdge[]
): DependencyEdge[] {
  const result: DependencyEdge[] = [];

  for (const edge of edges) {
    // Exact match: the edge directly references this path
    if (edge.to === targetPath) {
      result.push(edge);
      continue;
    }

    // Check if the edge references a parent of the target
    // e.g., if target is "auth.login.basic-auth" and edge.to is "auth.login"
    // then this is a reference to all requirements in that feature
    if (targetPath.startsWith(edge.to + ".")) {
      result.push(edge);
      continue;
    }

    // Check if the edge references a child of the target
    // e.g., if target is "auth" and edge.to is "auth.login"
    // We don't include these - when you look for references to "auth",
    // you want places that reference "auth" explicitly, not its children
  }

  return result;
}

/**
 * Get the count of unique files that reference the target.
 * Useful for displaying "X references in Y files" information.
 */
export function getReferencesStats(
  target: ReferencesTarget,
  context: ReferencesContext
): { referenceCount: number; fileCount: number } | null {
  if (!target.path) {
    return null;
  }

  const edges = findReferencingEdges(target.path, context.edges);
  const uniqueFiles = new Set(edges.map((e) => e.fileUri));

  return {
    referenceCount: edges.length,
    fileCount: uniqueFiles.size,
  };
}
