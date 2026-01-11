import type { DocumentSymbol, SymbolKind } from "vscode-languageserver/node";
import type { Tree } from "./parser";
import {
  transformToAST,
  type DocumentNode,
  type ModuleNode,
  type FeatureNode,
  type RequirementNode,
  type ConstraintNode,
  type SourceLocation,
} from "./ast";

// ============================================================================
// Constants
// ============================================================================

/**
 * LSP SymbolKind values for Blueprint elements.
 * 
 * Per LSP specification, SymbolKind is an enum:
 * - Module = 2 (used for @module)
 * - Class = 5 (used for @feature - represents a grouping of methods/functions)
 * - Function = 12 (used for @requirement - represents an implementable unit)
 * - Constant = 14 (used for @constraint - represents a fixed rule)
 */
const SYMBOL_KIND = {
  MODULE: 2 as SymbolKind,     // SymbolKind.Module
  FEATURE: 5 as SymbolKind,    // SymbolKind.Class
  REQUIREMENT: 12 as SymbolKind, // SymbolKind.Function
  CONSTRAINT: 14 as SymbolKind,  // SymbolKind.Constant
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert a SourceLocation to LSP Range format.
 */
function locationToRange(location: SourceLocation): DocumentSymbol["range"] {
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
 * Create the selection range for a symbol.
 * The selection range is typically just the identifier/name portion,
 * while the full range includes the entire block.
 * 
 * For Blueprint, we use the first line of the block as the selection range
 * since identifiers appear on the same line as the keyword.
 */
function createSelectionRange(location: SourceLocation): DocumentSymbol["selectionRange"] {
  return {
    start: {
      line: location.startLine,
      character: location.startColumn,
    },
    end: {
      line: location.startLine,
      character: location.endColumn,
    },
  };
}

/**
 * Truncate a description for display as symbol detail.
 * Takes the first line or first 80 characters, whichever is shorter.
 */
function truncateDescription(description: string): string | undefined {
  if (!description) {
    return undefined;
  }
  
  const lines = description.split("\n");
  const firstLine = (lines[0] ?? "").trim();
  if (!firstLine) {
    return undefined;
  }
  
  if (firstLine.length <= 80) {
    return firstLine;
  }
  
  return firstLine.slice(0, 77) + "...";
}

// ============================================================================
// Symbol Building Functions
// ============================================================================

/**
 * Build a DocumentSymbol for a constraint.
 */
function buildConstraintSymbol(constraint: ConstraintNode): DocumentSymbol {
  return {
    name: constraint.name || "(unnamed)",
    kind: SYMBOL_KIND.CONSTRAINT,
    detail: truncateDescription(constraint.description),
    range: locationToRange(constraint.location),
    selectionRange: createSelectionRange(constraint.location),
  };
}

/**
 * Build a DocumentSymbol for a requirement, including its constraints as children.
 */
function buildRequirementSymbol(requirement: RequirementNode): DocumentSymbol {
  const children: DocumentSymbol[] = [];
  
  // Add constraints as children
  for (const constraint of requirement.constraints) {
    children.push(buildConstraintSymbol(constraint));
  }
  
  return {
    name: requirement.name || "(unnamed)",
    kind: SYMBOL_KIND.REQUIREMENT,
    detail: truncateDescription(requirement.description),
    range: locationToRange(requirement.location),
    selectionRange: createSelectionRange(requirement.location),
    children: children.length > 0 ? children : undefined,
  };
}

/**
 * Build a DocumentSymbol for a feature, including its requirements and constraints as children.
 */
function buildFeatureSymbol(feature: FeatureNode): DocumentSymbol {
  const children: DocumentSymbol[] = [];
  
  // Add feature-level constraints
  for (const constraint of feature.constraints) {
    children.push(buildConstraintSymbol(constraint));
  }
  
  // Add requirements
  for (const requirement of feature.requirements) {
    children.push(buildRequirementSymbol(requirement));
  }
  
  return {
    name: feature.name || "(unnamed)",
    kind: SYMBOL_KIND.FEATURE,
    detail: truncateDescription(feature.description),
    range: locationToRange(feature.location),
    selectionRange: createSelectionRange(feature.location),
    children: children.length > 0 ? children : undefined,
  };
}

/**
 * Build a DocumentSymbol for a module, including its features, requirements, and constraints as children.
 */
function buildModuleSymbol(module: ModuleNode): DocumentSymbol {
  const children: DocumentSymbol[] = [];
  
  // Add module-level constraints
  for (const constraint of module.constraints) {
    children.push(buildConstraintSymbol(constraint));
  }
  
  // Add module-level requirements (requirements directly in module, not in a feature)
  for (const requirement of module.requirements) {
    children.push(buildRequirementSymbol(requirement));
  }
  
  // Add features
  for (const feature of module.features) {
    children.push(buildFeatureSymbol(feature));
  }
  
  return {
    name: module.name || "(unnamed)",
    kind: SYMBOL_KIND.MODULE,
    detail: truncateDescription(module.description),
    range: locationToRange(module.location),
    selectionRange: createSelectionRange(module.location),
    children: children.length > 0 ? children : undefined,
  };
}

// ============================================================================
// Main Export Functions
// ============================================================================

/**
 * Build document symbols from a parsed Blueprint document.
 * 
 * Returns a hierarchical list of DocumentSymbol objects representing:
 * - Modules (top-level)
 *   - Features (children of modules)
 *     - Requirements (children of features)
 *       - Constraints (children of requirements)
 *   - Requirements (module-level, not in a feature)
 *     - Constraints
 *   - Constraints (module-level)
 * 
 * Per SPEC.md Section 3.3, the hierarchy is:
 * - @module: Major system boundaries
 * - @feature: User-facing capabilities within a module
 * - @requirement: Specific implementable units within a feature
 * - @constraint: Implementation requirements within any level
 */
export function buildDocumentSymbols(tree: Tree): DocumentSymbol[] {
  const ast = transformToAST(tree);
  return buildDocumentSymbolsFromAST(ast);
}

/**
 * Build document symbols directly from an AST.
 * Useful when the AST is already available.
 */
export function buildDocumentSymbolsFromAST(doc: DocumentNode): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  
  // Add all modules as top-level symbols
  for (const module of doc.modules) {
    symbols.push(buildModuleSymbol(module));
  }
  
  return symbols;
}

/**
 * Count total symbols in a document symbol tree.
 * Useful for testing and diagnostics.
 */
export function countSymbols(symbols: DocumentSymbol[]): number {
  let count = 0;
  
  function countRecursive(syms: DocumentSymbol[]): void {
    for (const sym of syms) {
      count++;
      if (sym.children) {
        countRecursive(sym.children);
      }
    }
  }
  
  countRecursive(symbols);
  return count;
}

/**
 * Flatten a document symbol tree into a list.
 * Useful for testing and diagnostics.
 */
export function flattenSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  
  function flattenRecursive(syms: DocumentSymbol[]): void {
    for (const sym of syms) {
      result.push(sym);
      if (sym.children) {
        flattenRecursive(sym.children);
      }
    }
  }
  
  flattenRecursive(symbols);
  return result;
}
