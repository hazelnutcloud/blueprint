import type { RequirementNode } from "./ast";
import type { Ticket, TicketFile } from "./tickets";
import type { IndexedSymbol } from "./symbol-index";

// ============================================================================
// Types for Requirement-Ticket Correlation
// ============================================================================

/**
 * Represents the aggregated status of a requirement based on its tickets.
 * Per SPEC.md Section 4.10, a requirement is complete when all constraints
 * are satisfied across all associated tickets.
 */
export type RequirementStatus =
  | "no-ticket" // No tickets exist for this requirement
  | "pending" // All tickets are pending
  | "in-progress" // At least one ticket is in-progress
  | "complete" // All constraints satisfied, all tickets complete
  | "obsolete"; // All tickets are obsolete

/**
 * Information about a constraint and its satisfaction status.
 */
export interface ConstraintStatus {
  /** The constraint identifier */
  name: string;
  /** Whether this constraint has been satisfied by any ticket */
  satisfied: boolean;
  /** The ticket ID(s) that satisfy this constraint */
  satisfiedBy: string[];
}

/**
 * Aggregated information about a requirement and its tickets.
 */
export interface RequirementTicketInfo {
  /** The fully-qualified path of the requirement (e.g., "auth.login.basic-auth") */
  requirementPath: string;
  /** The requirement node from the AST */
  requirement: RequirementNode;
  /** All tickets associated with this requirement */
  tickets: Ticket[];
  /** Aggregated status across all tickets */
  status: RequirementStatus;
  /** Constraint satisfaction information */
  constraintStatuses: ConstraintStatus[];
  /** Number of constraints satisfied / total constraints */
  constraintsSatisfied: number;
  constraintsTotal: number;
  /** All implementation files from all tickets */
  implementationFiles: string[];
  /** All test files from all tickets */
  testFiles: string[];
}

/**
 * A mapping from requirement paths to their ticket information.
 */
export type RequirementTicketMap = Map<string, RequirementTicketInfo>;

/**
 * Information about a ticket that references a non-existent requirement.
 */
export interface OrphanedTicket {
  /** The ticket with an invalid ref */
  ticket: Ticket;
  /** The ref that doesn't match any requirement */
  ref: string;
  /** The source file of the ticket */
  ticketFileSource: string;
}

/**
 * Result of building the requirement-ticket map.
 */
export interface RequirementTicketMapResult {
  /** The requirement to ticket mapping */
  map: RequirementTicketMap;
  /** Tickets that reference non-existent requirements */
  orphanedTickets: OrphanedTicket[];
  /** Requirements that have no associated tickets */
  requirementsWithoutTickets: string[];
}

// ============================================================================
// Mapping Functions
// ============================================================================

/**
 * Groups tickets by their requirement ref.
 *
 * @param tickets Array of tickets to group
 * @returns Map from ref to array of tickets
 */
export function groupTicketsByRef(tickets: Ticket[]): Map<string, Ticket[]> {
  const grouped = new Map<string, Ticket[]>();

  for (const ticket of tickets) {
    const existing = grouped.get(ticket.ref);
    if (existing) {
      existing.push(ticket);
    } else {
      grouped.set(ticket.ref, [ticket]);
    }
  }

  return grouped;
}

/**
 * Computes the aggregated status for a requirement based on its tickets.
 *
 * Status logic:
 * - If no tickets exist: "no-ticket"
 * - If all tickets are obsolete: "obsolete"
 * - If any ticket is in-progress: "in-progress"
 * - If all tickets are complete: "complete"
 * - Otherwise: "pending"
 *
 * @param tickets The tickets associated with the requirement
 * @returns The aggregated status
 */
export function computeRequirementStatus(tickets: Ticket[]): RequirementStatus {
  if (tickets.length === 0) {
    return "no-ticket";
  }

  const statuses = tickets.map((t) => t.status);

  // If all obsolete
  if (statuses.every((s) => s === "obsolete")) {
    return "obsolete";
  }

  // Filter out obsolete tickets for remaining checks
  const activeStatuses = statuses.filter((s) => s !== "obsolete");

  if (activeStatuses.length === 0) {
    return "obsolete";
  }

  // If any in-progress
  if (activeStatuses.includes("in-progress")) {
    return "in-progress";
  }

  // If all complete
  if (activeStatuses.every((s) => s === "complete")) {
    return "complete";
  }

  // Otherwise pending (mix of pending and complete, or all pending)
  return "pending";
}

/**
 * Computes constraint satisfaction status for a requirement.
 * Aggregates constraints_satisfied from all tickets sharing the same ref.
 *
 * @param requirement The requirement node with its constraints
 * @param tickets The tickets associated with this requirement
 * @returns Array of constraint statuses
 */
export function computeConstraintStatuses(
  requirement: RequirementNode,
  tickets: Ticket[]
): ConstraintStatus[] {
  // Build a map of constraint name -> ticket IDs that satisfy it
  const satisfiedByMap = new Map<string, string[]>();

  for (const ticket of tickets) {
    for (const constraintName of ticket.constraints_satisfied) {
      const existing = satisfiedByMap.get(constraintName);
      if (existing) {
        existing.push(ticket.id);
      } else {
        satisfiedByMap.set(constraintName, [ticket.id]);
      }
    }
  }

  // Build status for each constraint in the requirement
  return requirement.constraints.map((constraint) => ({
    name: constraint.name,
    satisfied: satisfiedByMap.has(constraint.name),
    satisfiedBy: satisfiedByMap.get(constraint.name) ?? [],
  }));
}

/**
 * Collects all implementation files from tickets.
 *
 * @param tickets The tickets to collect files from
 * @returns Deduplicated array of file paths
 */
export function collectImplementationFiles(tickets: Ticket[]): string[] {
  const files = new Set<string>();

  for (const ticket of tickets) {
    if (ticket.implementation?.files) {
      for (const file of ticket.implementation.files) {
        files.add(file);
      }
    }
  }

  return Array.from(files);
}

/**
 * Collects all test files from tickets.
 *
 * @param tickets The tickets to collect files from
 * @returns Deduplicated array of file paths
 */
export function collectTestFiles(tickets: Ticket[]): string[] {
  const files = new Set<string>();

  for (const ticket of tickets) {
    if (ticket.implementation?.tests) {
      for (const file of ticket.implementation.tests) {
        files.add(file);
      }
    }
  }

  return Array.from(files);
}

/**
 * Builds the complete requirement-ticket mapping for a set of requirements and tickets.
 *
 * @param requirements Map of requirement paths to their nodes
 * @param ticketFile The parsed ticket file
 * @returns The mapping result including orphaned tickets and requirements without tickets
 */
export function buildRequirementTicketMap(
  requirements: Map<string, RequirementNode>,
  ticketFile: TicketFile | null
): RequirementTicketMapResult {
  const map: RequirementTicketMap = new Map();
  const orphanedTickets: OrphanedTicket[] = [];
  const requirementsWithoutTickets: string[] = [];

  // Group tickets by ref
  const ticketsByRef = ticketFile
    ? groupTicketsByRef(ticketFile.tickets)
    : new Map<string, Ticket[]>();

  // Track which refs have been matched
  const matchedRefs = new Set<string>();

  // Build info for each requirement
  for (const [path, requirement] of requirements) {
    const tickets = ticketsByRef.get(path) ?? [];

    if (tickets.length > 0) {
      matchedRefs.add(path);
    } else {
      requirementsWithoutTickets.push(path);
    }

    const constraintStatuses = computeConstraintStatuses(requirement, tickets);
    const constraintsSatisfied = constraintStatuses.filter((c) => c.satisfied).length;

    const info: RequirementTicketInfo = {
      requirementPath: path,
      requirement,
      tickets,
      status: computeRequirementStatus(tickets),
      constraintStatuses,
      constraintsSatisfied,
      constraintsTotal: requirement.constraints.length,
      implementationFiles: collectImplementationFiles(tickets),
      testFiles: collectTestFiles(tickets),
    };

    map.set(path, info);
  }

  // Find orphaned tickets (refs that don't match any requirement)
  if (ticketFile) {
    for (const ticket of ticketFile.tickets) {
      if (!requirements.has(ticket.ref)) {
        orphanedTickets.push({
          ticket,
          ref: ticket.ref,
          ticketFileSource: ticketFile.source,
        });
      }
    }
  }

  return {
    map,
    orphanedTickets,
    requirementsWithoutTickets,
  };
}

/**
 * Builds requirement-ticket mapping using indexed symbols from CrossFileSymbolIndex.
 * This is useful when you have symbols from the index rather than raw requirement maps.
 *
 * @param requirementSymbols Array of indexed requirement symbols
 * @param ticketFile The parsed ticket file (or null, or just a tickets array)
 * @returns The mapping result
 */
export function buildRequirementTicketMapFromSymbols(
  requirementSymbols: IndexedSymbol[],
  ticketFile: TicketFile | Ticket[] | null
): RequirementTicketMapResult {
  // Convert indexed symbols to a requirement map
  const requirements = new Map<string, RequirementNode>();

  for (const symbol of requirementSymbols) {
    if (symbol.kind === "requirement") {
      requirements.set(symbol.path, symbol.node as RequirementNode);
    }
  }

  // Handle the case where ticketFile is just an array of tickets
  // This avoids creating a mock TicketFile with invalid empty source
  if (Array.isArray(ticketFile)) {
    return buildRequirementTicketMapFromTickets(requirements, ticketFile);
  }

  return buildRequirementTicketMap(requirements, ticketFile);
}

/**
 * Builds requirement-ticket mapping from a raw tickets array.
 * Use this when you have collected tickets from multiple sources
 * and don't have a specific source file to attribute them to.
 *
 * Unlike buildRequirementTicketMap, this function sets orphaned ticket
 * sources to "(aggregated)" to indicate they come from multiple files.
 *
 * @param requirements Map of requirement paths to their nodes
 * @param tickets Array of tickets to map
 * @returns The mapping result
 */
export function buildRequirementTicketMapFromTickets(
  requirements: Map<string, RequirementNode>,
  tickets: Ticket[]
): RequirementTicketMapResult {
  const map: RequirementTicketMap = new Map();
  const orphanedTickets: OrphanedTicket[] = [];
  const requirementsWithoutTickets: string[] = [];

  // Group tickets by ref
  const ticketsByRef = groupTicketsByRef(tickets);

  // Build info for each requirement
  for (const [path, requirement] of requirements) {
    const reqTickets = ticketsByRef.get(path) ?? [];

    if (reqTickets.length === 0) {
      requirementsWithoutTickets.push(path);
    }

    const constraintStatuses = computeConstraintStatuses(requirement, reqTickets);
    const constraintsSatisfied = constraintStatuses.filter((c) => c.satisfied).length;

    const info: RequirementTicketInfo = {
      requirementPath: path,
      requirement,
      tickets: reqTickets,
      status: computeRequirementStatus(reqTickets),
      constraintStatuses,
      constraintsSatisfied,
      constraintsTotal: requirement.constraints.length,
      implementationFiles: collectImplementationFiles(reqTickets),
      testFiles: collectTestFiles(reqTickets),
    };

    map.set(path, info);
  }

  // Find orphaned tickets (refs that don't match any requirement)
  for (const ticket of tickets) {
    if (!requirements.has(ticket.ref)) {
      orphanedTickets.push({
        ticket,
        ref: ticket.ref,
        // Use a placeholder source since tickets may come from multiple files
        ticketFileSource: "(aggregated)",
      });
    }
  }

  return {
    map,
    orphanedTickets,
    requirementsWithoutTickets,
  };
}

/**
 * Gets a summary of requirement completion for a set of requirements.
 * Useful for computing feature or module-level progress.
 *
 * @param map The requirement-ticket map
 * @returns Summary statistics
 */
export function getCompletionSummary(map: RequirementTicketMap): {
  total: number;
  complete: number;
  inProgress: number;
  pending: number;
  noTicket: number;
  obsolete: number;
  percentComplete: number;
} {
  let complete = 0;
  let inProgress = 0;
  let pending = 0;
  let noTicket = 0;
  let obsolete = 0;

  for (const info of map.values()) {
    switch (info.status) {
      case "complete":
        complete++;
        break;
      case "in-progress":
        inProgress++;
        break;
      case "pending":
        pending++;
        break;
      case "no-ticket":
        noTicket++;
        break;
      case "obsolete":
        obsolete++;
        break;
    }
  }

  const total = map.size;
  const percentComplete = total > 0 ? Math.round((complete / total) * 100) : 0;

  return {
    total,
    complete,
    inProgress,
    pending,
    noTicket,
    obsolete,
    percentComplete,
  };
}

/**
 * Filters the requirement-ticket map to only include requirements under a given path prefix.
 * Useful for getting requirements for a specific module or feature.
 *
 * @param map The full requirement-ticket map
 * @param pathPrefix The path prefix to filter by (e.g., "auth" or "auth.login")
 * @returns A new map containing only matching requirements
 */
export function filterByPathPrefix(
  map: RequirementTicketMap,
  pathPrefix: string
): RequirementTicketMap {
  const filtered: RequirementTicketMap = new Map();
  const prefix = pathPrefix + ".";

  for (const [path, info] of map) {
    if (path === pathPrefix || path.startsWith(prefix)) {
      filtered.set(path, info);
    }
  }

  return filtered;
}
