import type { Hover, Position, MarkupContent } from "vscode-languageserver/node";
import { MarkupKind } from "vscode-languageserver/node";
import { URI } from "vscode-uri";
import type { Tree, Node } from "./parser";
import type { ModuleNode, FeatureNode, RequirementNode, ConstraintNode } from "./ast";
import type { CrossFileSymbolIndex, IndexedSymbol } from "./symbol-index";
import type { RequirementTicketMap } from "./requirement-ticket-map";
import { getCompletionSummary, filterByPathPrefix } from "./requirement-ticket-map";
import { computeBlockingInfo } from "./blocking-status";
import type { DependencyGraph, CircularDependency } from "./dependency-graph";
import { join, isAbsolute } from "node:path";

// ============================================================================
// Types
// ============================================================================

/**
 * Context for building hover information.
 */
export interface HoverContext {
  /** The cross-file symbol index */
  symbolIndex: CrossFileSymbolIndex;
  /** The requirement-ticket mapping */
  ticketMap: RequirementTicketMap;
  /** The dependency graph */
  dependencyGraph: DependencyGraph;
  /** Detected circular dependencies */
  cycles: CircularDependency[];
  /** The file URI of the document being hovered */
  fileUri: string;
  /** Workspace folder URIs for resolving relative file paths */
  workspaceFolderUris?: string[];
}

/**
 * Result of finding a hoverable element.
 */
export interface HoverTarget {
  /** The type of element being hovered */
  kind:
    | "module"
    | "feature"
    | "requirement"
    | "constraint"
    | "reference"
    | "keyword"
    | "description";
  /** The symbol path if applicable */
  path?: string;
  /** The AST node if available */
  node?: ModuleNode | FeatureNode | RequirementNode | ConstraintNode;
  /** The indexed symbol if resolved */
  symbol?: IndexedSymbol;
  /** The description text if hovering a description block */
  descriptionText?: string;
  /** The hover range */
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
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
 * Find the hover target at a given position.
 */
export function findHoverTarget(
  tree: Tree,
  position: Position,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): HoverTarget | null {
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

    // Check for reference (in @depends-on)
    if (type === "reference") {
      return buildReferenceTarget(current, symbolIndex);
    }

    // Check for block types
    if (type === "module_block") {
      return buildModuleTarget(current, identifierNode, symbolIndex, fileUri);
    }

    if (type === "feature_block") {
      return buildFeatureTarget(current, identifierNode, symbolIndex, fileUri);
    }

    if (type === "requirement_block") {
      return buildRequirementTarget(current, identifierNode, symbolIndex, fileUri);
    }

    if (type === "constraint") {
      return buildConstraintTarget(current, identifierNode, symbolIndex, fileUri);
    }

    // Check for description block
    if (type === "description_block") {
      return buildDescriptionTarget(current);
    }

    // Check for keyword tokens
    if (isKeywordNode(current)) {
      return buildKeywordTarget(current);
    }

    current = current.parent;
  }

  return null;
}

/**
 * Check if a node is a keyword.
 * Note: @description is excluded because description blocks get specialized hover content.
 */
function isKeywordNode(node: Node): boolean {
  const text = node.text;
  return (
    text === "@module" ||
    text === "@feature" ||
    text === "@requirement" ||
    text === "@constraint" ||
    text === "@depends-on"
    // @description is handled by description_block hover
  );
}

/**
 * Build hover target for a module.
 */
function buildModuleTarget(
  blockNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): HoverTarget | null {
  const nameNode = blockNode.childForFieldName("name");
  if (!nameNode) return null;

  const moduleName = nameNode.text;
  const symbols = symbolIndex.getSymbol(moduleName);
  const symbol = symbols?.find((s) => s.fileUri === fileUri && s.kind === "module");

  const targetNode = identifierNode || nameNode;

  return {
    kind: "module",
    path: moduleName,
    node: symbol?.node as ModuleNode | undefined,
    symbol,
    range: {
      startLine: targetNode.startPosition.row,
      startColumn: targetNode.startPosition.column,
      endLine: targetNode.endPosition.row,
      endColumn: targetNode.endPosition.column,
    },
  };
}

/**
 * Build hover target for a feature.
 */
function buildFeatureTarget(
  blockNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): HoverTarget | null {
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

  const targetNode = identifierNode || nameNode;

  return {
    kind: "feature",
    path: featurePath,
    node: symbol?.node as FeatureNode | undefined,
    symbol,
    range: {
      startLine: targetNode.startPosition.row,
      startColumn: targetNode.startPosition.column,
      endLine: targetNode.endPosition.row,
      endColumn: targetNode.endPosition.column,
    },
  };
}

/**
 * Build hover target for a requirement.
 */
function buildRequirementTarget(
  blockNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): HoverTarget | null {
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

  const targetNode = identifierNode || nameNode;

  return {
    kind: "requirement",
    path: reqPath,
    node: symbol?.node as RequirementNode | undefined,
    symbol,
    range: {
      startLine: targetNode.startPosition.row,
      startColumn: targetNode.startPosition.column,
      endLine: targetNode.endPosition.row,
      endColumn: targetNode.endPosition.column,
    },
  };
}

/**
 * Build hover target for a constraint.
 */
function buildConstraintTarget(
  constraintNode: Node,
  identifierNode: Node | null,
  symbolIndex: CrossFileSymbolIndex,
  fileUri: string
): HoverTarget | null {
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

  const targetNode = identifierNode || nameNode;

  return {
    kind: "constraint",
    path: constraintPath,
    node: symbol?.node as ConstraintNode | undefined,
    symbol,
    range: {
      startLine: targetNode.startPosition.row,
      startColumn: targetNode.startPosition.column,
      endLine: targetNode.endPosition.row,
      endColumn: targetNode.endPosition.column,
    },
  };
}

/**
 * Build hover target for a reference in @depends-on.
 */
function buildReferenceTarget(referenceNode: Node, symbolIndex: CrossFileSymbolIndex): HoverTarget {
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
    path: refPath,
    symbol: resolved.symbol ?? undefined,
    range: {
      startLine: referenceNode.startPosition.row,
      startColumn: referenceNode.startPosition.column,
      endLine: referenceNode.endPosition.row,
      endColumn: referenceNode.endPosition.column,
    },
  };
}

/**
 * Build hover target for a description block.
 */
function buildDescriptionTarget(descriptionNode: Node): HoverTarget {
  // Extract description text from the description block
  const parts: string[] = [];
  for (const child of descriptionNode.children) {
    if (child.type === "description_text" || child.type === "code_block") {
      parts.push(child.text);
    }
  }
  const descriptionText = parts.join("\n").trim();

  return {
    kind: "description",
    descriptionText,
    range: {
      startLine: descriptionNode.startPosition.row,
      startColumn: descriptionNode.startPosition.column,
      endLine: descriptionNode.endPosition.row,
      endColumn: descriptionNode.endPosition.column,
    },
  };
}

/**
 * Build hover target for a keyword.
 */
function buildKeywordTarget(keywordNode: Node): HoverTarget {
  return {
    kind: "keyword",
    range: {
      startLine: keywordNode.startPosition.row,
      startColumn: keywordNode.startPosition.column,
      endLine: keywordNode.endPosition.row,
      endColumn: keywordNode.endPosition.column,
    },
  };
}

// ============================================================================
// Hover Content Building
// ============================================================================

/**
 * Build hover content for a target.
 */
export function buildHoverContent(
  target: HoverTarget,
  context: HoverContext
): MarkupContent | null {
  switch (target.kind) {
    case "requirement":
      return buildRequirementHover(target, context);
    case "feature":
      return buildFeatureHover(target, context);
    case "module":
      return buildModuleHover(target, context);
    case "constraint":
      return buildConstraintHover(target, context);
    case "reference":
      return buildReferenceHover(target, context);
    case "keyword":
      return buildKeywordHover(target);
    case "description":
      return buildDescriptionHover(target, context);
    default:
      return null;
  }
}

/**
 * Build hover content for a requirement.
 * Shows ticket info, status, constraint satisfaction, dependencies, and files.
 */
function buildRequirementHover(target: HoverTarget, context: HoverContext): MarkupContent | null {
  if (!target.path) return null;

  const ticketInfo = context.ticketMap.get(target.path);
  const blockingInfo = computeBlockingInfo(
    target.path,
    context.dependencyGraph,
    context.ticketMap,
    context.cycles
  );

  const lines: string[] = [];

  // Header
  lines.push(`### @requirement ${target.path.split(".").pop()}`);
  lines.push("");

  // Tickets section
  if (ticketInfo && ticketInfo.tickets.length > 0) {
    lines.push("**Tickets:**");
    for (const ticket of ticketInfo.tickets) {
      const statusIcon = getStatusIcon(ticket.status);
      lines.push(`- ${statusIcon} ${ticket.id}: ${ticket.description}`);
    }
    lines.push("");

    // Status
    lines.push(`**Status:** ${formatStatus(ticketInfo.status)}`);
    lines.push("");

    // Constraints
    if (ticketInfo.constraintsTotal > 0) {
      lines.push(
        `**Constraints:** ${ticketInfo.constraintsSatisfied}/${ticketInfo.constraintsTotal} satisfied`
      );
      for (const cs of ticketInfo.constraintStatuses) {
        const icon = cs.satisfied ? "\u2713" : "\u25CB";
        lines.push(`- ${icon} ${cs.name}`);
      }
      lines.push("");
    }

    // Implementation files
    if (ticketInfo.implementationFiles.length > 0) {
      lines.push("**Files:**");
      for (const file of ticketInfo.implementationFiles) {
        const fileLink = formatFileLink(file, context.workspaceFolderUris);
        lines.push(`- ${fileLink}`);
      }
      lines.push("");
    }

    // Test files
    if (ticketInfo.testFiles.length > 0) {
      lines.push("**Tests:**");
      for (const file of ticketInfo.testFiles) {
        const fileLink = formatFileLink(file, context.workspaceFolderUris);
        lines.push(`- ${fileLink}`);
      }
      lines.push("");
    }
  } else {
    lines.push("**Status:** No tickets");
    lines.push("");
  }

  // Dependencies / blocking info
  if (blockingInfo.status === "in-cycle") {
    lines.push("**Dependencies:** \u26A0 Part of circular dependency");
    if (blockingInfo.cycleInfo) {
      lines.push(`Cycle: ${blockingInfo.cycleInfo.cycle.cycle.join(" \u2192 ")}`);
    }
    lines.push("");
  } else if (blockingInfo.status === "blocked") {
    lines.push("**Dependencies:** \u2717 Blocked");
    for (const blocker of blockingInfo.directBlockers) {
      lines.push(`- \u25CB ${blocker.path} (${formatStatus(blocker.status)})`);
    }
    if (blockingInfo.transitiveBlockers.length > 0) {
      lines.push("*Transitive blockers:*");
      for (const blocker of blockingInfo.transitiveBlockers.slice(0, 3)) {
        lines.push(`- \u25CB ${blocker.path} (${formatStatus(blocker.status)})`);
      }
      if (blockingInfo.transitiveBlockers.length > 3) {
        lines.push(`- ... and ${blockingInfo.transitiveBlockers.length - 3} more`);
      }
    }
    lines.push("");
  } else {
    // Show direct dependencies if any
    const deps = context.dependencyGraph.getDependencies(target.path);
    if (deps.length > 0) {
      lines.push("**Dependencies:**");
      for (const dep of deps) {
        const depInfo = context.ticketMap.get(dep);
        const depStatus = depInfo?.status ?? "no-ticket";
        const icon = depStatus === "complete" ? "\u2713" : "\u25D0";
        lines.push(`- ${icon} ${dep} (${formatStatus(depStatus)})`);
      }
      lines.push("");
    }
  }

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

/**
 * Build hover content for a feature.
 * Shows aggregate progress and requirement list.
 */
function buildFeatureHover(target: HoverTarget, context: HoverContext): MarkupContent | null {
  if (!target.path) return null;

  const featureReqs = filterByPathPrefix(context.ticketMap, target.path);
  const summary = getCompletionSummary(featureReqs);

  const lines: string[] = [];

  // Header
  lines.push(`### @feature ${target.path.split(".").pop()}`);
  lines.push("");

  // Progress
  lines.push(`**Progress:** ${summary.complete}/${summary.total} requirements complete`);
  lines.push("");

  // Progress bar
  const progressBar = buildProgressBar(summary.percentComplete);
  lines.push(`${progressBar} ${summary.percentComplete}%`);
  lines.push("");

  // Requirements list
  if (summary.total > 0) {
    lines.push("**Requirements:**");
    for (const [path, info] of featureReqs) {
      // Only show direct children (requirements of this feature)
      const pathParts = path.split(".");
      const featureParts = target.path.split(".");
      if (pathParts.length !== featureParts.length + 1) continue;

      const reqName = pathParts[pathParts.length - 1];
      const icon = getStatusIcon(info.status);
      let line = `- ${icon} ${reqName} (${formatStatus(info.status)})`;

      // Check if blocked
      const blockingInfo = computeBlockingInfo(
        path,
        context.dependencyGraph,
        context.ticketMap,
        context.cycles
      );
      if (blockingInfo.status === "blocked") {
        line += " - blocked";
      } else if (blockingInfo.status === "in-cycle") {
        line += " - in cycle";
      }

      lines.push(line);
    }
    lines.push("");
  }

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

/**
 * Build hover content for a module.
 * Shows aggregate progress and feature/requirement summary.
 */
function buildModuleHover(target: HoverTarget, context: HoverContext): MarkupContent | null {
  if (!target.path) return null;

  const moduleReqs = filterByPathPrefix(context.ticketMap, target.path);
  const summary = getCompletionSummary(moduleReqs);

  const lines: string[] = [];

  // Header
  lines.push(`### @module ${target.path}`);
  lines.push("");

  // Progress
  lines.push(`**Progress:** ${summary.complete}/${summary.total} requirements complete`);
  lines.push("");

  // Progress bar
  const progressBar = buildProgressBar(summary.percentComplete);
  lines.push(`${progressBar} ${summary.percentComplete}%`);
  lines.push("");

  // Status breakdown
  if (summary.total > 0) {
    lines.push("**Status breakdown:**");
    if (summary.complete > 0) lines.push(`- \u2713 Complete: ${summary.complete}`);
    if (summary.inProgress > 0) lines.push(`- \u25D0 In progress: ${summary.inProgress}`);
    if (summary.pending > 0) lines.push(`- \u25CB Pending: ${summary.pending}`);
    if (summary.noTicket > 0) lines.push(`- \u2014 No ticket: ${summary.noTicket}`);
    if (summary.obsolete > 0) lines.push(`- \u2717 Obsolete: ${summary.obsolete}`);
    lines.push("");
  }

  // Features list (if the module node is available)
  if (target.node && "features" in target.node) {
    const moduleNode = target.node as ModuleNode;
    if (moduleNode.features.length > 0) {
      lines.push("**Features:**");
      for (const feature of moduleNode.features) {
        const featurePath = `${target.path}.${feature.name}`;
        const featureReqs = filterByPathPrefix(context.ticketMap, featurePath);
        const featureSummary = getCompletionSummary(featureReqs);
        lines.push(
          `- ${feature.name}: ${featureSummary.complete}/${featureSummary.total} complete`
        );
      }
      lines.push("");
    }
  }

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

/**
 * Build hover content for a constraint.
 */
function buildConstraintHover(target: HoverTarget, context: HoverContext): MarkupContent | null {
  if (!target.path) return null;

  const lines: string[] = [];

  // Get constraint name from path
  const pathParts = target.path.split(".");
  const constraintName = pathParts[pathParts.length - 1];

  // Header
  lines.push(`### @constraint ${constraintName}`);
  lines.push("");

  // Get parent requirement path
  const parentPath = pathParts.slice(0, -1).join(".");
  const ticketInfo = context.ticketMap.get(parentPath);

  if (ticketInfo) {
    // Find this constraint's status
    const constraintStatus = ticketInfo.constraintStatuses.find((cs) => cs.name === constraintName);

    if (constraintStatus) {
      const icon = constraintStatus.satisfied ? "\u2713" : "\u25CB";
      lines.push(
        `**Status:** ${icon} ${constraintStatus.satisfied ? "Satisfied" : "Not satisfied"}`
      );

      if (constraintStatus.satisfiedBy.length > 0) {
        lines.push("");
        lines.push("**Satisfied by:**");
        for (const ticketId of constraintStatus.satisfiedBy) {
          lines.push(`- ${ticketId}`);
        }
      }
    } else {
      lines.push("**Status:** Not tracked");
    }
  } else {
    lines.push("**Status:** No tickets for parent requirement");
  }

  // Show description if available
  if (target.node && "description" in target.node) {
    const constraintNode = target.node as ConstraintNode;
    if (constraintNode.description) {
      lines.push("");
      lines.push("**Description:**");
      lines.push(constraintNode.description);
    }
  }

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

/**
 * Build hover content for a reference.
 */
function buildReferenceHover(target: HoverTarget, context: HoverContext): MarkupContent | null {
  if (!target.path) return null;

  const lines: string[] = [];

  if (target.symbol) {
    // Resolved reference
    lines.push(`### ${target.symbol.kind}: ${target.path}`);
    lines.push("");

    // Show status if it's a requirement
    if (target.symbol.kind === "requirement") {
      const ticketInfo = context.ticketMap.get(target.path);
      if (ticketInfo) {
        lines.push(`**Status:** ${formatStatus(ticketInfo.status)}`);
        if (ticketInfo.constraintsTotal > 0) {
          lines.push(
            `**Constraints:** ${ticketInfo.constraintsSatisfied}/${ticketInfo.constraintsTotal} satisfied`
          );
        }
      } else {
        lines.push("**Status:** No tickets");
      }
    } else if (target.symbol.kind === "feature" || target.symbol.kind === "module") {
      // Show progress for features/modules
      const reqs = filterByPathPrefix(context.ticketMap, target.path);
      const summary = getCompletionSummary(reqs);
      lines.push(`**Progress:** ${summary.complete}/${summary.total} requirements complete`);
    }

    lines.push("");
    lines.push(`*Defined in: ${target.symbol.fileUri}*`);
  } else {
    // Unresolved reference
    lines.push(`### \u26A0 Unresolved reference: ${target.path}`);
    lines.push("");
    lines.push("This reference does not resolve to any known module, feature, or requirement.");
  }

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

/**
 * Build hover content for a keyword.
 */
function buildKeywordHover(_target: HoverTarget): MarkupContent | null {
  const lines: string[] = [];

  // We don't have direct access to the keyword text in target,
  // but we can provide generic info based on what keywords exist
  lines.push("### Blueprint DSL Keyword");
  lines.push("");
  lines.push("Blueprint keywords define the structure of requirements:");
  lines.push("- `@module` - Major system boundaries");
  lines.push("- `@feature` - User-facing capabilities");
  lines.push("- `@requirement` - Specific implementable units");
  lines.push("- `@constraint` - Implementation requirements");
  lines.push("- `@depends-on` - Dependencies on other elements");
  lines.push("- `@description` - Document-level description");

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

/**
 * Build hover content for a description block.
 * Shows the document-level description and overall project context.
 */
function buildDescriptionHover(target: HoverTarget, context: HoverContext): MarkupContent | null {
  const lines: string[] = [];

  // Header
  lines.push("### @description");
  lines.push("");
  lines.push("Document-level description providing context for this requirements file.");
  lines.push("");

  // Show the description text if available
  if (target.descriptionText) {
    lines.push("**Content:**");
    lines.push("");
    lines.push(target.descriptionText);
    lines.push("");
  }

  // Show overall document progress
  const allReqs = context.ticketMap;
  if (allReqs.size > 0) {
    const summary = getCompletionSummary(allReqs);
    lines.push("---");
    lines.push("");
    lines.push("**Document Progress:**");
    lines.push(`${summary.complete}/${summary.total} requirements complete`);
    lines.push("");
    const progressBar = buildProgressBar(summary.percentComplete);
    lines.push(`${progressBar} ${summary.percentComplete}%`);
  }

  return {
    kind: MarkupKind.Markdown,
    value: lines.join("\n"),
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Display information for a status value.
 * Centralizes icon and formatted text to ensure they stay in sync.
 */
interface StatusDisplayInfo {
  /** Icon character for the status */
  icon: string;
  /** Human-readable formatted text */
  text: string;
}

/**
 * Map of status values to their display information.
 * Using a const object ensures icon and text are always paired correctly.
 */
const STATUS_DISPLAY: Record<string, StatusDisplayInfo> = {
  complete: { icon: "\u2713", text: "complete" }, // checkmark
  "in-progress": { icon: "\u25D0", text: "in progress" }, // half circle
  pending: { icon: "\u25CB", text: "pending" }, // empty circle
  obsolete: { icon: "\u2717", text: "obsolete" }, // X
  "no-ticket": { icon: "\u2014", text: "no ticket" }, // em dash
};

/** Default display info for unknown statuses */
const DEFAULT_STATUS_DISPLAY: StatusDisplayInfo = {
  icon: "\u25CB", // empty circle
  text: "unknown",
};

/**
 * Get display information for a status.
 * Returns both icon and formatted text to ensure consistency.
 */
function getStatusDisplay(status: string): StatusDisplayInfo {
  return STATUS_DISPLAY[status] ?? { ...DEFAULT_STATUS_DISPLAY, text: status };
}

/**
 * Get an icon for a ticket/requirement status.
 */
function getStatusIcon(status: string): string {
  return getStatusDisplay(status).icon;
}

/**
 * Format a status for display.
 */
function formatStatus(status: string): string {
  return getStatusDisplay(status).text;
}

/**
 * Build a text-based progress bar.
 */
function buildProgressBar(percent: number): string {
  const filled = Math.round(percent / 5); // 20 chars total
  const empty = 20 - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

/**
 * Format a file path as a clickable Markdown link.
 * If workspace folders are available, resolves relative paths to file:// URIs.
 * Falls back to plain text if the path cannot be resolved.
 */
export function formatFileLink(filePath: string, workspaceFolderUris?: string[]): string {
  // If no workspace folders, return plain text
  if (!workspaceFolderUris || workspaceFolderUris.length === 0) {
    return filePath;
  }

  // If the path is already absolute, convert directly to URI
  if (isAbsolute(filePath)) {
    const fileUri = URI.file(filePath).toString();
    return `[${filePath}](${fileUri})`;
  }

  // Resolve relative path against the first workspace folder
  // In multi-root workspaces, the first folder is typically the primary one
  const firstWorkspaceUri = workspaceFolderUris[0];
  if (!firstWorkspaceUri) {
    return filePath;
  }

  const workspaceUri = URI.parse(firstWorkspaceUri);
  const absolutePath = join(workspaceUri.fsPath, filePath);
  const fileUri = URI.file(absolutePath).toString();

  return `[${filePath}](${fileUri})`;
}

/**
 * Convert HoverTarget range to LSP Range format.
 */
export function targetRangeToLspRange(target: HoverTarget): {
  start: Position;
  end: Position;
} {
  return {
    start: {
      line: target.range.startLine,
      character: target.range.startColumn,
    },
    end: {
      line: target.range.endLine,
      character: target.range.endColumn,
    },
  };
}

/**
 * Build a complete Hover response.
 */
export function buildHover(target: HoverTarget, context: HoverContext): Hover | null {
  const content = buildHoverContent(target, context);
  if (!content) return null;

  return {
    contents: content,
    range: targetRangeToLspRange(target),
  };
}
