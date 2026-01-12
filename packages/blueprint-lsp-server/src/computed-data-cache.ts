import type { DependencyGraphResult } from "./dependency-graph";
import type { RequirementTicketMapResult } from "./requirement-ticket-map";
import type { CrossFileSymbolIndex } from "./symbol-index";
import type { TicketDocumentManager } from "./ticket-documents";
import type { TicketFile } from "./tickets";
import { DependencyGraph } from "./dependency-graph";
import { buildRequirementTicketMapFromSymbols } from "./requirement-ticket-map";

/**
 * Cache for computed data that is expensive to rebuild.
 *
 * This cache stores the dependency graph and requirement-ticket map,
 * which are expensive to compute on each hover/definition/references request.
 * The cache is invalidated when the underlying data changes (symbol index
 * or ticket documents).
 *
 * Per TODOS.md: "Inefficient re-computation of dependency graph and ticket map
 * on each hover - In index.ts, each hover request rebuilds the entire
 * RequirementTicketMap and DependencyGraph from scratch."
 */
export class ComputedDataCache {
  /** Cached dependency graph result */
  private dependencyGraphCache: DependencyGraphResult | null = null;

  /** Version counter for symbol index - increments on each change */
  private symbolIndexVersion = 0;

  /** Cached requirement-ticket map result */
  private ticketMapCache: RequirementTicketMapResult | null = null;

  /** Combined version of symbol index + tickets - for ticket map invalidation */
  private ticketMapVersion = 0;

  /** Version counter for tickets - increments on each ticket change */
  private ticketsVersion = 0;

  /** Reference to the symbol index */
  private symbolIndex: CrossFileSymbolIndex;

  /** Reference to the ticket document manager */
  private ticketDocumentManager: TicketDocumentManager;

  constructor(symbolIndex: CrossFileSymbolIndex, ticketDocumentManager: TicketDocumentManager) {
    this.symbolIndex = symbolIndex;
    this.ticketDocumentManager = ticketDocumentManager;
  }

  /**
   * Invalidate the dependency graph cache.
   * Call this when the symbol index changes (file added/removed/changed).
   */
  invalidateDependencyGraph(): void {
    this.dependencyGraphCache = null;
    this.symbolIndexVersion++;
    // Ticket map also depends on symbol index
    this.invalidateTicketMap();
  }

  /**
   * Invalidate the ticket map cache.
   * Call this when tickets change (ticket file added/removed/changed).
   */
  invalidateTicketMap(): void {
    this.ticketMapCache = null;
    this.ticketsVersion++;
    this.ticketMapVersion = this.symbolIndexVersion + this.ticketsVersion;
  }

  /**
   * Invalidate all caches.
   * Call this when both symbol index and tickets may have changed.
   */
  invalidateAll(): void {
    this.dependencyGraphCache = null;
    this.ticketMapCache = null;
    this.symbolIndexVersion++;
    this.ticketsVersion++;
    this.ticketMapVersion = this.symbolIndexVersion + this.ticketsVersion;
  }

  /**
   * Get the dependency graph, computing it if not cached.
   *
   * @returns The cached or freshly computed dependency graph result
   */
  getDependencyGraph(): DependencyGraphResult {
    if (this.dependencyGraphCache === null) {
      this.dependencyGraphCache = DependencyGraph.build(this.symbolIndex);
    }
    return this.dependencyGraphCache;
  }

  /**
   * Get the requirement-ticket map, computing it if not cached.
   *
   * @returns The cached or freshly computed requirement-ticket map result
   */
  getTicketMap(): RequirementTicketMapResult {
    if (this.ticketMapCache === null) {
      const requirementSymbols = this.symbolIndex.getSymbolsByKind("requirement");
      const allTickets = this.ticketDocumentManager.getAllTickets().map((t) => t.ticket);

      // Create a combined ticket file for the map builder
      const ticketFile: TicketFile | null =
        allTickets.length > 0 ? { version: "1.0", source: "", tickets: allTickets } : null;

      this.ticketMapCache = buildRequirementTicketMapFromSymbols(requirementSymbols, ticketFile);
    }
    return this.ticketMapCache;
  }

  /**
   * Get the current symbol index version.
   * Useful for debugging cache behavior.
   */
  getSymbolIndexVersion(): number {
    return this.symbolIndexVersion;
  }

  /**
   * Get the current tickets version.
   * Useful for debugging cache behavior.
   */
  getTicketsVersion(): number {
    return this.ticketsVersion;
  }

  /**
   * Check if the dependency graph cache is currently valid.
   */
  isDependencyGraphCached(): boolean {
    return this.dependencyGraphCache !== null;
  }

  /**
   * Check if the ticket map cache is currently valid.
   */
  isTicketMapCached(): boolean {
    return this.ticketMapCache !== null;
  }

  /**
   * Clear all caches and reset version counters.
   * Call this on server shutdown.
   */
  cleanup(): void {
    this.dependencyGraphCache = null;
    this.ticketMapCache = null;
    this.symbolIndexVersion = 0;
    this.ticketsVersion = 0;
    this.ticketMapVersion = 0;
  }
}
