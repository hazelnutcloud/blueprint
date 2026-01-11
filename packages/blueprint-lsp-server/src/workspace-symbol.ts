import type { SymbolInformation, SymbolKind, Location } from "vscode-languageserver/node";
import type { CrossFileSymbolIndex, IndexedSymbol, SymbolKind as BlueprintSymbolKind } from "./symbol-index";

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
const SYMBOL_KIND_MAP: Record<BlueprintSymbolKind, SymbolKind> = {
  module: 2 as SymbolKind,      // SymbolKind.Module
  feature: 5 as SymbolKind,     // SymbolKind.Class
  requirement: 12 as SymbolKind, // SymbolKind.Function
  constraint: 14 as SymbolKind,  // SymbolKind.Constant
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert an IndexedSymbol to a Location.
 */
function symbolToLocation(symbol: IndexedSymbol): Location {
  const node = symbol.node;
  return {
    uri: symbol.fileUri,
    range: {
      start: {
        line: node.location.startLine,
        character: node.location.startColumn,
      },
      end: {
        line: node.location.endLine,
        character: node.location.endColumn,
      },
    },
  };
}

/**
 * Get the container name for a symbol.
 * For features, this is the module name.
 * For requirements, this is "module.feature".
 * For constraints, this is the parent path.
 */
function getContainerName(symbol: IndexedSymbol): string | undefined {
  const parts = symbol.path.split(".");
  if (parts.length <= 1) {
    return undefined;
  }
  // Return all parts except the last one as the container
  return parts.slice(0, -1).join(".");
}

/**
 * Check if a symbol matches a query string.
 * Matching is case-insensitive and supports:
 * - Prefix matching (query matches start of name)
 * - Substring matching (query is contained in name)
 * - Fuzzy matching (query characters appear in order in name)
 */
function matchesQuery(symbol: IndexedSymbol, query: string): boolean {
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
 * Calculate a relevance score for sorting results.
 * Higher scores are better matches.
 */
function calculateScore(symbol: IndexedSymbol, query: string): number {
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
    return 60 - nameIdx;
  }
  
  // Substring match on path
  if (path.includes(lowerQuery)) {
    return 40;
  }
  
  // Fuzzy match (fallback)
  return 20;
}

// ============================================================================
// Main Export Functions
// ============================================================================

/**
 * Build workspace symbols from the cross-file symbol index.
 * 
 * Returns a flat list of SymbolInformation objects matching the query.
 * Results are sorted by relevance to the query.
 * 
 * @param symbolIndex The cross-file symbol index
 * @param query The search query (can be empty to return all symbols)
 * @param maxResults Maximum number of results to return (default: 100)
 */
export function buildWorkspaceSymbols(
  symbolIndex: CrossFileSymbolIndex,
  query: string,
  maxResults: number = 100
): SymbolInformation[] {
  const results: Array<{ symbol: IndexedSymbol; score: number }> = [];
  
  // Collect all symbols from the index
  const kinds: BlueprintSymbolKind[] = ["module", "feature", "requirement", "constraint"];
  
  for (const kind of kinds) {
    const symbols = symbolIndex.getSymbolsByKind(kind);
    for (const symbol of symbols) {
      if (matchesQuery(symbol, query)) {
        const score = calculateScore(symbol, query);
        results.push({ symbol, score });
      }
    }
  }
  
  // Sort by score (descending), then by name (ascending)
  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const nameA = a.symbol.node.name ?? "";
    const nameB = b.symbol.node.name ?? "";
    return nameA.localeCompare(nameB);
  });
  
  // Limit results and convert to SymbolInformation
  return results.slice(0, maxResults).map(({ symbol }) => 
    indexedSymbolToSymbolInformation(symbol)
  );
}

/**
 * Convert an IndexedSymbol to an LSP SymbolInformation.
 */
export function indexedSymbolToSymbolInformation(symbol: IndexedSymbol): SymbolInformation {
  return {
    name: symbol.node.name ?? "(unnamed)",
    kind: SYMBOL_KIND_MAP[symbol.kind],
    location: symbolToLocation(symbol),
    containerName: getContainerName(symbol),
  };
}

/**
 * Get all symbols from the index as SymbolInformation.
 * Useful for testing and debugging.
 */
export function getAllSymbolsAsSymbolInformation(
  symbolIndex: CrossFileSymbolIndex
): SymbolInformation[] {
  return buildWorkspaceSymbols(symbolIndex, "", Number.MAX_SAFE_INTEGER);
}
