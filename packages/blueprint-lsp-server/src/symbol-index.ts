import type {
  DocumentNode,
  ModuleNode,
  FeatureNode,
  RequirementNode,
  ConstraintNode,
  ReferenceNode,
  SymbolTable,
} from "./ast";
import { buildSymbolTable } from "./ast";

/**
 * Represents the kind of symbol in the index.
 */
export type SymbolKind = "module" | "feature" | "requirement" | "constraint";

/**
 * Represents a symbol entry in the cross-file index.
 */
export interface IndexedSymbol {
  /** The fully-qualified path of the symbol (e.g., "auth.login.basic-auth") */
  path: string;
  /** The kind of symbol */
  kind: SymbolKind;
  /** The URI of the file where this symbol is defined */
  fileUri: string;
  /** The AST node for this symbol */
  node: ModuleNode | FeatureNode | RequirementNode | ConstraintNode;
}

/**
 * Represents an unresolved reference found during cross-file analysis.
 */
export interface UnresolvedReference {
  /** The reference that could not be resolved */
  reference: ReferenceNode;
  /** The file URI where the reference was found */
  fileUri: string;
  /** The fully-qualified path of the element containing the reference */
  containingPath: string;
}

/**
 * Result of resolving a reference.
 */
export interface ResolvedReference {
  /** The resolved symbol, or null if not found */
  symbol: IndexedSymbol | null;
  /** Whether this is a partial match (e.g., reference to module matches all its children) */
  isPartialMatch: boolean;
  /** For partial matches, the matching symbols */
  matchingSymbols: IndexedSymbol[];
}

/**
 * Manages a cross-file symbol index for the Blueprint workspace.
 *
 * This class maintains a global registry of all symbols across all .bp files
 * in the workspace, enabling cross-file reference resolution and dependency
 * tracking.
 */
export class CrossFileSymbolIndex {
  /**
   * Maps fully-qualified symbol paths to their indexed entries.
   * A path may map to multiple entries if there are conflicts across files.
   */
  private globalSymbols: Map<string, IndexedSymbol[]> = new Map();

  /**
   * Maps file URIs to their symbol tables.
   * Used for quick file-level operations.
   */
  private fileSymbols: Map<string, SymbolTable> = new Map();

  /**
   * Maps file URIs to the set of symbols defined in that file.
   * Used for efficient file removal.
   */
  private symbolsByFile: Map<string, Set<string>> = new Map();

  /**
   * Maps file URIs to the references they contain (for dependency tracking).
   * Key: file URI, Value: array of { reference, containingPath }
   */
  private fileReferences: Map<string, Array<{ reference: ReferenceNode; containingPath: string }>> =
    new Map();

  /**
   * Cache for getSymbolsByKind() results.
   * This cache is invalidated when files are added or removed.
   * Key: symbol kind, Value: cached array of symbols of that kind
   */
  private symbolsByKindCache: Map<SymbolKind, IndexedSymbol[]> = new Map();

  /**
   * Add or update symbols from a parsed document.
   *
   * @param fileUri The URI of the file being indexed
   * @param document The parsed AST document
   */
  addFile(fileUri: string, document: DocumentNode): void {
    // Remove existing symbols for this file first
    this.removeFile(fileUri);

    // Invalidate the symbols-by-kind cache since we're adding new symbols
    this.symbolsByKindCache.clear();

    const { symbolTable } = buildSymbolTable(document);
    this.fileSymbols.set(fileUri, symbolTable);

    const fileSymbolPaths = new Set<string>();
    const references: Array<{ reference: ReferenceNode; containingPath: string }> = [];

    // Index modules
    for (const [path, node] of symbolTable.modules) {
      this.addSymbol(path, "module", fileUri, node);
      fileSymbolPaths.add(path);
      // Collect module-level dependencies
      for (const dep of node.dependencies) {
        for (const ref of dep.references) {
          references.push({ reference: ref, containingPath: path });
        }
      }
    }

    // Index features
    for (const [path, node] of symbolTable.features) {
      this.addSymbol(path, "feature", fileUri, node);
      fileSymbolPaths.add(path);
      // Collect feature-level dependencies
      for (const dep of node.dependencies) {
        for (const ref of dep.references) {
          references.push({ reference: ref, containingPath: path });
        }
      }
    }

    // Index requirements
    for (const [path, node] of symbolTable.requirements) {
      this.addSymbol(path, "requirement", fileUri, node);
      fileSymbolPaths.add(path);
      // Collect requirement-level dependencies
      for (const dep of node.dependencies) {
        for (const ref of dep.references) {
          references.push({ reference: ref, containingPath: path });
        }
      }
    }

    // Index constraints
    for (const [path, node] of symbolTable.constraints) {
      this.addSymbol(path, "constraint", fileUri, node);
      fileSymbolPaths.add(path);
    }

    this.symbolsByFile.set(fileUri, fileSymbolPaths);
    this.fileReferences.set(fileUri, references);
  }

  /**
   * Remove all symbols from a file.
   *
   * @param fileUri The URI of the file to remove
   */
  removeFile(fileUri: string): void {
    const paths = this.symbolsByFile.get(fileUri);
    if (!paths) {
      return;
    }

    // Invalidate the symbols-by-kind cache since we're removing symbols
    this.symbolsByKindCache.clear();

    for (const path of paths) {
      const symbols = this.globalSymbols.get(path);
      if (symbols) {
        const filtered = symbols.filter((s) => s.fileUri !== fileUri);
        if (filtered.length === 0) {
          this.globalSymbols.delete(path);
        } else {
          this.globalSymbols.set(path, filtered);
        }
      }
    }

    this.symbolsByFile.delete(fileUri);
    this.fileSymbols.delete(fileUri);
    this.fileReferences.delete(fileUri);
  }

  /**
   * Resolve a reference to its target symbol(s).
   *
   * References can be:
   * - Exact: "module.feature.requirement" matches exactly one requirement
   * - Partial: "module" matches the module and implicitly all its children
   * - Partial: "module.feature" matches the feature and all its requirements
   *
   * @param reference The reference to resolve
   * @returns The resolution result
   */
  resolveReference(reference: ReferenceNode): ResolvedReference {
    const path = reference.path;
    const symbols = this.globalSymbols.get(path);

    // Exact match
    if (symbols && symbols.length > 0) {
      return {
        symbol: symbols[0]!, // Return first match (there may be conflicts)
        isPartialMatch: false,
        matchingSymbols: symbols,
      };
    }

    // Try partial match - find all symbols that start with this path
    const matchingSymbols: IndexedSymbol[] = [];
    const prefix = path + ".";

    for (const [symbolPath, symbolList] of this.globalSymbols) {
      if (symbolPath.startsWith(prefix) || symbolPath === path) {
        matchingSymbols.push(...symbolList);
      }
    }

    if (matchingSymbols.length > 0) {
      return {
        symbol: matchingSymbols[0]!,
        isPartialMatch: true,
        matchingSymbols,
      };
    }

    // No match found
    return {
      symbol: null,
      isPartialMatch: false,
      matchingSymbols: [],
    };
  }

  /**
   * Get all unresolved references across all indexed files.
   *
   * @returns Array of unresolved references with their locations
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const unresolved: UnresolvedReference[] = [];

    for (const [fileUri, refs] of this.fileReferences) {
      for (const { reference, containingPath } of refs) {
        const resolved = this.resolveReference(reference);
        if (!resolved.symbol) {
          unresolved.push({
            reference,
            fileUri,
            containingPath,
          });
        }
      }
    }

    return unresolved;
  }

  /**
   * Get unresolved references for a specific file.
   *
   * @param fileUri The URI of the file to check
   * @returns Array of unresolved references in that file
   */
  getUnresolvedReferencesForFile(fileUri: string): UnresolvedReference[] {
    const refs = this.fileReferences.get(fileUri);
    if (!refs) {
      return [];
    }

    const unresolved: UnresolvedReference[] = [];
    for (const { reference, containingPath } of refs) {
      const resolved = this.resolveReference(reference);
      if (!resolved.symbol) {
        unresolved.push({
          reference,
          fileUri,
          containingPath,
        });
      }
    }

    return unresolved;
  }

  /**
   * Get all files that have references to symbols in the given file.
   * Used to determine which files need their diagnostics refreshed when a file changes.
   *
   * @param fileUri The URI of the file that changed
   * @returns Array of file URIs that depend on the changed file
   */
  getFilesDependingOn(fileUri: string): string[] {
    const symbolsInFile = this.symbolsByFile.get(fileUri);
    if (!symbolsInFile) {
      return [];
    }

    const dependentFiles = new Set<string>();

    for (const [otherFileUri, refs] of this.fileReferences) {
      if (otherFileUri === fileUri) {
        continue; // Skip self
      }

      for (const { reference } of refs) {
        const refPath = reference.path;
        // Check if this reference points to any symbol in the changed file
        for (const symbolPath of symbolsInFile) {
          if (
            symbolPath === refPath ||
            symbolPath.startsWith(refPath + ".") ||
            refPath.startsWith(symbolPath + ".")
          ) {
            dependentFiles.add(otherFileUri);
            break;
          }
        }
      }
    }

    return Array.from(dependentFiles);
  }

  /**
   * Get a symbol by its fully-qualified path.
   *
   * @param path The fully-qualified path
   * @returns The symbol(s) at that path, or undefined if not found
   */
  getSymbol(path: string): IndexedSymbol[] | undefined {
    return this.globalSymbols.get(path);
  }

  /**
   * Get all symbols of a specific kind.
   *
   * Results are cached for performance - the cache is invalidated when
   * files are added or removed from the index.
   *
   * @param kind The kind of symbols to retrieve
   * @returns Array of symbols of that kind
   */
  getSymbolsByKind(kind: SymbolKind): IndexedSymbol[] {
    // Check cache first
    const cached = this.symbolsByKindCache.get(kind);
    if (cached !== undefined) {
      return cached;
    }

    // Build the result
    const result: IndexedSymbol[] = [];
    for (const symbols of this.globalSymbols.values()) {
      for (const symbol of symbols) {
        if (symbol.kind === kind) {
          result.push(symbol);
        }
      }
    }

    // Cache the result
    this.symbolsByKindCache.set(kind, result);
    return result;
  }

  /**
   * Get all symbols defined in a specific file.
   *
   * @param fileUri The file URI
   * @returns Array of symbols defined in that file
   */
  getSymbolsInFile(fileUri: string): IndexedSymbol[] {
    const paths = this.symbolsByFile.get(fileUri);
    if (!paths) {
      return [];
    }

    const result: IndexedSymbol[] = [];
    for (const path of paths) {
      const symbols = this.globalSymbols.get(path);
      if (symbols) {
        for (const symbol of symbols) {
          if (symbol.fileUri === fileUri) {
            result.push(symbol);
          }
        }
      }
    }
    return result;
  }

  /**
   * Get the symbol table for a specific file.
   *
   * @param fileUri The file URI
   * @returns The symbol table for that file, or undefined if not indexed
   */
  getFileSymbolTable(fileUri: string): SymbolTable | undefined {
    return this.fileSymbols.get(fileUri);
  }

  /**
   * Check if a symbol path exists in the index.
   *
   * @param path The fully-qualified path to check
   * @returns True if the symbol exists
   */
  hasSymbol(path: string): boolean {
    return this.globalSymbols.has(path);
  }

  /**
   * Get all indexed file URIs.
   *
   * @returns Array of file URIs that have been indexed
   */
  getIndexedFiles(): string[] {
    return Array.from(this.fileSymbols.keys());
  }

  /**
   * Get the total number of symbols in the index.
   *
   * @returns The count of unique symbol paths
   */
  getSymbolCount(): number {
    return this.globalSymbols.size;
  }

  /**
   * Get the total number of indexed files.
   *
   * @returns The count of indexed files
   */
  getFileCount(): number {
    return this.fileSymbols.size;
  }

  /**
   * Check if there are any symbol conflicts (same path defined in multiple files).
   *
   * @returns Array of paths that have conflicts
   */
  getConflictingPaths(): string[] {
    const conflicts: string[] = [];
    for (const [path, symbols] of this.globalSymbols) {
      const uniqueFiles = new Set(symbols.map((s) => s.fileUri));
      if (uniqueFiles.size > 1) {
        conflicts.push(path);
      }
    }
    return conflicts;
  }

  /**
   * Clear all indexed data.
   */
  clear(): void {
    this.globalSymbols.clear();
    this.fileSymbols.clear();
    this.symbolsByFile.clear();
    this.fileReferences.clear();
    this.symbolsByKindCache.clear();
  }

  /**
   * Get all symbols that transitively depend on a given symbol path.
   * This is useful for detecting circular dependencies.
   *
   * @param targetPath The path of the symbol to check dependents for
   * @returns Set of symbol paths that depend on the target (directly or transitively)
   */
  getTransitiveDependents(targetPath: string): Set<string> {
    const dependents = new Set<string>();
    const visited = new Set<string>();
    const queue: string[] = [targetPath];

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      if (visited.has(currentPath)) {
        continue;
      }
      visited.add(currentPath);

      // Find all symbols that have a direct dependency on currentPath
      for (const [_fileUri, refs] of this.fileReferences) {
        for (const { reference, containingPath } of refs) {
          // Check if this reference points to currentPath or a child of it
          if (
            reference.path === currentPath ||
            reference.path.startsWith(currentPath + ".") ||
            currentPath.startsWith(reference.path + ".")
          ) {
            if (!dependents.has(containingPath) && containingPath !== targetPath) {
              dependents.add(containingPath);
              queue.push(containingPath);
            }
          }
        }
      }
    }

    return dependents;
  }

  /**
   * Check if adding a dependency from sourceSymbol to targetSymbol would create a cycle.
   * Returns true if targetSymbol (or any of its transitive dependencies) depends on sourceSymbol.
   *
   * @param sourceSymbolPath The symbol that wants to add a dependency
   * @param targetSymbolPath The symbol that would be depended upon
   * @returns True if adding this dependency would create a circular dependency
   */
  wouldCreateCircularDependency(sourceSymbolPath: string, targetSymbolPath: string): boolean {
    // If target already depends on source (directly or transitively), adding source -> target creates a cycle
    const targetDependencies = this.getTransitiveDependencies(targetSymbolPath);
    return targetDependencies.has(sourceSymbolPath);
  }

  /**
   * Get all symbols that a given symbol path depends on (transitively).
   *
   * @param symbolPath The path of the symbol to get dependencies for
   * @returns Set of symbol paths that are dependencies
   */
  getTransitiveDependencies(symbolPath: string): Set<string> {
    const dependencies = new Set<string>();
    const visited = new Set<string>();
    const queue: string[] = [symbolPath];

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      if (visited.has(currentPath)) {
        continue;
      }
      visited.add(currentPath);

      // Find the file that contains this symbol
      const symbols = this.globalSymbols.get(currentPath);
      if (!symbols || symbols.length === 0) {
        continue;
      }

      const fileUri = symbols[0]!.fileUri;
      const refs = this.fileReferences.get(fileUri);
      if (!refs) {
        continue;
      }

      // Find all references from this symbol
      for (const { reference, containingPath } of refs) {
        if (containingPath === currentPath || currentPath.startsWith(containingPath + ".")) {
          const depPath = reference.path;
          if (!dependencies.has(depPath) && depPath !== symbolPath) {
            dependencies.add(depPath);
            queue.push(depPath);
          }
        }
      }
    }

    return dependencies;
  }

  /**
   * Add a symbol to the global index.
   */
  private addSymbol(
    path: string,
    kind: SymbolKind,
    fileUri: string,
    node: ModuleNode | FeatureNode | RequirementNode | ConstraintNode
  ): void {
    const entry: IndexedSymbol = { path, kind, fileUri, node };
    const existing = this.globalSymbols.get(path);
    if (existing) {
      existing.push(entry);
    } else {
      this.globalSymbols.set(path, [entry]);
    }
  }
}
