/**
 * Benchmark tests for workspace indexing operations.
 *
 * These benchmarks measure:
 * - Directory scanning performance for various workspace sizes
 * - Symbol indexing performance for multiple files
 * - Cross-file reference resolution performance
 * - Full workspace indexing pipeline
 *
 * Run with: bun run benchmarks/workspace-indexing.bench.ts
 */

import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URI } from "vscode-uri";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST, type ReferenceNode } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";

/**
 * Create a mock ReferenceNode for benchmarking reference resolution.
 */
function createMockReference(path: string): ReferenceNode {
  return {
    type: "reference",
    path,
    parts: path.split("."),
    location: {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: path.length,
      startOffset: 0,
      endOffset: path.length,
    },
  };
}

// ============================================================================
// Configuration
// ============================================================================

/** Number of iterations for each benchmark */
const ITERATIONS = 50;

/** Warm-up iterations before measuring */
const WARMUP_ITERATIONS = 5;

// ============================================================================
// Test Data Generators
// ============================================================================

/**
 * Generate a .bp file content with the specified structure.
 */
function generateBlueprintFile(
  moduleName: string,
  featureCount: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number = 2,
  crossFileDependencies: string[] = []
): string {
  const lines: string[] = [];

  lines.push("@description");
  lines.push(`  Module ${moduleName} for performance testing.`);
  lines.push("");

  lines.push(`@module ${moduleName}`);
  if (crossFileDependencies.length > 0) {
    lines.push(`  @depends-on ${crossFileDependencies.join(", ")}`);
  }
  lines.push(`  This is the ${moduleName} module.`);
  lines.push("");

  for (let f = 0; f < featureCount; f++) {
    const featureName = `feature-${f}`;
    lines.push(`  @feature ${featureName}`);
    lines.push(`    Feature ${f} of ${moduleName}.`);
    lines.push("");

    for (let r = 0; r < requirementsPerFeature; r++) {
      const reqName = `req-${f}-${r}`;
      lines.push(`    @requirement ${reqName}`);
      if (r > 0) {
        lines.push(`      @depends-on ${moduleName}.${featureName}.req-${f}-${r - 1}`);
      }
      lines.push(`      Requirement ${r} of feature ${f}.`);
      lines.push("");

      for (let c = 0; c < constraintsPerRequirement; c++) {
        lines.push(`      @constraint constraint-${f}-${r}-${c}`);
        lines.push(`        Constraint ${c} for requirement ${r}.`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Create a temporary workspace with generated .bp files.
 */
async function createTestWorkspace(
  fileCount: number,
  featuresPerFile: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number = 2,
  withCrossFileDeps: boolean = false
): Promise<{ path: string; files: string[]; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "blueprint-bench-"));
  const reqDir = join(tempDir, "requirements");
  await mkdir(reqDir);

  const files: string[] = [];
  const moduleNames: string[] = [];

  for (let i = 0; i < fileCount; i++) {
    const moduleName = `module-${i}`;
    moduleNames.push(moduleName);

    // Add cross-file dependencies to previous modules
    const deps: string[] = [];
    if (withCrossFileDeps && i > 0) {
      // Depend on the previous module
      deps.push(`module-${i - 1}`);
    }

    const content = generateBlueprintFile(
      moduleName,
      featuresPerFile,
      requirementsPerFeature,
      constraintsPerRequirement,
      deps
    );

    const filePath = join(reqDir, `${moduleName}.bp`);
    await writeFile(filePath, content, "utf-8");
    files.push(filePath);
  }

  return {
    path: tempDir,
    files,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
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
 * Run an async benchmark function multiple times and collect statistics.
 */
async function runAsyncBenchmark(
  name: string,
  fn: () => Promise<void>,
  iterations: number = ITERATIONS
): Promise<BenchmarkResult> {
  const times: number[] = [];

  // Warm-up
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await fn();
  }

  // Measure
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
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

/**
 * Benchmark symbol indexing for pre-parsed files.
 * This isolates the CrossFileSymbolIndex performance from parsing.
 */
async function runSymbolIndexingBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("SYMBOL INDEXING BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring CrossFileSymbolIndex.addFile() performance...\n");

  // Test cases: [name, fileCount, features, requirements, constraints]
  const testCases: [string, number, number, number, number][] = [
    ["Small (5 files, 2 features, 3 reqs)", 5, 2, 3, 2],
    ["Medium (20 files, 3 features, 5 reqs)", 20, 3, 5, 2],
    ["Large (50 files, 5 features, 10 reqs)", 50, 5, 10, 3],
    ["XLarge (100 files, 5 features, 10 reqs)", 100, 5, 10, 3],
  ];

  const results: BenchmarkResult[] = [];

  for (const [name, fileCount, features, requirements, constraints] of testCases) {
    console.log("-".repeat(70));
    console.log(`Test Case: ${name}`);

    // Pre-generate file contents and parse them
    const parsedFiles: Array<{
      uri: string;
      ast: ReturnType<typeof transformToAST>;
    }> = [];

    for (let i = 0; i < fileCount; i++) {
      const content = generateBlueprintFile(
        `module-${i}`,
        features,
        requirements,
        constraints,
        i > 0 ? [`module-${i - 1}`] : []
      );
      const tree = parseDocument(content);
      if (tree) {
        const ast = transformToAST(tree);
        parsedFiles.push({
          uri: `file:///workspace/requirements/module-${i}.bp`,
          ast,
        });
        tree.delete();
      }
    }

    const totalSymbols =
      fileCount * (1 + features + features * requirements + features * requirements * constraints);
    console.log(`  Files: ${fileCount}`);
    console.log(`  Total symbols: ~${totalSymbols}`);
    console.log("");

    // Benchmark indexing all files
    const indexResult = runBenchmark(`Index ${fileCount} files`, () => {
      const index = new CrossFileSymbolIndex();
      for (const { uri, ast } of parsedFiles) {
        index.addFile(uri, ast);
      }
    });
    results.push(indexResult);
    console.log(formatResult(indexResult));
    console.log(`  Symbols/ms: ${(totalSymbols / indexResult.avgMs).toFixed(1)}`);
    console.log("");

    // Benchmark incremental update (re-indexing one file)
    const index = new CrossFileSymbolIndex();
    for (const { uri, ast } of parsedFiles) {
      index.addFile(uri, ast);
    }

    const updateResult = runBenchmark(`Update 1 file (in ${fileCount}-file index)`, () => {
      // Re-index the last file (simulates file save)
      const lastFile = parsedFiles[parsedFiles.length - 1]!;
      index.addFile(lastFile.uri, lastFile.ast);
    });
    results.push(updateResult);
    console.log(formatResult(updateResult));
    console.log("");
  }

  // Summary table
  console.log("=".repeat(70));
  console.log("SYMBOL INDEXING SUMMARY");
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

/**
 * Benchmark cross-file reference resolution.
 */
async function runReferenceResolutionBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("REFERENCE RESOLUTION BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring CrossFileSymbolIndex.resolveReference() performance...\n");

  // Create a large index
  const fileCount = 50;
  const features = 5;
  const requirements = 10;
  const constraints = 3;

  console.log("Setting up index with:");
  console.log(`  Files: ${fileCount}`);
  console.log(`  Features per file: ${features}`);
  console.log(`  Requirements per feature: ${requirements}`);
  console.log(`  Constraints per requirement: ${constraints}`);
  console.log("");

  const index = new CrossFileSymbolIndex();
  const allRefs: ReferenceNode[] = [];

  for (let i = 0; i < fileCount; i++) {
    const moduleName = `module-${i}`;
    const content = generateBlueprintFile(
      moduleName,
      features,
      requirements,
      constraints,
      i > 0 ? [`module-${i - 1}`] : []
    );
    const tree = parseDocument(content);
    if (tree) {
      const ast = transformToAST(tree);
      const uri = `file:///workspace/requirements/${moduleName}.bp`;
      index.addFile(uri, ast);
      tree.delete();

      // Collect some reference paths for testing
      for (let f = 0; f < features; f++) {
        for (let r = 0; r < requirements; r++) {
          const path = `${moduleName}.feature-${f}.req-${f}-${r}`;
          allRefs.push(createMockReference(path));
        }
      }
    }
  }

  console.log(`Total symbols indexed: ${index.getSymbolCount()}`);
  console.log(`Reference paths to test: ${allRefs.length}`);
  console.log("");

  const results: BenchmarkResult[] = [];

  // Benchmark single reference resolution
  let refIndex = 0;
  const singleResult = runBenchmark(
    "Resolve single reference",
    () => {
      const ref = allRefs[refIndex % allRefs.length]!;
      index.resolveReference(ref);
      refIndex++;
    },
    1000
  );
  results.push(singleResult);
  console.log(formatResult(singleResult));
  console.log("");

  // Benchmark resolving all references
  const allResult = runBenchmark(
    `Resolve all ${allRefs.length} references`,
    () => {
      for (const ref of allRefs) {
        index.resolveReference(ref);
      }
    },
    20
  );
  results.push(allResult);
  console.log(formatResult(allResult));
  console.log(`  Refs/ms: ${(allRefs.length / allResult.avgMs).toFixed(1)}`);
  console.log("");

  // Benchmark getUnresolvedReferences
  const unresolvedResult = runBenchmark("Get unresolved references", () => {
    index.getUnresolvedReferences();
  });
  results.push(unresolvedResult);
  console.log(formatResult(unresolvedResult));
  console.log("");

  // Summary
  console.log("=".repeat(70));
  console.log("REFERENCE RESOLUTION SUMMARY");
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

/**
 * Benchmark full workspace indexing pipeline (parse + AST + index).
 */
async function runFullPipelineBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("FULL PIPELINE BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring complete workspace indexing (parse + AST + symbol index)...\n");

  const testCases: [string, number, number, number, number][] = [
    ["Small workspace (5 files)", 5, 2, 3, 2],
    ["Medium workspace (20 files)", 20, 3, 5, 2],
    ["Large workspace (50 files)", 50, 5, 10, 3],
  ];

  const results: BenchmarkResult[] = [];

  for (const [name, fileCount, features, requirements, constraints] of testCases) {
    console.log("-".repeat(70));
    console.log(`Test Case: ${name}`);

    // Pre-generate file contents
    const fileContents: string[] = [];
    for (let i = 0; i < fileCount; i++) {
      const content = generateBlueprintFile(
        `module-${i}`,
        features,
        requirements,
        constraints,
        i > 0 ? [`module-${i - 1}`] : []
      );
      fileContents.push(content);
    }

    const totalSize = fileContents.reduce((sum, c) => sum + Buffer.byteLength(c, "utf-8"), 0);
    const totalSymbols =
      fileCount * (1 + features + features * requirements + features * requirements * constraints);

    console.log(`  Files: ${fileCount}`);
    console.log(`  Total size: ${(totalSize / 1024).toFixed(1)} KB`);
    console.log(`  Total symbols: ~${totalSymbols}`);
    console.log("");

    // Benchmark full pipeline
    const pipelineResult = runBenchmark(`Full index ${fileCount} files`, () => {
      const index = new CrossFileSymbolIndex();
      for (let i = 0; i < fileContents.length; i++) {
        const content = fileContents[i]!;
        const tree = parseDocument(content);
        if (tree) {
          const ast = transformToAST(tree);
          const uri = `file:///workspace/requirements/module-${i}.bp`;
          index.addFile(uri, ast);
          tree.delete();
        }
      }
    });
    results.push(pipelineResult);
    console.log(formatResult(pipelineResult));
    console.log(`  Files/sec: ${((fileCount * 1000) / pipelineResult.avgMs).toFixed(1)}`);
    console.log(`  KB/sec: ${((totalSize / 1024) * (1000 / pipelineResult.avgMs)).toFixed(1)}`);
    console.log("");
  }

  // Summary
  console.log("=".repeat(70));
  console.log("FULL PIPELINE SUMMARY");
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

/**
 * Benchmark scaling behavior of workspace indexing.
 */
async function runScalingBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("SCALING BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring how indexing time scales with workspace size...\n");

  const scalingResults: {
    files: number;
    symbols: number;
    indexMs: number;
    resolveMs: number;
  }[] = [];

  // Keep features/requirements constant, vary file count
  const features = 3;
  const requirements = 5;
  const constraints = 2;

  for (const fileCount of [1, 2, 5, 10, 20, 50, 100]) {
    // Pre-generate and parse files
    const parsedFiles: Array<{
      uri: string;
      ast: ReturnType<typeof transformToAST>;
    }> = [];

    for (let i = 0; i < fileCount; i++) {
      const content = generateBlueprintFile(
        `module-${i}`,
        features,
        requirements,
        constraints,
        i > 0 ? [`module-${i - 1}`] : []
      );
      const tree = parseDocument(content);
      if (tree) {
        const ast = transformToAST(tree);
        parsedFiles.push({
          uri: `file:///workspace/requirements/module-${i}.bp`,
          ast,
        });
        tree.delete();
      }
    }

    const symbolCount =
      fileCount * (1 + features + features * requirements + features * requirements * constraints);

    // Measure indexing
    const indexTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const index = new CrossFileSymbolIndex();
      for (const { uri, ast } of parsedFiles) {
        index.addFile(uri, ast);
      }
      const end = performance.now();
      indexTimes.push(end - start);
    }
    const avgIndex = indexTimes.reduce((a, b) => a + b, 0) / indexTimes.length;

    // Measure reference resolution (on populated index)
    const index = new CrossFileSymbolIndex();
    for (const { uri, ast } of parsedFiles) {
      index.addFile(uri, ast);
    }

    const refs: ReferenceNode[] = [];
    for (let i = 0; i < fileCount; i++) {
      for (let f = 0; f < features; f++) {
        refs.push(createMockReference(`module-${i}.feature-${f}`));
      }
    }

    const resolveTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      for (const ref of refs) {
        index.resolveReference(ref);
      }
      const end = performance.now();
      resolveTimes.push(end - start);
    }
    const avgResolve = resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length;

    scalingResults.push({
      files: fileCount,
      symbols: symbolCount,
      indexMs: avgIndex,
      resolveMs: avgResolve,
    });
  }

  console.log(
    "| Files".padEnd(10) +
      "| Symbols".padEnd(12) +
      "| Index (ms)".padEnd(14) +
      "| Resolve (ms)".padEnd(14) +
      "|"
  );
  console.log(
    "|" + "-".repeat(9) + "|" + "-".repeat(11) + "|" + "-".repeat(13) + "|" + "-".repeat(13) + "|"
  );
  for (const r of scalingResults) {
    console.log(
      `| ${r.files}`.padEnd(10) +
        `| ${r.symbols}`.padEnd(12) +
        `| ${r.indexMs.toFixed(3)}`.padEnd(14) +
        `| ${r.resolveMs.toFixed(3)}`.padEnd(14) +
        "|"
    );
  }
  console.log("");

  // Calculate scaling factors
  if (scalingResults.length >= 2) {
    const first = scalingResults[0]!;
    const last = scalingResults[scalingResults.length - 1]!;
    const symbolRatio = last.symbols / first.symbols;
    const indexRatio = last.indexMs / first.indexMs;
    const resolveRatio = last.resolveMs / first.resolveMs;

    console.log(`Scaling analysis:`);
    console.log(`  Symbols increased ${symbolRatio.toFixed(1)}x`);
    console.log(
      `  Index time increased ${indexRatio.toFixed(1)}x (O(n^${(Math.log(indexRatio) / Math.log(symbolRatio)).toFixed(2)}))`
    );
    console.log(
      `  Resolve time increased ${resolveRatio.toFixed(1)}x (O(n^${(Math.log(resolveRatio) / Math.log(symbolRatio)).toFixed(2)}))`
    );
    console.log("");
  }
}

/**
 * Benchmark file system operations (optional, requires temp directories).
 */
async function runFileSystemBenchmarks(): Promise<void> {
  console.log("=".repeat(70));
  console.log("FILE SYSTEM BENCHMARKS");
  console.log("=".repeat(70));
  console.log("");
  console.log("Measuring file reading and workspace discovery...\n");

  const testCases: [string, number, number, number][] = [
    ["Small (10 files)", 10, 3, 5],
    ["Medium (50 files)", 50, 3, 5],
    ["Large (100 files)", 100, 3, 5],
  ];

  const results: BenchmarkResult[] = [];

  for (const [name, fileCount, features, requirements] of testCases) {
    console.log("-".repeat(70));
    console.log(`Test Case: ${name}`);

    // Create test workspace
    const workspace = await createTestWorkspace(fileCount, features, requirements, 2, true);

    try {
      // Benchmark reading all files
      const readResult = await runAsyncBenchmark(
        `Read ${fileCount} files from disk`,
        async () => {
          for (const filePath of workspace.files) {
            await Bun.file(filePath).text();
          }
        },
        20
      );
      results.push(readResult);
      console.log(formatResult(readResult));
      console.log("");

      // Benchmark full pipeline from disk
      const fullResult = await runAsyncBenchmark(
        `Full index ${fileCount} files from disk`,
        async () => {
          const index = new CrossFileSymbolIndex();
          for (const filePath of workspace.files) {
            const content = await Bun.file(filePath).text();
            const tree = parseDocument(content);
            if (tree) {
              const ast = transformToAST(tree);
              const uri = URI.file(filePath).toString();
              index.addFile(uri, ast);
              tree.delete();
            }
          }
        },
        20
      );
      results.push(fullResult);
      console.log(formatResult(fullResult));
      console.log(`  Files/sec: ${((fileCount * 1000) / fullResult.avgMs).toFixed(1)}`);
      console.log("");
    } finally {
      await workspace.cleanup();
    }
  }

  // Summary
  console.log("=".repeat(70));
  console.log("FILE SYSTEM SUMMARY");
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

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("");
  console.log("Blueprint Workspace Indexing Benchmarks");
  console.log("========================================");
  console.log("");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Bun version: ${Bun.version}`);
  console.log("");

  try {
    console.log("Initializing parser...\n");
    await initializeParser();

    await runSymbolIndexingBenchmarks();
    await runReferenceResolutionBenchmarks();
    await runFullPipelineBenchmarks();
    await runScalingBenchmarks();
    await runFileSystemBenchmarks();

    console.log("=".repeat(70));
    console.log("All benchmarks completed successfully!");
    console.log("=".repeat(70));
  } catch (error) {
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

main();
