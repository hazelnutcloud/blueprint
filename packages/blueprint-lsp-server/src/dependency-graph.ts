import type { ReferenceNode } from "./ast";
import type { CrossFileSymbolIndex } from "./symbol-index";

/**
 * Represents an edge in the dependency graph.
 */
export interface DependencyEdge {
  /** The symbol path that has the dependency */
  from: string;
  /** The symbol path being depended on */
  to: string;
  /** The reference node that created this edge (for location info) */
  reference: ReferenceNode;
  /** The file URI where the dependency is declared */
  fileUri: string;
}

/**
 * Represents a detected circular dependency.
 */
export interface CircularDependency {
  /** The cycle path, e.g., ["a", "b", "c", "a"] where the last element repeats the first */
  cycle: string[];
  /** The edges that form this cycle */
  edges: DependencyEdge[];
}

/**
 * Result of building a dependency graph.
 */
export interface DependencyGraphResult {
  /** All edges in the dependency graph */
  edges: DependencyEdge[];
  /** Detected circular dependencies */
  cycles: CircularDependency[];
  /** Symbols in topologically sorted order (only valid if no cycles) */
  topologicalOrder: string[];
  /** Whether the graph is acyclic */
  isAcyclic: boolean;
}

/**
 * Represents a node in the dependency graph with its adjacencies.
 */
interface GraphNode {
  /** Outgoing edges (symbols this node depends on) */
  dependencies: Set<string>;
  /** Incoming edges (symbols that depend on this node) */
  dependents: Set<string>;
}

/**
 * Builds and analyzes dependency graphs from the symbol index.
 *
 * This class constructs a directed graph from @depends-on declarations
 * and provides cycle detection, topological sorting, and blocking status
 * computation.
 */
export class DependencyGraph {
  /** Adjacency list representation of the graph */
  private nodes: Map<string, GraphNode> = new Map();

  /** All edges in the graph */
  private edges: DependencyEdge[] = [];

  /** Mapping from edge key to edge for lookup */
  private edgeMap: Map<string, DependencyEdge> = new Map();

  /**
   * Build a dependency graph from a symbol index.
   *
   * @param index The cross-file symbol index containing all symbols and references
   * @returns The dependency graph result with edges, cycles, and topological order
   */
  static build(index: CrossFileSymbolIndex): DependencyGraphResult {
    const graph = new DependencyGraph();
    return graph.buildFromIndex(index);
  }

  /**
   * Build the graph from the symbol index.
   */
  private buildFromIndex(index: CrossFileSymbolIndex): DependencyGraphResult {
    // First, add all symbols as nodes
    for (const fileUri of index.getIndexedFiles()) {
      const symbols = index.getSymbolsInFile(fileUri);
      for (const symbol of symbols) {
        this.ensureNode(symbol.path);
      }
    }

    // Then, add edges from @depends-on declarations
    for (const fileUri of index.getIndexedFiles()) {
      const symbolTable = index.getFileSymbolTable(fileUri);
      if (!symbolTable) continue;

      // Process module dependencies
      for (const [path, module] of symbolTable.modules) {
        for (const dep of module.dependencies) {
          for (const ref of dep.references) {
            this.addEdgeFromReference(path, ref, fileUri, index);
          }
        }
      }

      // Process feature dependencies
      for (const [path, feature] of symbolTable.features) {
        for (const dep of feature.dependencies) {
          for (const ref of dep.references) {
            this.addEdgeFromReference(path, ref, fileUri, index);
          }
        }
      }

      // Process requirement dependencies
      for (const [path, requirement] of symbolTable.requirements) {
        for (const dep of requirement.dependencies) {
          for (const ref of dep.references) {
            this.addEdgeFromReference(path, ref, fileUri, index);
          }
        }
      }
    }

    // Detect cycles
    const cycles = this.detectCycles();

    // Compute topological order (only valid if no cycles)
    const topologicalOrder = cycles.length === 0 ? this.topologicalSort() : [];

    return {
      edges: this.edges,
      cycles,
      topologicalOrder,
      isAcyclic: cycles.length === 0,
    };
  }

  /**
   * Add an edge from a reference, resolving it to target symbol(s).
   */
  private addEdgeFromReference(
    fromPath: string,
    reference: ReferenceNode,
    fileUri: string,
    index: CrossFileSymbolIndex
  ): void {
    const resolved = index.resolveReference(reference);

    if (resolved.symbol) {
      // For exact matches, add edge to the specific symbol
      // For partial matches (e.g., @depends-on module), we interpret
      // it as depending on the referenced element itself
      const toPath = resolved.symbol.path;
      this.addEdge(fromPath, toPath, reference, fileUri);
    }
    // If unresolved, we don't add an edge (diagnostics handle unresolved refs separately)
  }

  /**
   * Add an edge to the graph.
   */
  private addEdge(
    from: string,
    to: string,
    reference: ReferenceNode,
    fileUri: string
  ): void {
    // Don't add self-loops (they're technically cycles but not very useful)
    if (from === to) {
      return;
    }

    const edgeKey = `${from}->${to}`;
    if (this.edgeMap.has(edgeKey)) {
      return; // Edge already exists
    }

    const edge: DependencyEdge = { from, to, reference, fileUri };
    this.edges.push(edge);
    this.edgeMap.set(edgeKey, edge);

    this.ensureNode(from);
    this.ensureNode(to);

    this.nodes.get(from)!.dependencies.add(to);
    this.nodes.get(to)!.dependents.add(from);
  }

  /**
   * Ensure a node exists in the graph.
   */
  private ensureNode(path: string): void {
    if (!this.nodes.has(path)) {
      this.nodes.set(path, {
        dependencies: new Set(),
        dependents: new Set(),
      });
    }
  }

  /**
   * Detect all cycles in the graph using DFS-based cycle detection.
   *
   * Uses Tarjan's strongly connected components algorithm modified
   * to return the actual cycle paths.
   */
  private detectCycles(): CircularDependency[] {
    const cycles: CircularDependency[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): void => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const nodeData = this.nodes.get(node);
      if (nodeData) {
        for (const neighbor of nodeData.dependencies) {
          if (!visited.has(neighbor)) {
            dfs(neighbor);
          } else if (recursionStack.has(neighbor)) {
            // Found a cycle - extract it
            const cycleStart = path.indexOf(neighbor);
            const cyclePath = [...path.slice(cycleStart), neighbor];
            const cycleEdges = this.extractCycleEdges(cyclePath);

            // Check if we already have this cycle (cycles can be found multiple times)
            if (!this.hasDuplicateCycle(cycles, cyclePath)) {
              cycles.push({
                cycle: cyclePath,
                edges: cycleEdges,
              });
            }
          }
        }
      }

      path.pop();
      recursionStack.delete(node);
    };

    // Run DFS from each unvisited node
    for (const node of this.nodes.keys()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  /**
   * Extract the edges that form a cycle.
   */
  private extractCycleEdges(cyclePath: string[]): DependencyEdge[] {
    const edges: DependencyEdge[] = [];

    for (let i = 0; i < cyclePath.length - 1; i++) {
      const from = cyclePath[i]!;
      const to = cyclePath[i + 1]!;
      const edgeKey = `${from}->${to}`;
      const edge = this.edgeMap.get(edgeKey);
      if (edge) {
        edges.push(edge);
      }
    }

    return edges;
  }

  /**
   * Check if we already have a cycle that's equivalent to the given one.
   * Cycles are equivalent if they contain the same nodes in the same order,
   * just starting from a different position.
   */
  private hasDuplicateCycle(
    existing: CircularDependency[],
    newCycle: string[]
  ): boolean {
    // Remove the duplicate last element for comparison
    const cycleNodes = newCycle.slice(0, -1);

    for (const existingCycle of existing) {
      const existingNodes = existingCycle.cycle.slice(0, -1);

      if (cycleNodes.length !== existingNodes.length) {
        continue;
      }

      // Check if it's the same cycle starting from a different point
      const normalized = this.normalizeCycle(cycleNodes);
      const existingNormalized = this.normalizeCycle(existingNodes);

      if (normalized === existingNormalized) {
        return true;
      }
    }

    return false;
  }

  /**
   * Normalize a cycle by rotating it to start with the lexicographically smallest element.
   */
  private normalizeCycle(cycle: string[]): string {
    if (cycle.length === 0) return "";

    let minIndex = 0;
    for (let i = 1; i < cycle.length; i++) {
      if (cycle[i]! < cycle[minIndex]!) {
        minIndex = i;
      }
    }

    // Rotate to start from minIndex
    const rotated = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
    return rotated.join("->");
  }

  /**
   * Compute a topological ordering of the graph.
   * Only valid if the graph is acyclic.
   *
   * Uses Kahn's algorithm. The ordering ensures that if A depends-on B,
   * then B appears before A in the result (dependencies come first).
   */
  private topologicalSort(): string[] {
    const outDegree = new Map<string, number>();
    const result: string[] = [];

    // Initialize out-degrees (count of dependencies each node has)
    // A node with no dependencies can be processed first
    for (const [path, node] of this.nodes) {
      outDegree.set(path, node.dependencies.size);
    }

    // Find all nodes with no dependencies (they come first)
    const queue: string[] = [];
    for (const [path, degree] of outDegree) {
      if (degree === 0) {
        queue.push(path);
      }
    }

    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      // For each node that depends on this one, reduce their out-degree
      const nodeData = this.nodes.get(node);
      if (nodeData) {
        for (const dependent of nodeData.dependents) {
          const newDegree = outDegree.get(dependent)! - 1;
          outDegree.set(dependent, newDegree);
          if (newDegree === 0) {
            queue.push(dependent);
          }
        }
      }
    }

    return result;
  }

  /**
   * Get all direct dependencies of a symbol.
   *
   * @param path The symbol path
   * @returns Array of paths this symbol depends on
   */
  getDependencies(path: string): string[] {
    const node = this.nodes.get(path);
    return node ? Array.from(node.dependencies) : [];
  }

  /**
   * Get all direct dependents of a symbol (symbols that depend on this one).
   *
   * @param path The symbol path
   * @returns Array of paths that depend on this symbol
   */
  getDependents(path: string): string[] {
    const node = this.nodes.get(path);
    return node ? Array.from(node.dependents) : [];
  }

  /**
   * Get all transitive dependencies of a symbol.
   *
   * @param path The symbol path
   * @returns Set of all paths this symbol transitively depends on
   */
  getTransitiveDependencies(path: string): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();
    const stack = [path];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = this.nodes.get(current);
      if (node) {
        for (const dep of node.dependencies) {
          if (dep !== path) {
            // Don't include self
            result.add(dep);
            stack.push(dep);
          }
        }
      }
    }

    return result;
  }

  /**
   * Get all transitive dependents of a symbol.
   *
   * @param path The symbol path
   * @returns Set of all paths that transitively depend on this symbol
   */
  getTransitiveDependents(path: string): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();
    const stack = [path];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = this.nodes.get(current);
      if (node) {
        for (const dep of node.dependents) {
          if (dep !== path) {
            // Don't include self
            result.add(dep);
            stack.push(dep);
          }
        }
      }
    }

    return result;
  }

  /**
   * Check if a symbol is involved in any cycle.
   *
   * @param path The symbol path
   * @param cycles The detected cycles
   * @returns True if the symbol is part of a cycle
   */
  isInCycle(path: string, cycles: CircularDependency[]): boolean {
    for (const cycle of cycles) {
      if (cycle.cycle.includes(path)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the number of nodes in the graph.
   */
  getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Get the number of edges in the graph.
   */
  getEdgeCount(): number {
    return this.edges.length;
  }

  /**
   * Get all node paths in the graph.
   */
  getNodes(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Check if a node exists in the graph.
   */
  hasNode(path: string): boolean {
    return this.nodes.has(path);
  }
}
