import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver/node";
import type { CrossFileSymbolIndex, IndexedSymbol } from "./symbol-index";
import { DependencyGraph, type CircularDependency } from "./dependency-graph";
import type { Ticket } from "./tickets";

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
 * Compute all workspace-level diagnostics.
 *
 * This combines:
 * - Circular dependency detection
 * - Unresolved reference detection
 * - Requirements without tickets (warning)
 *
 * @param symbolIndex The cross-file symbol index
 * @param tickets Optional array of all tickets (for no-ticket warnings)
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
    return mergeDiagnosticResults(circularDeps, unresolvedRefs, noTicket);
  }

  return mergeDiagnosticResults(circularDeps, unresolvedRefs);
}
