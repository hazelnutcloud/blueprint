/**
 * Benchmark tests for parsing .bp files.
 *
 * These benchmarks measure:
 * - Tree-sitter parsing performance for various file sizes
 * - AST transformation performance
 * - Symbol table construction performance
 *
 * Run with: bun run benchmarks/parsing.bench.ts
 */

import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST, buildSymbolTable } from "../src/ast";

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
 * Generate a .bp file with the specified number of modules, features, and requirements.
 */
function generateBlueprintFile(
  moduleCount: number,
  featuresPerModule: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number = 2
): string {
  const lines: string[] = [];

  lines.push("@description");
  lines.push("  Generated benchmark file for performance testing.");
  lines.push("  This file contains multiple modules, features, and requirements.");
  lines.push("");

  for (let m = 0; m < moduleCount; m++) {
    lines.push(`@module module-${m}`);
    lines.push(`  This is module number ${m}.`);
    lines.push(`  It contains ${featuresPerModule} features.`);
    lines.push("");

    for (let f = 0; f < featuresPerModule; f++) {
      lines.push(`  @feature feature-${m}-${f}`);
      if (m > 0 || f > 0) {
        // Add a dependency to the previous feature
        const depModule = f > 0 ? m : m - 1;
        const depFeature = f > 0 ? f - 1 : featuresPerModule - 1;
        lines.push(`    @depends-on module-${depModule}.feature-${depModule}-${depFeature}`);
      }
      lines.push(`    Feature ${f} of module ${m}.`);
      lines.push(`    This feature has ${requirementsPerFeature} requirements.`);
      lines.push("");

      for (let r = 0; r < requirementsPerFeature; r++) {
        lines.push(`    @requirement req-${m}-${f}-${r}`);
        if (r > 0) {
          // Add dependency to previous requirement
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
 * Calculate approximate metrics for a generated file.
 */
function calculateFileMetrics(
  moduleCount: number,
  featuresPerModule: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number
): { modules: number; features: number; requirements: number; constraints: number } {
  const features = moduleCount * featuresPerModule;
  const requirements = features * requirementsPerFeature;
  const constraints = requirements * constraintsPerRequirement;
  return { modules: moduleCount, features, requirements, constraints };
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
  opsPerSec: number;
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

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  const variance = times.reduce((sum, t) => sum + Math.pow(t - avgMs, 2), 0) / iterations;
  const stdDevMs = Math.sqrt(variance);
  const opsPerSec = 1000 / avgMs;

  return {
    name,
    iterations,
    totalMs,
    avgMs,
    minMs,
    maxMs,
    stdDevMs,
    opsPerSec,
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
    `  Ops/sec:    ${result.opsPerSec.toFixed(1)}`,
  ].join("\n");
}

// ============================================================================
// Benchmark Suites
// ============================================================================

async function runParsingBenchmarks(): Promise<void> {
  console.log("Initializing parser...\n");
  await initializeParser();

  console.log("=".repeat(70));
  console.log("PARSING BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");

  // Define test cases: [modules, features/module, requirements/feature, constraints/requirement]
  const testCases: [string, number, number, number, number][] = [
    ["Small (1 module, 2 features, 3 reqs)", 1, 2, 3, 2],
    ["Medium (5 modules, 3 features, 5 reqs)", 5, 3, 5, 2],
    ["Large (10 modules, 5 features, 10 reqs)", 10, 5, 10, 3],
    ["XLarge (20 modules, 10 features, 10 reqs)", 20, 10, 10, 3],
  ];

  const results: BenchmarkResult[] = [];

  for (const [name, modules, features, requirements, constraints] of testCases) {
    const content = generateBlueprintFile(modules, features, requirements, constraints);
    const metrics = calculateFileMetrics(modules, features, requirements, constraints);
    const fileSize = Buffer.byteLength(content, "utf-8");

    console.log("-".repeat(70));
    console.log(`Test Case: ${name}`);
    console.log(
      `  File size: ${(fileSize / 1024).toFixed(1)} KB (${content.split("\n").length} lines)`
    );
    console.log(
      `  Elements: ${metrics.modules} modules, ${metrics.features} features, ` +
        `${metrics.requirements} requirements, ${metrics.constraints} constraints`
    );
    console.log("");

    // Benchmark 1: Tree-sitter parsing only
    const parseResult = runBenchmark(`Parse ${name}`, () => {
      const tree = parseDocument(content);
      tree?.delete();
    });
    results.push(parseResult);
    console.log(formatResult(parseResult));
    console.log("");

    // Benchmark 2: Parse + AST transformation
    const astResult = runBenchmark(`Parse + AST ${name}`, () => {
      const tree = parseDocument(content);
      if (tree) {
        transformToAST(tree);
        tree.delete();
      }
    });
    results.push(astResult);
    console.log(formatResult(astResult));
    console.log("");

    // Benchmark 3: Parse + AST + Symbol table
    const symbolResult = runBenchmark(`Parse + AST + Symbols ${name}`, () => {
      const tree = parseDocument(content);
      if (tree) {
        const ast = transformToAST(tree);
        buildSymbolTable(ast);
        tree.delete();
      }
    });
    results.push(symbolResult);
    console.log(formatResult(symbolResult));
    console.log("");
  }

  // Summary table
  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log("");
  console.log("| Benchmark".padEnd(50) + "| Avg (ms)".padEnd(12) + "| Ops/sec".padEnd(12) + "|");
  console.log("|" + "-".repeat(49) + "|" + "-".repeat(11) + "|" + "-".repeat(11) + "|");
  for (const result of results) {
    console.log(
      `| ${result.name}`.padEnd(50) +
        `| ${result.avgMs.toFixed(3)}`.padEnd(12) +
        `| ${result.opsPerSec.toFixed(1)}`.padEnd(12) +
        "|"
    );
  }
  console.log("");
}

async function runScalingBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("SCALING BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring how parsing time scales with file size...\n");

  // Test scaling: keep features/requirements constant, vary modules
  const scalingResults: { modules: number; fileSize: number; parseMs: number; totalMs: number }[] =
    [];

  for (const moduleCount of [1, 2, 5, 10, 20, 50]) {
    const content = generateBlueprintFile(moduleCount, 3, 5, 2);
    const fileSize = Buffer.byteLength(content, "utf-8");

    // Run a few iterations for more stable results
    const parseTimes: number[] = [];
    const totalTimes: number[] = [];

    for (let i = 0; i < 20; i++) {
      const parseStart = performance.now();
      const tree = parseDocument(content);
      const parseEnd = performance.now();

      if (tree) {
        const ast = transformToAST(tree);
        buildSymbolTable(ast);
        tree.delete();
      }
      const totalEnd = performance.now();

      parseTimes.push(parseEnd - parseStart);
      totalTimes.push(totalEnd - parseStart);
    }

    const avgParse = parseTimes.reduce((a, b) => a + b, 0) / parseTimes.length;
    const avgTotal = totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length;

    scalingResults.push({
      modules: moduleCount,
      fileSize,
      parseMs: avgParse,
      totalMs: avgTotal,
    });
  }

  console.log(
    "| Modules".padEnd(10) +
      "| Size (KB)".padEnd(12) +
      "| Parse (ms)".padEnd(14) +
      "| Total (ms)".padEnd(14) +
      "|"
  );
  console.log(
    "|" + "-".repeat(9) + "|" + "-".repeat(11) + "|" + "-".repeat(13) + "|" + "-".repeat(13) + "|"
  );
  for (const r of scalingResults) {
    console.log(
      `| ${r.modules}`.padEnd(10) +
        `| ${(r.fileSize / 1024).toFixed(1)}`.padEnd(12) +
        `| ${r.parseMs.toFixed(3)}`.padEnd(14) +
        `| ${r.totalMs.toFixed(3)}`.padEnd(14) +
        "|"
    );
  }
  console.log("");

  // Calculate scaling factor
  if (scalingResults.length >= 2) {
    const first = scalingResults[0]!;
    const last = scalingResults[scalingResults.length - 1]!;
    const sizeRatio = last.fileSize / first.fileSize;
    const timeRatio = last.totalMs / first.totalMs;
    console.log(`Scaling analysis:`);
    console.log(`  File size increased ${sizeRatio.toFixed(1)}x`);
    console.log(`  Processing time increased ${timeRatio.toFixed(1)}x`);
    console.log(`  Scaling factor: O(n^${(Math.log(timeRatio) / Math.log(sizeRatio)).toFixed(2)})`);
    console.log("");
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("");
  console.log("Blueprint DSL Parser Benchmarks");
  console.log("================================");
  console.log("");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Bun version: ${Bun.version}`);
  console.log("");

  try {
    await runParsingBenchmarks();
    await runScalingBenchmarks();

    console.log("=".repeat(70));
    console.log("Benchmarks completed successfully!");
    console.log("=".repeat(70));
  } catch (error) {
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

main();
