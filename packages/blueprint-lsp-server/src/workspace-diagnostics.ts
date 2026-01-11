import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver/node";
import type { CrossFileSymbolIndex } from "./symbol-index";
import { DependencyGraph, type CircularDependency } from "./dependency-graph";
import type { Ticket, TicketFile } from "./tickets";
import type { RequirementNode } from "./ast";
import { computeAllBlockingStatus, type BlockerInfo } from "./blocking-status";
import { buildRequirementTicketMapFromSymbols } from "./requirement-ticket-map";

/**
 * Represents diagnostics for a specific file.
 */
export interface FileDiagnostics {
  /** The file URI */
  uri: string;
  /** Diagnostics for this file */
  diagnostics: Diagnostic[];
}

/**
 * Result of computing workspace-wide diagnostics.
 */
export interface WorkspaceDiagnosticsResult {
  /** Diagnostics grouped by file URI */
  byFile: Map<string, Diagnostic[]>;
  /** All file URIs that have diagnostics */
  filesWithDiagnostics: string[];
}

/**
 * Compute circular dependency diagnostics from the symbol index.
 *
 * Per SPEC.md Section 5.8:
 * - Error | Circular dependency detected
 *
 * @param symbolIndex The cross-file symbol index
 * @returns Diagnostics grouped by file URI
 */
export function computeCircularDependencyDiagnostics(
  symbolIndex: CrossFileSymbolIndex
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  // Build the dependency graph and detect cycles
  const graphResult = DependencyGraph.build(symbolIndex);

  if (graphResult.isAcyclic) {
    return { byFile, filesWithDiagnostics: [] };
  }

  // For each cycle, create diagnostics at the @depends-on locations
  for (const cycle of graphResult.cycles) {
    addCycleDiagnostics(cycle, byFile);
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Add diagnostics for a single cycle to the diagnostics map.
 */
function addCycleDiagnostics(
  cycle: CircularDependency,
  byFile: Map<string, Diagnostic[]>
): void {
  // Format the cycle path for the error message
  // cycle.cycle is like ["a", "b", "c", "a"] where first and last are the same
  const cyclePath = cycle.cycle.join(" -> ");

  // Add a diagnostic for each edge in the cycle
  for (const edge of cycle.edges) {
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: {
        start: {
          line: edge.reference.location.startLine,
          character: edge.reference.location.startColumn,
        },
        end: {
          line: edge.reference.location.endLine,
          character: edge.reference.location.endColumn,
        },
      },
      message: `Circular dependency detected: ${cyclePath}`,
      source: "blueprint",
      code: "circular-dependency",
    };

    // Add to the file's diagnostics
    const fileDiagnostics = byFile.get(edge.fileUri);
    if (fileDiagnostics) {
      // Check if we already have this exact diagnostic (same location)
      const isDuplicate = fileDiagnostics.some(
        (d) =>
          d.range.start.line === diagnostic.range.start.line &&
          d.range.start.character === diagnostic.range.start.character &&
          d.code === "circular-dependency"
      );
      if (!isDuplicate) {
        fileDiagnostics.push(diagnostic);
      }
    } else {
      byFile.set(edge.fileUri, [diagnostic]);
    }
  }
}

/**
 * Compute unresolved reference diagnostics from the symbol index.
 *
 * Per SPEC.md Section 5.8:
 * - Error | Reference to non-existent requirement
 *
 * @param symbolIndex The cross-file symbol index
 * @returns Diagnostics grouped by file URI
 */
export function computeUnresolvedReferenceDiagnostics(
  symbolIndex: CrossFileSymbolIndex
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  const unresolved = symbolIndex.getUnresolvedReferences();

  for (const unresolvedRef of unresolved) {
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: {
        start: {
          line: unresolvedRef.reference.location.startLine,
          character: unresolvedRef.reference.location.startColumn,
        },
        end: {
          line: unresolvedRef.reference.location.endLine,
          character: unresolvedRef.reference.location.endColumn,
        },
      },
      message: `Reference to non-existent element: '${unresolvedRef.reference.path}'`,
      source: "blueprint",
      code: "unresolved-reference",
    };

    const fileDiagnostics = byFile.get(unresolvedRef.fileUri);
    if (fileDiagnostics) {
      fileDiagnostics.push(diagnostic);
    } else {
      byFile.set(unresolvedRef.fileUri, [diagnostic]);
    }
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Merge multiple diagnostic results into one.
 *
 * @param results Array of diagnostic results to merge
 * @returns Merged diagnostics
 */
export function mergeDiagnosticResults(
  ...results: WorkspaceDiagnosticsResult[]
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  for (const result of results) {
    for (const [fileUri, diagnostics] of result.byFile) {
      const existing = byFile.get(fileUri);
      if (existing) {
        existing.push(...diagnostics);
      } else {
        byFile.set(fileUri, [...diagnostics]);
      }
    }
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Compute diagnostics for requirements that have no associated tickets.
 *
 * Per SPEC.md Section 5.8:
 * - Warning | Requirement has no ticket
 *
 * @param symbolIndex The cross-file symbol index
 * @param tickets Array of all tickets from all ticket files
 * @returns Diagnostics grouped by file URI
 */
export function computeNoTicketDiagnostics(
  symbolIndex: CrossFileSymbolIndex,
  tickets: Ticket[]
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  // Build a set of requirement refs that have tickets
  const refsWithTickets = new Set<string>();
  for (const ticket of tickets) {
    refsWithTickets.add(ticket.ref);
  }

  // Get all requirements from the symbol index
  const requirements = symbolIndex.getSymbolsByKind("requirement");

  for (const req of requirements) {
    // Check if this requirement has any tickets
    if (!refsWithTickets.has(req.path)) {
      const node = req.node;
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: {
            line: node.location.startLine,
            character: node.location.startColumn,
          },
          end: {
            line: node.location.startLine,
            // Highlight just the @requirement line, not the whole block
            character: node.location.startColumn + "@requirement".length + 1 + (node as { name: string }).name.length,
          },
        },
        message: `Requirement '${req.path}' has no associated ticket`,
        source: "blueprint",
        code: "no-ticket",
      };

      const fileDiagnostics = byFile.get(req.fileUri);
      if (fileDiagnostics) {
        fileDiagnostics.push(diagnostic);
      } else {
        byFile.set(req.fileUri, [diagnostic]);
      }
    }
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Information about a ticket file and its tickets for orphaned ticket detection.
 */
export interface TicketFileInfo {
  /** The URI of the .tickets.json file */
  uri: string;
  /** The parsed ticket file data */
  data: TicketFile;
}

/**
 * Compute diagnostics for tickets that reference removed/non-existent requirements.
 *
 * Per SPEC.md Section 5.8:
 * - Warning | Ticket references removed requirement
 *
 * These diagnostics are reported on the .tickets.json files, not the .bp files.
 *
 * @param symbolIndex The cross-file symbol index
 * @param ticketFiles Array of ticket files with their URIs
 * @returns Diagnostics grouped by file URI (ticket file URIs)
 */
export function computeOrphanedTicketDiagnostics(
  symbolIndex: CrossFileSymbolIndex,
  ticketFiles: TicketFileInfo[]
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  // Build a set of all valid requirement paths from the symbol index
  const validRequirementPaths = new Set<string>();
  const requirements = symbolIndex.getSymbolsByKind("requirement");
  for (const req of requirements) {
    validRequirementPaths.add(req.path);
  }

  // Check each ticket file for orphaned tickets
  for (const ticketFileInfo of ticketFiles) {
    const orphanedTicketDiagnostics: Diagnostic[] = [];

    for (let i = 0; i < ticketFileInfo.data.tickets.length; i++) {
      const ticket = ticketFileInfo.data.tickets[i]!;

      // Check if the ticket's ref points to an existing requirement
      if (!validRequirementPaths.has(ticket.ref)) {
        // This ticket references a removed/non-existent requirement
        const diagnostic: Diagnostic = {
          severity: DiagnosticSeverity.Warning,
          range: {
            // We point to line 0 since we don't have precise location info
            // The ticket-documents.ts has logic to find JSON paths, but for simplicity
            // we use a placeholder range. A future enhancement could locate the exact position.
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          message: `Ticket '${ticket.id}' references removed requirement '${ticket.ref}'`,
          source: "blueprint",
          code: "orphaned-ticket",
        };

        orphanedTicketDiagnostics.push(diagnostic);
      }
    }

    if (orphanedTicketDiagnostics.length > 0) {
      byFile.set(ticketFileInfo.uri, orphanedTicketDiagnostics);
    }
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Compute diagnostics for tickets that claim to satisfy constraints that don't exist
 * in the corresponding requirement definition.
 *
 * Per SPEC.md Section 5.8:
 * - Warning | Constraint identifier mismatch between `.bp` and ticket
 *
 * A mismatch occurs when a ticket's `constraints_satisfied` array contains
 * a constraint identifier that is not defined in the requirement's `@constraint` list.
 *
 * These diagnostics are reported on the .tickets.json files.
 *
 * @param symbolIndex The cross-file symbol index
 * @param ticketFiles Array of ticket files with their URIs
 * @returns Diagnostics grouped by file URI (ticket file URIs)
 */
export function computeConstraintMismatchDiagnostics(
  symbolIndex: CrossFileSymbolIndex,
  ticketFiles: TicketFileInfo[]
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  // Build a map from requirement path to set of valid constraint names
  const requirementConstraints = new Map<string, Set<string>>();
  const requirements = symbolIndex.getSymbolsByKind("requirement");

  for (const reqSymbol of requirements) {
    const reqNode = reqSymbol.node as RequirementNode;
    const constraintNames = new Set<string>();
    for (const constraint of reqNode.constraints) {
      constraintNames.add(constraint.name);
    }
    requirementConstraints.set(reqSymbol.path, constraintNames);
  }

  // Check each ticket file for constraint mismatches
  for (const ticketFileInfo of ticketFiles) {
    const mismatchDiagnostics: Diagnostic[] = [];

    for (const ticket of ticketFileInfo.data.tickets) {
      // Get the valid constraints for this ticket's requirement
      const validConstraints = requirementConstraints.get(ticket.ref);

      // If the requirement doesn't exist, skip (handled by orphaned-ticket diagnostic)
      if (!validConstraints) {
        continue;
      }

      // Check each constraint the ticket claims to satisfy
      for (const constraintName of ticket.constraints_satisfied) {
        if (!validConstraints.has(constraintName)) {
          const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Warning,
            range: {
              // We point to line 0 since we don't have precise location info in JSON
              // A future enhancement could locate the exact position within the JSON
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            message: `Ticket '${ticket.id}' claims to satisfy undefined constraint '${constraintName}' for requirement '${ticket.ref}'`,
            source: "blueprint",
            code: "constraint-mismatch",
          };

          mismatchDiagnostics.push(diagnostic);
        }
      }
    }

    if (mismatchDiagnostics.length > 0) {
      byFile.set(ticketFileInfo.uri, mismatchDiagnostics);
    }
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Format a blocker list into a human-readable string.
 */
function formatBlockers(blockers: BlockerInfo[]): string {
  return blockers
    .map((b) => `${b.path} (${b.status === "no-ticket" ? "no ticket" : b.status})`)
    .join(", ");
}

/**
 * Compute diagnostics for requirements that are blocked by pending dependencies.
 *
 * Per SPEC.md Section 5.8:
 * - Info | Requirement is blocked by pending dependencies
 *
 * @param symbolIndex The cross-file symbol index
 * @param tickets Array of all tickets from all ticket files
 * @returns Diagnostics grouped by file URI
 */
export function computeBlockingDiagnostics(
  symbolIndex: CrossFileSymbolIndex,
  tickets: Ticket[]
): WorkspaceDiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>();

  // Build the dependency graph
  const graphResult = DependencyGraph.build(symbolIndex);

  // Get all requirements from the symbol index
  const requirements = symbolIndex.getSymbolsByKind("requirement");

  // Build the requirement-ticket map
  const ticketMapResult = buildRequirementTicketMapFromSymbols(requirements, {
    version: "1.0",
    source: "",
    tickets,
  });

  // Compute blocking status for all requirements
  const blockingResult = computeAllBlockingStatus(
    graphResult.graph,
    ticketMapResult.map,
    graphResult.cycles
  );

  // Generate diagnostics for blocked requirements (not in-cycle, those are errors)
  for (const blockedPath of blockingResult.blockedRequirements) {
    const blockingInfo = blockingResult.blockingInfo.get(blockedPath);
    if (!blockingInfo || blockingInfo.status !== "blocked") {
      continue;
    }

    // Find the symbol to get location and file URI
    const symbols = symbolIndex.getSymbol(blockedPath);
    if (!symbols || symbols.length === 0) {
      continue;
    }

    const symbol = symbols[0]!;
    const node = symbol.node as RequirementNode;

    // Build the message with blocker information
    const allBlockers = [
      ...blockingInfo.directBlockers,
      ...blockingInfo.transitiveBlockers,
    ];
    
    let message: string;
    if (blockingInfo.directBlockers.length > 0 && blockingInfo.transitiveBlockers.length > 0) {
      message = `Requirement blocked by: ${formatBlockers(blockingInfo.directBlockers)}. Also transitively blocked by: ${formatBlockers(blockingInfo.transitiveBlockers)}`;
    } else if (blockingInfo.directBlockers.length > 0) {
      message = `Requirement blocked by: ${formatBlockers(blockingInfo.directBlockers)}`;
    } else {
      message = `Requirement transitively blocked by: ${formatBlockers(blockingInfo.transitiveBlockers)}`;
    }

    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Information,
      range: {
        start: {
          line: node.location.startLine,
          character: node.location.startColumn,
        },
        end: {
          line: node.location.startLine,
          // Highlight just the @requirement keyword and identifier
          character:
            node.location.startColumn + "@requirement".length + 1 + node.name.length,
        },
      },
      message,
      source: "blueprint",
      code: "blocked-requirement",
    };

    const fileDiagnostics = byFile.get(symbol.fileUri);
    if (fileDiagnostics) {
      fileDiagnostics.push(diagnostic);
    } else {
      byFile.set(symbol.fileUri, [diagnostic]);
    }
  }

  return {
    byFile,
    filesWithDiagnostics: Array.from(byFile.keys()),
  };
}

/**
 * Compute all workspace-level diagnostics.
 *
 * This combines:
 * - Circular dependency detection
 * - Unresolved reference detection
 * - Requirements without tickets (warning)
 * - Blocked requirements (info)
 *
 * @param symbolIndex The cross-file symbol index
 * @param tickets Optional array of all tickets (for no-ticket warnings and blocking diagnostics)
 * @returns Combined diagnostics grouped by file URI
 */
export function computeWorkspaceDiagnostics(
  symbolIndex: CrossFileSymbolIndex,
  tickets?: Ticket[]
): WorkspaceDiagnosticsResult {
  const circularDeps = computeCircularDependencyDiagnostics(symbolIndex);
  const unresolvedRefs = computeUnresolvedReferenceDiagnostics(symbolIndex);

  if (tickets) {
    const noTicket = computeNoTicketDiagnostics(symbolIndex, tickets);
    const blocking = computeBlockingDiagnostics(symbolIndex, tickets);
    return mergeDiagnosticResults(circularDeps, unresolvedRefs, noTicket, blocking);
  }

  return mergeDiagnosticResults(circularDeps, unresolvedRefs);
}
