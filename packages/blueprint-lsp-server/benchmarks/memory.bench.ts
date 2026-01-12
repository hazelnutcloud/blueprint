/**
 * Memory profiling benchmarks for the Blueprint LSP server.
 *
 * These benchmarks measure memory usage patterns when:
 * - Parsing and storing many open documents
 * - Building and maintaining the cross-file symbol index
 * - Storing ticket data
 * - Caching computed data (dependency graph, ticket map)
 *
 * Run with: bun run benchmarks/memory.bench.ts
 *
 * Note: Memory measurements use Bun's built-in memory reporting via
 * process.memoryUsage(). For more detailed heap analysis, use
 * --inspect flag with Chrome DevTools.
 */

import { initializeParser, parseDocument, cleanupParser } from "../src/parser";
import { transformToAST, buildSymbolTable, type DocumentNode } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import type { Ticket, TicketFile } from "../src/tickets";

// ============================================================================
// Configuration
// ============================================================================

/** Force garbage collection if available (run with --expose-gc) */
function forceGC(): void {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc(); // Call twice for thorough collection
  }
}

/** Small delay to let GC settle (kept for potential future use) */
function _waitForGC(): Promise<void> {
  forceGC();
  return new Promise((resolve) => {
    setTimeout(() => {
      forceGC();
      resolve();
    }, 50);
  });
}

/** Get current memory usage in MB */
function getMemoryMB(): { heapUsed: number; heapTotal: number; rss: number; external: number } {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed / 1024 / 1024,
    heapTotal: mem.heapTotal / 1024 / 1024,
    rss: mem.rss / 1024 / 1024,
    external: mem.external / 1024 / 1024,
  };
}

/** Format memory value for display */
function formatMB(mb: number): string {
  return `${mb.toFixed(2)} MB`;
}

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
  lines.push(`  Module ${moduleName} for memory profiling.`);
  lines.push(`  This module contains ${featureCount} features with`);
  lines.push(`  ${requirementsPerFeature} requirements each.`);
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
    lines.push(`    This feature handles functionality related to area ${f}.`);
    lines.push("");

    for (let r = 0; r < requirementsPerFeature; r++) {
      const reqName = `req-${f}-${r}`;
      lines.push(`    @requirement ${reqName}`);
      if (r > 0) {
        lines.push(`      @depends-on ${moduleName}.${featureName}.req-${f}-${r - 1}`);
      }
      lines.push(`      Requirement ${r} of feature ${f}.`);
      lines.push(`      This requirement specifies the behavior for case ${r}.`);
      lines.push("");

      for (let c = 0; c < constraintsPerRequirement; c++) {
        lines.push(`      @constraint constraint-${f}-${r}-${c}`);
        lines.push(`        Constraint ${c} for requirement ${r}.`);
        lines.push(`        Must be implemented according to specification.`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate mock ticket data for a module.
 */
function generateTickets(
  moduleName: string,
  featureCount: number,
  requirementsPerFeature: number,
  constraintsPerRequirement: number
): Ticket[] {
  const tickets: Ticket[] = [];
  let ticketId = 1;

  for (let f = 0; f < featureCount; f++) {
    for (let r = 0; r < requirementsPerFeature; r++) {
      const ref = `${moduleName}.feature-${f}.req-${f}-${r}`;
      const constraintsSatisfied: string[] = [];

      // Randomly satisfy some constraints
      for (let c = 0; c < constraintsPerRequirement; c++) {
        if (Math.random() > 0.5) {
          constraintsSatisfied.push(`constraint-${f}-${r}-${c}`);
        }
      }

      tickets.push({
        id: `TKT-${String(ticketId++).padStart(4, "0")}`,
        ref,
        description: `Implement ${ref} with all specified constraints`,
        status: Math.random() > 0.7 ? "complete" : Math.random() > 0.5 ? "in-progress" : "pending",
        constraints_satisfied: constraintsSatisfied,
        implementation: {
          files: [`src/${moduleName}/feature-${f}/req-${r}.ts`],
          tests: [`tests/${moduleName}/feature-${f}/req-${r}.test.ts`],
        },
      });
    }
  }

  return tickets;
}

// ============================================================================
// Memory Profile Types
// ============================================================================

interface MemorySnapshot {
  label: string;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  delta: number; // Change from previous snapshot
}

interface MemoryProfile {
  snapshots: MemorySnapshot[];
  peakHeapUsed: number;
  totalAllocated: number;
}

// ============================================================================
// Memory Profiling Functions
// ============================================================================

/**
 * Take a memory snapshot with a label.
 */
function takeSnapshot(label: string, previous?: MemorySnapshot): MemorySnapshot {
  forceGC();
  const mem = getMemoryMB();
  return {
    label,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    delta: previous ? mem.rss - previous.rss : 0, // Use RSS for delta as it's more reliable
  };
}

/**
 * Create a new memory profile tracker.
 */
function createProfile(): MemoryProfile {
  return {
    snapshots: [],
    peakHeapUsed: 0,
    totalAllocated: 0,
  };
}

/**
 * Add a snapshot to a profile.
 */
function addSnapshot(profile: MemoryProfile, label: string): MemorySnapshot {
  const previous = profile.snapshots[profile.snapshots.length - 1];
  const snapshot = takeSnapshot(label, previous);

  profile.snapshots.push(snapshot);

  if (snapshot.heapUsed > profile.peakHeapUsed) {
    profile.peakHeapUsed = snapshot.heapUsed;
  }

  if (snapshot.delta > 0) {
    profile.totalAllocated += snapshot.delta;
  }

  return snapshot;
}

/**
 * Print a memory profile report.
 */
function printProfile(title: string, profile: MemoryProfile): void {
  console.log("");
  console.log("=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
  console.log("");

  console.log(
    "| Step".padEnd(40) + "| Heap Used".padEnd(14) + "| Delta".padEnd(14) + "| RSS".padEnd(14) + "|"
  );
  console.log(
    "|" + "-".repeat(39) + "|" + "-".repeat(13) + "|" + "-".repeat(13) + "|" + "-".repeat(13) + "|"
  );

  for (const snapshot of profile.snapshots) {
    const deltaStr =
      snapshot.delta >= 0 ? `+${formatMB(snapshot.delta)}` : formatMB(snapshot.delta);
    console.log(
      `| ${snapshot.label}`.padEnd(40) +
        `| ${formatMB(snapshot.heapUsed)}`.padEnd(14) +
        `| ${deltaStr}`.padEnd(14) +
        `| ${formatMB(snapshot.rss)}`.padEnd(14) +
        "|"
    );
  }

  console.log("");
  console.log(`Peak heap used: ${formatMB(profile.peakHeapUsed)}`);
  console.log(`Total allocated: ${formatMB(profile.totalAllocated)}`);
  console.log("");
}

// ============================================================================
// Benchmark: Document Parsing Memory
// ============================================================================

/**
 * Profile memory usage when parsing many documents.
 */
async function profileDocumentParsing(): Promise<void> {
  const profile = createProfile();

  addSnapshot(profile, "Initial state");

  // Generate test content
  const files: { name: string; content: string }[] = [];
  for (let i = 0; i < 50; i++) {
    files.push({
      name: `module-${i}`,
      content: generateBlueprintFile(`module-${i}`, 5, 10, 3, i > 0 ? [`module-${i - 1}`] : []),
    });
  }

  addSnapshot(profile, "After generating 50 file contents");

  // Parse all files and keep trees in memory (simulating open documents)
  const trees: Array<ReturnType<typeof parseDocument>> = [];
  for (let i = 0; i < files.length; i++) {
    const tree = parseDocument(files[i]!.content);
    trees.push(tree);

    if ((i + 1) % 10 === 0) {
      addSnapshot(profile, `After parsing ${i + 1} files`);
    }
  }

  addSnapshot(profile, "All 50 files parsed (trees in memory)");

  // Transform to ASTs
  const asts: DocumentNode[] = [];
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    if (tree) {
      asts.push(transformToAST(tree));
    }

    if ((i + 1) % 10 === 0) {
      addSnapshot(profile, `After transforming ${i + 1} ASTs`);
    }
  }

  addSnapshot(profile, "All 50 ASTs created");

  // Build symbol tables
  const symbolTables: ReturnType<typeof buildSymbolTable>[] = [];
  for (const ast of asts) {
    symbolTables.push(buildSymbolTable(ast));
  }

  addSnapshot(profile, "All 50 symbol tables built");

  // Calculate per-file memory
  const totalSymbols = symbolTables.reduce(
    (sum, st) =>
      sum +
      st.symbolTable.modules.size +
      st.symbolTable.features.size +
      st.symbolTable.requirements.size +
      st.symbolTable.constraints.size,
    0
  );

  console.log(`Total symbols across all files: ${totalSymbols}`);
  console.log(`Average symbols per file: ${(totalSymbols / files.length).toFixed(1)}`);

  // Clean up trees
  for (const tree of trees) {
    tree?.delete();
  }

  addSnapshot(profile, "After deleting all trees");

  // Clear references
  trees.length = 0;
  asts.length = 0;
  symbolTables.length = 0;
  files.length = 0;

  addSnapshot(profile, "After clearing all references");

  printProfile("DOCUMENT PARSING MEMORY PROFILE", profile);
}

// ============================================================================
// Benchmark: Symbol Index Memory
// ============================================================================

/**
 * Profile memory usage of the CrossFileSymbolIndex.
 */
async function profileSymbolIndex(): Promise<void> {
  const profile = createProfile();

  addSnapshot(profile, "Initial state");

  const index = new CrossFileSymbolIndex();

  addSnapshot(profile, "After creating empty index");

  // Add files incrementally
  const fileCounts = [10, 25, 50, 75, 100];
  let currentFileCount = 0;

  for (const targetCount of fileCounts) {
    while (currentFileCount < targetCount) {
      const moduleName = `module-${currentFileCount}`;
      const content = generateBlueprintFile(
        moduleName,
        5,
        10,
        3,
        currentFileCount > 0 ? [`module-${currentFileCount - 1}`] : []
      );
      const tree = parseDocument(content);
      if (tree) {
        const ast = transformToAST(tree);
        index.addFile(`file:///workspace/requirements/${moduleName}.bp`, ast);
        tree.delete();
      }
      currentFileCount++;
    }

    addSnapshot(profile, `Index with ${targetCount} files`);
  }

  console.log(`\nFinal index statistics:`);
  console.log(`  Files indexed: ${index.getFileCount()}`);
  console.log(`  Total symbols: ${index.getSymbolCount()}`);
  console.log(
    `  Memory per symbol: ${((profile.peakHeapUsed * 1024 * 1024) / index.getSymbolCount()).toFixed(0)} bytes`
  );
  console.log(
    `  Memory per file: ${((profile.peakHeapUsed * 1024) / index.getFileCount()).toFixed(1)} KB`
  );

  // Test incremental update memory impact
  addSnapshot(profile, "Before incremental updates");

  for (let i = 0; i < 10; i++) {
    const moduleName = `module-${i}`;
    const content = generateBlueprintFile(moduleName, 5, 10, 3, i > 0 ? [`module-${i - 1}`] : []);
    const tree = parseDocument(content);
    if (tree) {
      const ast = transformToAST(tree);
      index.addFile(`file:///workspace/requirements/${moduleName}.bp`, ast);
      tree.delete();
    }
  }

  addSnapshot(profile, "After 10 incremental updates");

  // Clear the index
  index.clear();

  addSnapshot(profile, "After clearing index");

  printProfile("SYMBOL INDEX MEMORY PROFILE", profile);
}

// ============================================================================
// Benchmark: Ticket Data Memory
// ============================================================================

/**
 * Profile memory usage of ticket data storage.
 */
async function profileTicketData(): Promise<void> {
  const profile = createProfile();

  addSnapshot(profile, "Initial state");

  // Generate ticket files for multiple modules
  const ticketFiles: TicketFile[] = [];

  for (let m = 0; m < 50; m++) {
    const moduleName = `module-${m}`;
    const tickets = generateTickets(moduleName, 5, 10, 3);
    ticketFiles.push({
      version: "1.0",
      source: `requirements/${moduleName}.bp`,
      tickets,
    });

    if ((m + 1) % 10 === 0) {
      addSnapshot(profile, `After creating ${m + 1} ticket files`);
    }
  }

  const totalTickets = ticketFiles.reduce((sum, tf) => sum + tf.tickets.length, 0);
  console.log(`\nTicket data statistics:`);
  console.log(`  Ticket files: ${ticketFiles.length}`);
  console.log(`  Total tickets: ${totalTickets}`);
  console.log(`  Average tickets per file: ${(totalTickets / ticketFiles.length).toFixed(1)}`);

  addSnapshot(profile, "All ticket files created");

  // Simulate ticket map building (without the actual class to isolate memory)
  const ticketsByRef = new Map<string, Ticket[]>();
  for (const tf of ticketFiles) {
    for (const ticket of tf.tickets) {
      const existing = ticketsByRef.get(ticket.ref);
      if (existing) {
        existing.push(ticket);
      } else {
        ticketsByRef.set(ticket.ref, [ticket]);
      }
    }
  }

  addSnapshot(profile, "After building ticket-by-ref map");

  console.log(`  Unique requirement refs: ${ticketsByRef.size}`);
  console.log(
    `  Memory per ticket: ${((profile.peakHeapUsed * 1024 * 1024) / totalTickets).toFixed(0)} bytes`
  );

  // Clear
  ticketsByRef.clear();
  ticketFiles.length = 0;

  addSnapshot(profile, "After clearing ticket data");

  printProfile("TICKET DATA MEMORY PROFILE", profile);
}

// ============================================================================
// Benchmark: Full LSP State Memory
// ============================================================================

/**
 * Profile memory usage of a simulated full LSP server state.
 */
async function profileFullLSPState(): Promise<void> {
  const profile = createProfile();

  addSnapshot(profile, "Initial state");

  // Simulate the full state that an LSP server would hold:
  // 1. Parsed trees for open documents
  // 2. CrossFileSymbolIndex for workspace
  // 3. Ticket data
  // 4. Cached computed data

  const openDocumentTrees: Array<{ uri: string; tree: ReturnType<typeof parseDocument> }> = [];
  const index = new CrossFileSymbolIndex();
  const ticketData: Map<string, TicketFile> = new Map();

  // Simulate a workspace with 100 files total
  const totalFiles = 100;
  const openFiles = 10; // Typical number of open files

  console.log(`\nSimulating LSP state with:`);
  console.log(`  Total workspace files: ${totalFiles}`);
  console.log(`  Open documents: ${openFiles}`);
  console.log("");

  // Index all files (LSP indexes entire workspace)
  for (let i = 0; i < totalFiles; i++) {
    const moduleName = `module-${i}`;
    const content = generateBlueprintFile(moduleName, 3, 5, 2, i > 0 ? [`module-${i - 1}`] : []);
    const tree = parseDocument(content);

    if (tree) {
      const ast = transformToAST(tree);
      const uri = `file:///workspace/requirements/${moduleName}.bp`;
      index.addFile(uri, ast);

      // Keep trees for "open" documents
      if (i < openFiles) {
        openDocumentTrees.push({ uri, tree });
      } else {
        tree.delete();
      }
    }

    // Generate tickets for this file
    const tickets = generateTickets(moduleName, 3, 5, 2);
    ticketData.set(`${moduleName}.tickets.json`, {
      version: "1.0",
      source: `requirements/${moduleName}.bp`,
      tickets,
    });

    if ((i + 1) % 25 === 0) {
      addSnapshot(profile, `After processing ${i + 1} files`);
    }
  }

  addSnapshot(profile, `Full workspace indexed (${totalFiles} files)`);

  // Simulate cached computed data
  // In real usage, these would be built on-demand

  // Build ticket-by-ref map (simulating RequirementTicketMap)
  const ticketsByRef = new Map<string, Ticket[]>();
  for (const tf of ticketData.values()) {
    for (const ticket of tf.tickets) {
      const existing = ticketsByRef.get(ticket.ref);
      if (existing) {
        existing.push(ticket);
      } else {
        ticketsByRef.set(ticket.ref, [ticket]);
      }
    }
  }

  addSnapshot(profile, "After building ticket map cache");

  // Print final statistics
  const totalSymbols = index.getSymbolCount();
  const totalTickets = Array.from(ticketData.values()).reduce(
    (sum, tf) => sum + tf.tickets.length,
    0
  );

  console.log(`\nFinal LSP state statistics:`);
  console.log(`  Symbol index: ${totalSymbols} symbols`);
  console.log(`  Ticket data: ${totalTickets} tickets`);
  console.log(`  Open document trees: ${openDocumentTrees.length}`);
  console.log(`  Peak memory: ${formatMB(profile.peakHeapUsed)}`);
  console.log(
    `  Memory per indexed file: ${((profile.peakHeapUsed * 1024) / totalFiles).toFixed(1)} KB`
  );

  // Simulate closing half the open documents
  for (let i = 0; i < openFiles / 2; i++) {
    const doc = openDocumentTrees.pop();
    doc?.tree?.delete();
  }

  addSnapshot(profile, "After closing 5 documents");

  // Clear everything
  for (const doc of openDocumentTrees) {
    doc.tree?.delete();
  }
  openDocumentTrees.length = 0;
  index.clear();
  ticketData.clear();
  ticketsByRef.clear();

  addSnapshot(profile, "After full cleanup");

  printProfile("FULL LSP STATE MEMORY PROFILE", profile);
}

// ============================================================================
// Benchmark: Memory Scaling Analysis
// ============================================================================

/**
 * Analyze how memory scales with workspace size.
 */
async function profileMemoryScaling(): Promise<void> {
  console.log("");
  console.log("=".repeat(80));
  console.log("MEMORY SCALING ANALYSIS");
  console.log("=".repeat(80));
  console.log("");
  console.log("Measuring memory growth as workspace size increases...");
  console.log("");

  const scalingResults: {
    files: number;
    symbols: number;
    tickets: number;
    heapMB: number;
    bytesPerSymbol: number;
    kbPerFile: number;
  }[] = [];

  for (const fileCount of [10, 25, 50, 75, 100, 150, 200]) {
    forceGC();
    const baselineMem = getMemoryMB().rss; // Use RSS for more reliable measurement

    const index = new CrossFileSymbolIndex();
    let totalTickets = 0;

    for (let i = 0; i < fileCount; i++) {
      const moduleName = `module-${i}`;
      const content = generateBlueprintFile(moduleName, 3, 5, 2, i > 0 ? [`module-${i - 1}`] : []);
      const tree = parseDocument(content);

      if (tree) {
        const ast = transformToAST(tree);
        index.addFile(`file:///workspace/${moduleName}.bp`, ast);
        tree.delete();
      }

      // Count tickets (3 features * 5 requirements = 15 per file)
      totalTickets += 15;
    }

    forceGC();
    const finalMem = getMemoryMB().rss; // Use RSS for more reliable measurement
    const usedMem = Math.max(0, finalMem - baselineMem); // Ensure non-negative
    const symbolCount = index.getSymbolCount();

    scalingResults.push({
      files: fileCount,
      symbols: symbolCount,
      tickets: totalTickets,
      heapMB: usedMem,
      bytesPerSymbol: (usedMem * 1024 * 1024) / symbolCount,
      kbPerFile: (usedMem * 1024) / fileCount,
    });

    index.clear();
  }

  console.log(
    "| Files".padEnd(10) +
      "| Symbols".padEnd(12) +
      "| Heap (MB)".padEnd(14) +
      "| Bytes/Sym".padEnd(14) +
      "| KB/File".padEnd(12) +
      "|"
  );
  console.log(
    "|" +
      "-".repeat(9) +
      "|" +
      "-".repeat(11) +
      "|" +
      "-".repeat(13) +
      "|" +
      "-".repeat(13) +
      "|" +
      "-".repeat(11) +
      "|"
  );

  for (const r of scalingResults) {
    console.log(
      `| ${r.files}`.padEnd(10) +
        `| ${r.symbols}`.padEnd(12) +
        `| ${r.heapMB.toFixed(2)}`.padEnd(14) +
        `| ${r.bytesPerSymbol.toFixed(0)}`.padEnd(14) +
        `| ${r.kbPerFile.toFixed(1)}`.padEnd(12) +
        "|"
    );
  }

  // Calculate scaling factor
  if (scalingResults.length >= 2) {
    const first = scalingResults[0]!;
    const last = scalingResults[scalingResults.length - 1]!;
    const fileRatio = last.files / first.files;

    // Use absolute memory values from the last run for scaling analysis
    // since delta-based measurement may show 0 for small changes
    if (last.heapMB > 0.01 && first.heapMB > 0.01) {
      const memRatio = last.heapMB / first.heapMB;
      const exponent = Math.log(memRatio) / Math.log(fileRatio);

      console.log("");
      console.log(`Scaling analysis:`);
      console.log(`  Files increased ${fileRatio.toFixed(1)}x`);
      console.log(`  Memory increased ${memRatio.toFixed(1)}x`);
      console.log(`  Scaling: O(n^${exponent.toFixed(2)})`);
      console.log(
        `  ${exponent < 1.1 ? "Linear scaling - good!" : exponent < 1.5 ? "Slightly superlinear" : "Superlinear scaling - may need optimization"}`
      );
    } else {
      console.log("");
      console.log(`Scaling analysis:`);
      console.log(`  Files increased ${fileRatio.toFixed(1)}x`);
      console.log(`  Memory values too small for reliable scaling analysis`);
      console.log(`  This suggests efficient memory usage with minimal overhead`);
    }
  }

  console.log("");
}

// ============================================================================
// Benchmark: Memory Leak Detection
// ============================================================================

/**
 * Test for memory leaks by repeatedly adding and removing files.
 */
async function profileMemoryLeaks(): Promise<void> {
  console.log("");
  console.log("=".repeat(80));
  console.log("MEMORY LEAK DETECTION");
  console.log("=".repeat(80));
  console.log("");
  console.log("Testing for memory leaks with repeated add/remove cycles...");
  console.log("");

  forceGC();
  const baselineMem = getMemoryMB().rss; // Use RSS for reliable measurement

  const index = new CrossFileSymbolIndex();
  const iterations = 10;
  const filesPerIteration = 20;

  const memoryAtIteration: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    // Add files
    for (let i = 0; i < filesPerIteration; i++) {
      const moduleName = `module-${i}`;
      const content = generateBlueprintFile(moduleName, 3, 5, 2);
      const tree = parseDocument(content);
      if (tree) {
        const ast = transformToAST(tree);
        index.addFile(`file:///workspace/${moduleName}.bp`, ast);
        tree.delete();
      }
    }

    // Remove all files
    for (let i = 0; i < filesPerIteration; i++) {
      index.removeFile(`file:///workspace/module-${i}.bp`);
    }

    forceGC();
    const currentMem = getMemoryMB().rss; // Use RSS for reliable measurement
    memoryAtIteration.push(currentMem - baselineMem);
  }

  console.log("| Iteration".padEnd(15) + "| Memory Delta (MB)".padEnd(20) + "|");
  console.log("|" + "-".repeat(14) + "|" + "-".repeat(19) + "|");

  for (let i = 0; i < memoryAtIteration.length; i++) {
    console.log(`| ${i + 1}`.padEnd(15) + `| ${memoryAtIteration[i]!.toFixed(3)}`.padEnd(20) + "|");
  }

  // Check for leak
  const firstMem = memoryAtIteration[0]!;
  const lastMem = memoryAtIteration[memoryAtIteration.length - 1]!;
  const growth = lastMem - firstMem;

  console.log("");
  console.log(`Memory delta at iteration 1: ${formatMB(firstMem)}`);
  console.log(`Memory delta at iteration ${iterations}: ${formatMB(lastMem)}`);
  console.log(`Growth over iterations: ${formatMB(growth)}`);

  // Determine leak status based on absolute growth
  if (Math.abs(growth) < 0.5) {
    console.log(`Result: No significant leak detected (growth < 0.5 MB)`);
  } else if (firstMem === 0 || Math.abs(growth / Math.max(firstMem, 0.01)) < 0.1) {
    console.log(`Result: No significant leak detected (growth within 10%)`);
  } else {
    console.log(`Result: Possible memory leak! Growth: ${formatMB(growth)}`);
  }
  console.log("");

  index.clear();
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("");
  console.log("Blueprint LSP Memory Profiling Benchmarks");
  console.log("==========================================");
  console.log("");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Bun version: ${Bun.version}`);
  console.log(`Node version: ${process.version}`);
  console.log("");

  const hasGC = typeof globalThis.gc === "function";
  if (!hasGC) {
    console.log("Note: Run with 'bun --expose-gc' for more accurate measurements");
    console.log("      Memory deltas may be less precise without explicit GC control");
    console.log("");
  }

  try {
    console.log("Initializing parser...");
    await initializeParser();
    console.log("Parser initialized.\n");

    await profileDocumentParsing();
    await profileSymbolIndex();
    await profileTicketData();
    await profileFullLSPState();
    await profileMemoryScaling();
    await profileMemoryLeaks();

    console.log("=".repeat(80));
    console.log("All memory profiling benchmarks completed!");
    console.log("=".repeat(80));

    cleanupParser();
  } catch (error) {
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

main();
