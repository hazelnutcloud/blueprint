/**
 * Benchmark tests for hover response latency.
 *
 * These benchmarks measure:
 * - findHoverTarget() performance for different node types
 * - buildHover() performance for requirements, features, modules
 * - End-to-end hover latency with various complexity levels
 * - Impact of ticket data and dependency graphs on hover performance
 *
 * Run with: bun run benchmarks/hover.bench.ts
 */

import type { Position } from "vscode-languageserver/node";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import { DependencyGraph } from "../src/dependency-graph";
import { buildRequirementTicketMapFromSymbols } from "../src/requirement-ticket-map";
import { findHoverTarget, buildHover, type HoverContext } from "../src/hover";
import type { Ticket, TicketStatus } from "../src/tickets";

// ============================================================================
// Configuration
// ============================================================================

/** Number of iterations for each benchmark */
const ITERATIONS = 100;

/** Warm-up iterations before measuring */
const WARMUP_ITERATIONS = 10;

// ============================================================================
// Test Data Generators
// ============================================================================

/**
 * Generate a .bp file with the specified structure.
 */
function generateBlueprintFile(
  moduleCount: number,
  featuresPerModule: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number = 2
): string {
  const lines: string[] = [];

  lines.push("@description");
  lines.push("  Generated benchmark file for hover performance testing.");
  lines.push("  This file contains multiple modules, features, and requirements.");
  lines.push("");

  for (let m = 0; m < moduleCount; m++) {
    lines.push(`@module module-${m}`);
    if (m > 0) {
      lines.push(`  @depends-on module-${m - 1}`);
    }
    lines.push(`  This is module number ${m}.`);
    lines.push(`  It contains ${featuresPerModule} features.`);
    lines.push("");

    for (let f = 0; f < featuresPerModule; f++) {
      lines.push(`  @feature feature-${m}-${f}`);
      if (f > 0) {
        lines.push(`    @depends-on module-${m}.feature-${m}-${f - 1}`);
      }
      lines.push(`    Feature ${f} of module ${m}.`);
      lines.push(`    This feature has ${requirementsPerFeature} requirements.`);
      lines.push("");

      for (let r = 0; r < requirementsPerFeature; r++) {
        lines.push(`    @requirement req-${m}-${f}-${r}`);
        if (r > 0) {
          lines.push(`      @depends-on module-${m}.feature-${m}-${f}.req-${m}-${f}-${r - 1}`);
        }
        lines.push(`      Requirement ${r} of feature ${f} in module ${m}.`);
        lines.push("");
        lines.push("      This requirement has a detailed description that spans");
        lines.push("      multiple lines to simulate real-world usage patterns.");
        lines.push("");

        for (let c = 0; c < constraintsPerRequirement; c++) {
          lines.push(`      @constraint constraint-${m}-${f}-${r}-${c}`);
          lines.push(`        Constraint ${c} for requirement ${r}.`);
          lines.push(`        Must be implemented according to specification.`);
          lines.push("");
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate tickets for requirements in a file.
 */
function generateTickets(
  moduleCount: number,
  featuresPerModule: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number,
  completionRate: number = 0.5 // 0.0 to 1.0
): Ticket[] {
  const tickets: Ticket[] = [];
  let ticketId = 1;

  for (let m = 0; m < moduleCount; m++) {
    for (let f = 0; f < featuresPerModule; f++) {
      for (let r = 0; r < requirementsPerFeature; r++) {
        const reqPath = `module-${m}.feature-${m}-${f}.req-${m}-${f}-${r}`;

        // Determine status based on completion rate and position
        const progress =
          (m * featuresPerModule * requirementsPerFeature + f * requirementsPerFeature + r) /
          (moduleCount * featuresPerModule * requirementsPerFeature);

        let status: TicketStatus;
        const constraintsSatisfied: string[] = [];

        if (progress < completionRate * 0.8) {
          status = "complete";
          // All constraints satisfied
          for (let c = 0; c < constraintsPerRequirement; c++) {
            constraintsSatisfied.push(`constraint-${m}-${f}-${r}-${c}`);
          }
        } else if (progress < completionRate) {
          status = "in-progress";
          // Some constraints satisfied
          for (let c = 0; c < Math.floor(constraintsPerRequirement / 2); c++) {
            constraintsSatisfied.push(`constraint-${m}-${f}-${r}-${c}`);
          }
        } else {
          status = "pending";
        }

        tickets.push({
          id: `TKT-${String(ticketId++).padStart(3, "0")}`,
          ref: reqPath,
          description: `Implement ${reqPath}`,
          status,
          constraints_satisfied: constraintsSatisfied,
          implementation:
            status === "complete"
              ? {
                  files: [`src/${reqPath.replace(/\./g, "/")}.ts`],
                  tests: [`tests/${reqPath.replace(/\./g, "/")}.test.ts`],
                }
              : undefined,
        });
      }
    }
  }

  return tickets;
}

/**
 * Find line numbers for different element types in generated content.
 */
function findHoverPositions(content: string): {
  module: Position;
  feature: Position;
  requirement: Position;
  constraint: Position;
  dependsOn: Position;
  description: Position;
} {
  const lines = content.split("\n");

  let modulePos: Position = { line: 0, character: 0 };
  let featurePos: Position = { line: 0, character: 0 };
  let requirementPos: Position = { line: 0, character: 0 };
  let constraintPos: Position = { line: 0, character: 0 };
  let dependsOnPos: Position = { line: 0, character: 0 };
  let descriptionPos: Position = { line: 0, character: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.startsWith("@description") && descriptionPos.line === 0) {
      descriptionPos = { line: i, character: line.indexOf("@description") + 5 };
    } else if (trimmed.startsWith("@module") && modulePos.line === 0) {
      // Position on the module identifier
      const match = line.match(/@module\s+(\S+)/);
      if (match) {
        modulePos = { line: i, character: line.indexOf(match[1]!) };
      }
    } else if (trimmed.startsWith("@feature") && featurePos.line === 0) {
      const match = line.match(/@feature\s+(\S+)/);
      if (match) {
        featurePos = { line: i, character: line.indexOf(match[1]!) };
      }
    } else if (trimmed.startsWith("@requirement") && requirementPos.line === 0) {
      const match = line.match(/@requirement\s+(\S+)/);
      if (match) {
        requirementPos = { line: i, character: line.indexOf(match[1]!) };
      }
    } else if (trimmed.startsWith("@constraint") && constraintPos.line === 0) {
      const match = line.match(/@constraint\s+(\S+)/);
      if (match) {
        constraintPos = { line: i, character: line.indexOf(match[1]!) };
      }
    } else if (trimmed.startsWith("@depends-on") && dependsOnPos.line === 0) {
      // Position on the reference part
      const match = line.match(/@depends-on\s+(\S+)/);
      if (match) {
        dependsOnPos = { line: i, character: line.indexOf(match[1]!) };
      }
    }
  }

  return {
    module: modulePos,
    feature: featurePos,
    requirement: requirementPos,
    constraint: constraintPos,
    dependsOn: dependsOnPos,
    description: descriptionPos,
  };
}

// ============================================================================
// Benchmark Runner
// ============================================================================

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  stdDevMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/**
 * Run a benchmark function multiple times and collect statistics.
 */
function runBenchmark(
  name: string,
  fn: () => void,
  iterations: number = ITERATIONS
): BenchmarkResult {
  const times: number[] = [];

  // Warm-up
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    fn();
  }

  // Measure
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  // Sort for percentiles
  const sorted = [...times].sort((a, b) => a - b);

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const minMs = sorted[0]!;
  const maxMs = sorted[sorted.length - 1]!;
  const variance = times.reduce((sum, t) => sum + Math.pow(t - avgMs, 2), 0) / iterations;
  const stdDevMs = Math.sqrt(variance);
  const p50Ms = sorted[Math.floor(iterations * 0.5)]!;
  const p95Ms = sorted[Math.floor(iterations * 0.95)]!;
  const p99Ms = sorted[Math.floor(iterations * 0.99)]!;

  return {
    name,
    iterations,
    totalMs,
    avgMs,
    minMs,
    maxMs,
    stdDevMs,
    p50Ms,
    p95Ms,
    p99Ms,
  };
}

/**
 * Format a benchmark result for display.
 */
function formatResult(result: BenchmarkResult): string {
  return [
    `${result.name}:`,
    `  Iterations: ${result.iterations}`,
    `  Average:    ${result.avgMs.toFixed(3)} ms`,
    `  Min:        ${result.minMs.toFixed(3)} ms`,
    `  Max:        ${result.maxMs.toFixed(3)} ms`,
    `  Std Dev:    ${result.stdDevMs.toFixed(3)} ms`,
    `  P50:        ${result.p50Ms.toFixed(3)} ms`,
    `  P95:        ${result.p95Ms.toFixed(3)} ms`,
    `  P99:        ${result.p99Ms.toFixed(3)} ms`,
  ].join("\n");
}

// ============================================================================
// Benchmark Suites
// ============================================================================

/**
 * Benchmark findHoverTarget() for different element types.
 */
async function runFindTargetBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("FIND HOVER TARGET BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring findHoverTarget() performance for different element types...\n");

  // Generate a medium-sized file
  const content = generateBlueprintFile(5, 3, 5, 2);
  const tree = parseDocument(content);
  if (!tree) {
    console.error("Failed to parse test file");
    return;
  }

  const ast = transformToAST(tree);
  const symbolIndex = new CrossFileSymbolIndex();
  const fileUri = "file:///workspace/requirements/test.bp";
  symbolIndex.addFile(fileUri, ast);

  const positions = findHoverPositions(content);
  const results: BenchmarkResult[] = [];

  console.log("Hover positions found:");
  console.log(`  @description: line ${positions.description.line}`);
  console.log(`  @module: line ${positions.module.line}`);
  console.log(`  @feature: line ${positions.feature.line}`);
  console.log(`  @requirement: line ${positions.requirement.line}`);
  console.log(`  @constraint: line ${positions.constraint.line}`);
  console.log(`  @depends-on ref: line ${positions.dependsOn.line}`);
  console.log("");

  // Benchmark each position type
  const positionTypes: [string, Position][] = [
    ["@description", positions.description],
    ["@module identifier", positions.module],
    ["@feature identifier", positions.feature],
    ["@requirement identifier", positions.requirement],
    ["@constraint identifier", positions.constraint],
    ["@depends-on reference", positions.dependsOn],
  ];

  for (const [name, position] of positionTypes) {
    const result = runBenchmark(`findHoverTarget (${name})`, () => {
      findHoverTarget(tree, position, symbolIndex, fileUri);
    });
    results.push(result);
    console.log(formatResult(result));
    console.log("");
  }

  tree.delete();

  // Summary table
  console.log("-".repeat(70));
  console.log("FIND TARGET SUMMARY");
  console.log("-".repeat(70));
  console.log("");
  console.log(
    "| Target Type".padEnd(35) +
      "| Avg (ms)".padEnd(12) +
      "| P95 (ms)".padEnd(12) +
      "| P99 (ms)".padEnd(12) +
      "|"
  );
  console.log(
    "|" + "-".repeat(34) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|"
  );
  for (const result of results) {
    console.log(
      `| ${result.name}`.padEnd(35) +
        `| ${result.avgMs.toFixed(3)}`.padEnd(12) +
        `| ${result.p95Ms.toFixed(3)}`.padEnd(12) +
        `| ${result.p99Ms.toFixed(3)}`.padEnd(12) +
        "|"
    );
  }
  console.log("");
}

/**
 * Benchmark buildHover() for different target types with full context.
 */
async function runBuildHoverBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("BUILD HOVER BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring buildHover() performance with full ticket and dependency context...\n");

  // Generate a medium-sized file with tickets
  const modules = 5;
  const features = 3;
  const requirements = 5;
  const constraints = 2;

  const content = generateBlueprintFile(modules, features, requirements, constraints);
  const tree = parseDocument(content);
  if (!tree) {
    console.error("Failed to parse test file");
    return;
  }

  const ast = transformToAST(tree);
  const symbolIndex = new CrossFileSymbolIndex();
  const fileUri = "file:///workspace/requirements/test.bp";
  symbolIndex.addFile(fileUri, ast);

  // Generate tickets
  const tickets = generateTickets(modules, features, requirements, constraints, 0.6);
  const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
  const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);

  // Build dependency graph
  const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

  const positions = findHoverPositions(content);
  const results: BenchmarkResult[] = [];

  const totalReqs = modules * features * requirements;
  const totalConstraints = totalReqs * constraints;
  console.log(
    `File structure: ${modules} modules, ${modules * features} features, ${totalReqs} requirements, ${totalConstraints} constraints`
  );
  console.log(`Tickets: ${tickets.length}`);
  console.log(`Dependency edges: ${dependencyGraph.edges.length}`);
  console.log("");

  // Test each target type
  const targetTypes: [string, Position][] = [
    ["@module", positions.module],
    ["@feature", positions.feature],
    ["@requirement", positions.requirement],
    ["@constraint", positions.constraint],
    ["@depends-on reference", positions.dependsOn],
  ];

  for (const [name, position] of targetTypes) {
    const target = findHoverTarget(tree, position, symbolIndex, fileUri);
    if (!target) {
      console.log(`Warning: Could not find target for ${name}`);
      continue;
    }

    const context: HoverContext = {
      symbolIndex,
      ticketMap,
      dependencyGraph,
      cycles,
      fileUri,
      workspaceFolderUris: ["file:///workspace"],
    };

    const result = runBenchmark(`buildHover (${name})`, () => {
      buildHover(target, context);
    });
    results.push(result);
    console.log(formatResult(result));
    console.log("");
  }

  tree.delete();

  // Summary table
  console.log("-".repeat(70));
  console.log("BUILD HOVER SUMMARY");
  console.log("-".repeat(70));
  console.log("");
  console.log(
    "| Target Type".padEnd(35) +
      "| Avg (ms)".padEnd(12) +
      "| P95 (ms)".padEnd(12) +
      "| P99 (ms)".padEnd(12) +
      "|"
  );
  console.log(
    "|" + "-".repeat(34) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|"
  );
  for (const result of results) {
    console.log(
      `| ${result.name}`.padEnd(35) +
        `| ${result.avgMs.toFixed(3)}`.padEnd(12) +
        `| ${result.p95Ms.toFixed(3)}`.padEnd(12) +
        `| ${result.p99Ms.toFixed(3)}`.padEnd(12) +
        "|"
    );
  }
  console.log("");
}

/**
 * Benchmark end-to-end hover latency (findTarget + buildHover).
 */
async function runEndToEndBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("END-TO-END HOVER LATENCY BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring complete hover response time (findTarget + buildHover)...\n");

  // Test different file sizes
  const testCases: [string, number, number, number, number][] = [
    ["Small (1 module, 2 features, 3 reqs)", 1, 2, 3, 2],
    ["Medium (5 modules, 3 features, 5 reqs)", 5, 3, 5, 2],
    ["Large (10 modules, 5 features, 10 reqs)", 10, 5, 10, 3],
    ["XLarge (20 modules, 10 features, 10 reqs)", 20, 10, 10, 3],
  ];

  const results: BenchmarkResult[] = [];

  for (const [name, modules, features, requirements, constraints] of testCases) {
    console.log("-".repeat(70));
    console.log(`Test Case: ${name}`);

    const content = generateBlueprintFile(modules, features, requirements, constraints);
    const tree = parseDocument(content);
    if (!tree) {
      console.error("Failed to parse test file");
      continue;
    }

    const ast = transformToAST(tree);
    const symbolIndex = new CrossFileSymbolIndex();
    const fileUri = "file:///workspace/requirements/test.bp";
    symbolIndex.addFile(fileUri, ast);

    // Generate tickets
    const tickets = generateTickets(modules, features, requirements, constraints, 0.5);
    const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
    const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);

    // Build dependency graph
    const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

    const positions = findHoverPositions(content);
    const totalReqs = modules * features * requirements;

    console.log(`  Requirements: ${totalReqs}`);
    console.log(`  Tickets: ${tickets.length}`);
    console.log(`  Dependency edges: ${dependencyGraph.edges.length}`);
    console.log("");

    const context: HoverContext = {
      symbolIndex,
      ticketMap,
      dependencyGraph,
      cycles,
      fileUri,
      workspaceFolderUris: ["file:///workspace"],
    };

    // Benchmark hover on requirement (most complex case)
    const result = runBenchmark(`E2E hover ${name}`, () => {
      const target = findHoverTarget(tree, positions.requirement, symbolIndex, fileUri);
      if (target) {
        buildHover(target, context);
      }
    });
    results.push(result);
    console.log(formatResult(result));
    console.log("");

    tree.delete();
  }

  // Summary table
  console.log("=".repeat(70));
  console.log("END-TO-END SUMMARY");
  console.log("=".repeat(70));
  console.log("");
  console.log(
    "| File Size".padEnd(45) +
      "| Avg (ms)".padEnd(12) +
      "| P95 (ms)".padEnd(12) +
      "| P99 (ms)".padEnd(12) +
      "|"
  );
  console.log(
    "|" + "-".repeat(44) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|"
  );
  for (const result of results) {
    console.log(
      `| ${result.name}`.padEnd(45) +
        `| ${result.avgMs.toFixed(3)}`.padEnd(12) +
        `| ${result.p95Ms.toFixed(3)}`.padEnd(12) +
        `| ${result.p99Ms.toFixed(3)}`.padEnd(12) +
        "|"
    );
  }
  console.log("");
}

/**
 * Benchmark hover performance scaling with file size.
 */
async function runScalingBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("HOVER LATENCY SCALING BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring how hover latency scales with file size...\n");

  const scalingResults: {
    requirements: number;
    tickets: number;
    findTargetMs: number;
    buildHoverMs: number;
    totalMs: number;
  }[] = [];

  // Scale by increasing module count
  for (const moduleCount of [1, 2, 5, 10, 20, 50]) {
    const features = 3;
    const requirements = 5;
    const constraints = 2;

    const content = generateBlueprintFile(moduleCount, features, requirements, constraints);
    const tree = parseDocument(content);
    if (!tree) continue;

    const ast = transformToAST(tree);
    const symbolIndex = new CrossFileSymbolIndex();
    const fileUri = "file:///workspace/requirements/test.bp";
    symbolIndex.addFile(fileUri, ast);

    const tickets = generateTickets(moduleCount, features, requirements, constraints, 0.5);
    const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
    const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);
    const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

    const positions = findHoverPositions(content);
    const totalReqs = moduleCount * features * requirements;

    const context: HoverContext = {
      symbolIndex,
      ticketMap,
      dependencyGraph,
      cycles,
      fileUri,
      workspaceFolderUris: ["file:///workspace"],
    };

    // Measure findHoverTarget
    const findTimes: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      findHoverTarget(tree, positions.requirement, symbolIndex, fileUri);
      findTimes.push(performance.now() - start);
    }
    const avgFindMs = findTimes.reduce((a, b) => a + b, 0) / findTimes.length;

    // Measure buildHover
    const target = findHoverTarget(tree, positions.requirement, symbolIndex, fileUri);
    const buildTimes: number[] = [];
    if (target) {
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        buildHover(target, context);
        buildTimes.push(performance.now() - start);
      }
    }
    const avgBuildMs =
      buildTimes.length > 0 ? buildTimes.reduce((a, b) => a + b, 0) / buildTimes.length : 0;

    scalingResults.push({
      requirements: totalReqs,
      tickets: tickets.length,
      findTargetMs: avgFindMs,
      buildHoverMs: avgBuildMs,
      totalMs: avgFindMs + avgBuildMs,
    });

    tree.delete();
  }

  console.log(
    "| Requirements".padEnd(15) +
      "| Tickets".padEnd(10) +
      "| Find (ms)".padEnd(12) +
      "| Build (ms)".padEnd(12) +
      "| Total (ms)".padEnd(12) +
      "|"
  );
  console.log(
    "|" +
      "-".repeat(14) +
      "|" +
      "-".repeat(9) +
      "|" +
      "-".repeat(11) +
      "|" +
      "-".repeat(11) +
      "|" +
      "-".repeat(11) +
      "|"
  );
  for (const r of scalingResults) {
    console.log(
      `| ${r.requirements}`.padEnd(15) +
        `| ${r.tickets}`.padEnd(10) +
        `| ${r.findTargetMs.toFixed(3)}`.padEnd(12) +
        `| ${r.buildHoverMs.toFixed(3)}`.padEnd(12) +
        `| ${r.totalMs.toFixed(3)}`.padEnd(12) +
        "|"
    );
  }
  console.log("");

  // Calculate scaling factor
  if (scalingResults.length >= 2) {
    const first = scalingResults[0]!;
    const last = scalingResults[scalingResults.length - 1]!;
    const reqRatio = last.requirements / first.requirements;
    const timeRatio = last.totalMs / first.totalMs;
    console.log(`Scaling analysis:`);
    console.log(`  Requirements increased ${reqRatio.toFixed(1)}x`);
    console.log(`  Hover time increased ${timeRatio.toFixed(1)}x`);
    console.log(`  Scaling factor: O(n^${(Math.log(timeRatio) / Math.log(reqRatio)).toFixed(2)})`);
    console.log("");
  }
}

/**
 * Benchmark hover with and without ticket data.
 */
async function runTicketImpactBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("TICKET DATA IMPACT BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring hover performance with/without ticket data...\n");

  const modules = 10;
  const features = 5;
  const requirements = 10;
  const constraints = 3;

  const content = generateBlueprintFile(modules, features, requirements, constraints);
  const tree = parseDocument(content);
  if (!tree) {
    console.error("Failed to parse test file");
    return;
  }

  const ast = transformToAST(tree);
  const symbolIndex = new CrossFileSymbolIndex();
  const fileUri = "file:///workspace/requirements/test.bp";
  symbolIndex.addFile(fileUri, ast);

  const positions = findHoverPositions(content);
  const target = findHoverTarget(tree, positions.requirement, symbolIndex, fileUri);
  if (!target) {
    console.error("Failed to find target");
    tree.delete();
    return;
  }

  const results: BenchmarkResult[] = [];
  const totalReqs = modules * features * requirements;

  console.log(`File: ${totalReqs} requirements, ${totalReqs * constraints} constraints`);
  console.log("");

  const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");

  // Without tickets
  {
    const { map: emptyTicketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, []);
    const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

    const context: HoverContext = {
      symbolIndex,
      ticketMap: emptyTicketMap,
      dependencyGraph,
      cycles,
      fileUri,
    };

    const result = runBenchmark("buildHover (no tickets)", () => {
      buildHover(target, context);
    });
    results.push(result);
    console.log(formatResult(result));
    console.log("");
  }

  // With 50% tickets
  {
    const tickets = generateTickets(modules, features, requirements, constraints, 0.5);
    const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);
    const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

    const context: HoverContext = {
      symbolIndex,
      ticketMap,
      dependencyGraph,
      cycles,
      fileUri,
    };

    const result = runBenchmark(`buildHover (${tickets.length} tickets, 50%)`, () => {
      buildHover(target, context);
    });
    results.push(result);
    console.log(formatResult(result));
    console.log("");
  }

  // With 100% tickets
  {
    const tickets = generateTickets(modules, features, requirements, constraints, 1.0);
    const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);
    const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

    const context: HoverContext = {
      symbolIndex,
      ticketMap,
      dependencyGraph,
      cycles,
      fileUri,
    };

    const result = runBenchmark(`buildHover (${tickets.length} tickets, 100%)`, () => {
      buildHover(target, context);
    });
    results.push(result);
    console.log(formatResult(result));
    console.log("");
  }

  tree.delete();

  // Summary
  console.log("-".repeat(70));
  console.log("TICKET IMPACT SUMMARY");
  console.log("-".repeat(70));
  console.log("");
  console.log(
    "| Ticket Coverage".padEnd(40) + "| Avg (ms)".padEnd(12) + "| P95 (ms)".padEnd(12) + "|"
  );
  console.log("|" + "-".repeat(39) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|");
  for (const result of results) {
    console.log(
      `| ${result.name}`.padEnd(40) +
        `| ${result.avgMs.toFixed(3)}`.padEnd(12) +
        `| ${result.p95Ms.toFixed(3)}`.padEnd(12) +
        "|"
    );
  }
  console.log("");
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("");
  console.log("Blueprint Hover Response Latency Benchmarks");
  console.log("============================================");
  console.log("");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Bun version: ${Bun.version}`);
  console.log("");

  try {
    console.log("Initializing parser...\n");
    await initializeParser();

    await runFindTargetBenchmarks();
    await runBuildHoverBenchmarks();
    await runEndToEndBenchmarks();
    await runScalingBenchmarks();
    await runTicketImpactBenchmarks();

    console.log("=".repeat(70));
    console.log("All benchmarks completed successfully!");
    console.log("=".repeat(70));
  } catch (error) {
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

main();
