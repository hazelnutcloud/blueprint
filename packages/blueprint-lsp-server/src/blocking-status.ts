import { DependencyGraph, type CircularDependency } from "./dependency-graph";
import type { RequirementTicketMap, RequirementStatus } from "./requirement-ticket-map";

// ============================================================================
// Types for Blocking Status Computation
// ============================================================================

/**
 * Represents the blocking status of a requirement.
 * Per SPEC.md Section 5.8, requirements blocked by pending dependencies
 * should be reported as info diagnostics.
 */
export type BlockingStatus =
  | "not-blocked"      // All dependencies are complete
  | "blocked"          // One or more dependencies are not complete
  | "in-cycle";        // Part of a circular dependency (mutual blocking)

/**
 * Information about what is blocking a requirement.
 */
export interface BlockingInfo {
  /** The blocking status */
  status: BlockingStatus;
  /** Direct dependencies that are not complete (immediate blockers) */
  directBlockers: BlockerInfo[];
  /** Transitive dependencies that are not complete (indirect blockers) */
  transitiveBlockers: BlockerInfo[];
  /** If in a cycle, information about the cycle */
  cycleInfo?: CycleBlockingInfo;
}

/**
 * Information about a single blocking requirement.
 */
export interface BlockerInfo {
  /** The path of the blocking requirement */
  path: string;
  /** The current status of the blocking requirement */
  status: RequirementStatus;
}

/**
 * Information about a cycle that blocks a requirement.
 */
export interface CycleBlockingInfo {
  /** The cycle this requirement is part of */
  cycle: CircularDependency;
  /** Other requirements in the same cycle */
  cyclePeers: string[];
}

/**
 * Result of computing blocking status for all requirements.
 */
export interface BlockingStatusResult {
  /** Mapping from requirement path to its blocking info */
  blockingInfo: Map<string, BlockingInfo>;
  /** Requirements that are blocked */
  blockedRequirements: string[];
  /** Requirements that are in cycles */
  requirementsInCycles: string[];
  /** Requirements that are not blocked */
  unblockedRequirements: string[];
}

// ============================================================================
// Blocking Status Computation Functions
// ============================================================================

/**
 * Determines if a requirement status represents a completed state.
 * A requirement is considered "complete" only when its status is "complete".
 * 
 * Per SPEC.md, tickets track implementation progress. A requirement blocks
 * its dependents until all its constraints are satisfied and tickets are complete.
 */
export function isCompleteStatus(status: RequirementStatus): boolean {
  return status === "complete";
}

/**
 * Determines if a requirement status represents a non-blocking state.
 * Obsolete requirements don't block (they've been removed from the spec).
 */
export function isNonBlockingStatus(status: RequirementStatus): boolean {
  return status === "complete" || status === "obsolete";
}

/**
 * Computes the blocking info for a single requirement.
 * 
 * A requirement is blocked if:
 * 1. Any of its direct dependencies is not complete, OR
 * 2. Any of its transitive dependencies is not complete, OR
 * 3. It is part of a circular dependency
 * 
 * @param requirementPath The path of the requirement to check
 * @param graph The dependency graph
 * @param ticketMap The requirement-ticket mapping with status info
 * @param cycles Detected circular dependencies
 * @returns BlockingInfo for the requirement
 */
export function computeBlockingInfo(
  requirementPath: string,
  graph: DependencyGraph,
  ticketMap: RequirementTicketMap,
  cycles: CircularDependency[]
): BlockingInfo {
  // Check if this requirement is in a cycle
  const cycleInfo = findCycleInfo(requirementPath, cycles);
  if (cycleInfo) {
    return {
      status: "in-cycle",
      directBlockers: [],
      transitiveBlockers: [],
      cycleInfo,
    };
  }

  // Get direct and transitive dependencies
  const directDeps = graph.getDependencies(requirementPath);
  const transitiveDeps = graph.getTransitiveDependencies(requirementPath);

  // Find direct blockers (dependencies that are not complete)
  const directBlockers: BlockerInfo[] = [];
  for (const depPath of directDeps) {
    const info = ticketMap.get(depPath);
    const status = info?.status ?? "no-ticket";
    if (!isNonBlockingStatus(status)) {
      directBlockers.push({ path: depPath, status });
    }
  }

  // Find transitive blockers (exclude direct blockers to avoid duplication)
  const transitiveBlockers: BlockerInfo[] = [];
  const directSet = new Set(directDeps);
  for (const depPath of transitiveDeps) {
    if (directSet.has(depPath)) continue; // Skip direct deps
    const info = ticketMap.get(depPath);
    const status = info?.status ?? "no-ticket";
    if (!isNonBlockingStatus(status)) {
      transitiveBlockers.push({ path: depPath, status });
    }
  }

  // Determine overall status
  const isBlocked = directBlockers.length > 0 || transitiveBlockers.length > 0;

  return {
    status: isBlocked ? "blocked" : "not-blocked",
    directBlockers,
    transitiveBlockers,
  };
}

/**
 * Finds cycle information for a requirement if it's part of a cycle.
 */
function findCycleInfo(
  requirementPath: string,
  cycles: CircularDependency[]
): CycleBlockingInfo | undefined {
  for (const cycle of cycles) {
    // Cycle array includes the repeated first element at the end
    const cycleNodes = cycle.cycle.slice(0, -1);
    if (cycleNodes.includes(requirementPath)) {
      return {
        cycle,
        cyclePeers: cycleNodes.filter((n) => n !== requirementPath),
      };
    }
  }
  return undefined;
}

/**
 * Computes blocking status for all requirements in the ticket map.
 * 
 * This is the main entry point for blocking status computation. It analyzes
 * all requirements and categorizes them as blocked, in-cycle, or unblocked.
 * 
 * @param graph The dependency graph (built from symbol index)
 * @param ticketMap The requirement-ticket mapping
 * @param cycles Detected circular dependencies from the graph
 * @returns BlockingStatusResult with categorized requirements
 */
export function computeAllBlockingStatus(
  graph: DependencyGraph,
  ticketMap: RequirementTicketMap,
  cycles: CircularDependency[]
): BlockingStatusResult {
  const blockingInfo = new Map<string, BlockingInfo>();
  const blockedRequirements: string[] = [];
  const requirementsInCycles: string[] = [];
  const unblockedRequirements: string[] = [];

  for (const [path] of ticketMap) {
    const info = computeBlockingInfo(path, graph, ticketMap, cycles);
    blockingInfo.set(path, info);

    switch (info.status) {
      case "blocked":
        blockedRequirements.push(path);
        break;
      case "in-cycle":
        requirementsInCycles.push(path);
        break;
      case "not-blocked":
        unblockedRequirements.push(path);
        break;
    }
  }

  return {
    blockingInfo,
    blockedRequirements,
    requirementsInCycles,
    unblockedRequirements,
  };
}

/**
 * Propagates blocking status through the hierarchy.
 * 
 * This computes blocking status for modules and features based on their
 * contained requirements. A feature is considered blocked if any of its
 * requirements is blocked. A module is blocked if any of its features is blocked.
 * 
 * @param blockingResult The requirement-level blocking result
 * @param ticketMap The requirement-ticket mapping (for path prefix matching)
 * @returns Mapping from module/feature paths to their aggregated blocking status
 */
export function propagateBlockingToHierarchy(
  blockingResult: BlockingStatusResult,
  ticketMap: RequirementTicketMap
): Map<string, BlockingStatus> {
  const hierarchyStatus = new Map<string, BlockingStatus>();

  // Collect all unique module and feature prefixes
  const prefixes = new Set<string>();
  for (const [path] of ticketMap) {
    const parts = path.split(".");
    // Add module prefix
    if (parts.length >= 1) {
      prefixes.add(parts[0]!);
    }
    // Add feature prefix (module.feature)
    if (parts.length >= 2) {
      prefixes.add(parts.slice(0, 2).join("."));
    }
  }

  // Compute status for each prefix
  for (const prefix of prefixes) {
    let hasBlocked = false;
    let hasInCycle = false;

    for (const [path, info] of blockingResult.blockingInfo) {
      // Check if this requirement is under the prefix
      if (path === prefix || path.startsWith(prefix + ".")) {
        if (info.status === "blocked") {
          hasBlocked = true;
        } else if (info.status === "in-cycle") {
          hasInCycle = true;
        }
      }
    }

    // Determine hierarchy status (in-cycle takes precedence over blocked)
    if (hasInCycle) {
      hierarchyStatus.set(prefix, "in-cycle");
    } else if (hasBlocked) {
      hierarchyStatus.set(prefix, "blocked");
    } else {
      hierarchyStatus.set(prefix, "not-blocked");
    }
  }

  return hierarchyStatus;
}

/**
 * Gets all requirements that would be unblocked if a given requirement is completed.
 * Useful for showing the impact of completing a blocking requirement.
 * 
 * @param completedPath The path of the requirement that would be completed
 * @param graph The dependency graph
 * @param ticketMap The requirement-ticket mapping
 * @param cycles Detected circular dependencies
 * @returns Array of requirement paths that would become unblocked
 */
export function getUnblockedIfCompleted(
  completedPath: string,
  graph: DependencyGraph,
  ticketMap: RequirementTicketMap,
  cycles: CircularDependency[]
): string[] {
  // Get all dependents of this requirement
  const dependents = graph.getTransitiveDependents(completedPath);
  const wouldUnblock: string[] = [];

  for (const depPath of dependents) {
    // Skip if the dependent is in a cycle
    if (cycles.some((c) => c.cycle.slice(0, -1).includes(depPath))) {
      continue;
    }

    // Check if this requirement is the ONLY blocker
    const info = computeBlockingInfo(depPath, graph, ticketMap, cycles);
    if (info.status !== "blocked") continue;

    // Check if all blockers would be resolved
    const allBlockers = [...info.directBlockers, ...info.transitiveBlockers];
    const remainingBlockers = allBlockers.filter((b) => b.path !== completedPath);

    if (remainingBlockers.length === 0) {
      wouldUnblock.push(depPath);
    }
  }

  return wouldUnblock;
}

// ============================================================================
// Caching Support
// ============================================================================

/**
 * Cache entry for blocking status computation.
 * Used to avoid recomputing when nothing has changed.
 */
export interface BlockingStatusCache {
  /** Version counter for invalidation */
  version: number;
  /** Cached result */
  result: BlockingStatusResult;
  /** Cached hierarchy status */
  hierarchyStatus: Map<string, BlockingStatus>;
  /** File URIs that contributed to this cache */
  sourceFiles: Set<string>;
}

/**
 * Creates a new empty cache.
 */
export function createBlockingStatusCache(): BlockingStatusCache {
  return {
    version: 0,
    result: {
      blockingInfo: new Map(),
      blockedRequirements: [],
      requirementsInCycles: [],
      unblockedRequirements: [],
    },
    hierarchyStatus: new Map(),
    sourceFiles: new Set(),
  };
}

/**
 * Invalidates the cache, incrementing the version.
 * Call this when any .bp file or .tickets.json file changes.
 */
export function invalidateBlockingStatusCache(cache: BlockingStatusCache): void {
  cache.version++;
}

/**
 * Updates the cache with new computed results.
 */
export function updateBlockingStatusCache(
  cache: BlockingStatusCache,
  result: BlockingStatusResult,
  hierarchyStatus: Map<string, BlockingStatus>,
  sourceFiles: string[]
): void {
  cache.result = result;
  cache.hierarchyStatus = hierarchyStatus;
  cache.sourceFiles = new Set(sourceFiles);
}

/**
 * Checks if a file change should invalidate the cache.
 */
export function shouldInvalidateCache(
  cache: BlockingStatusCache,
  changedFileUri: string
): boolean {
  // Invalidate if:
  // 1. Any tracked .bp file changed
  // 2. Any .tickets.json file changed
  if (cache.sourceFiles.has(changedFileUri)) {
    return true;
  }
  if (changedFileUri.endsWith(".tickets.json")) {
    return true;
  }
  if (changedFileUri.endsWith(".bp")) {
    return true;
  }
  return false;
}
