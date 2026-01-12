import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ComputedDataCache } from "./computed-data-cache";
import { CrossFileSymbolIndex } from "./symbol-index";
import { TicketDocumentManager } from "./ticket-documents";
import type { Connection } from "vscode-languageserver/node";
import { transformToAST } from "./ast";
import { parseDocument, initializeParser, cleanupParser } from "./parser";

// Mock connection for TicketDocumentManager
function createMockConnection(): Connection {
  return {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    sendDiagnostics: () => {},
  } as unknown as Connection;
}

// Helper to create a parsed AST from Blueprint content
async function createAST(content: string) {
  const tree = parseDocument(content);
  if (!tree) throw new Error("Failed to parse content");
  const ast = transformToAST(tree);
  tree.delete();
  return ast;
}

describe("ComputedDataCache", () => {
  let symbolIndex: CrossFileSymbolIndex;
  let ticketDocumentManager: TicketDocumentManager;
  let cache: ComputedDataCache;

  beforeEach(async () => {
    await initializeParser();
    symbolIndex = new CrossFileSymbolIndex();
    ticketDocumentManager = new TicketDocumentManager(createMockConnection());
    cache = new ComputedDataCache(symbolIndex, ticketDocumentManager);
  });

  describe("dependency graph caching", () => {
    test("computes dependency graph on first call", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      expect(cache.isDependencyGraphCached()).toBe(false);

      const result = cache.getDependencyGraph();

      expect(cache.isDependencyGraphCached()).toBe(true);
      expect(result.graph).toBeDefined();
      expect(result.isAcyclic).toBe(true);
    });

    test("returns cached dependency graph on subsequent calls", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      const result1 = cache.getDependencyGraph();
      const result2 = cache.getDependencyGraph();

      // Should be the exact same object (cached)
      expect(result1).toBe(result2);
    });

    test("invalidateDependencyGraph clears the cache", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      cache.getDependencyGraph();
      expect(cache.isDependencyGraphCached()).toBe(true);

      cache.invalidateDependencyGraph();

      expect(cache.isDependencyGraphCached()).toBe(false);
    });

    test("invalidateDependencyGraph also invalidates ticket map", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      cache.getTicketMap();
      expect(cache.isTicketMapCached()).toBe(true);

      cache.invalidateDependencyGraph();

      expect(cache.isTicketMapCached()).toBe(false);
    });

    test("increments symbol index version on invalidation", () => {
      expect(cache.getSymbolIndexVersion()).toBe(0);

      cache.invalidateDependencyGraph();
      expect(cache.getSymbolIndexVersion()).toBe(1);

      cache.invalidateDependencyGraph();
      expect(cache.getSymbolIndexVersion()).toBe(2);
    });
  });

  describe("ticket map caching", () => {
    test("computes ticket map on first call", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      expect(cache.isTicketMapCached()).toBe(false);

      const result = cache.getTicketMap();

      expect(cache.isTicketMapCached()).toBe(true);
      expect(result.map).toBeDefined();
    });

    test("returns cached ticket map on subsequent calls", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      const result1 = cache.getTicketMap();
      const result2 = cache.getTicketMap();

      // Should be the exact same object (cached)
      expect(result1).toBe(result2);
    });

    test("invalidateTicketMap clears the cache", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      cache.getTicketMap();
      expect(cache.isTicketMapCached()).toBe(true);

      cache.invalidateTicketMap();

      expect(cache.isTicketMapCached()).toBe(false);
    });

    test("invalidateTicketMap does not affect dependency graph cache", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      cache.getDependencyGraph();
      expect(cache.isDependencyGraphCached()).toBe(true);

      cache.invalidateTicketMap();

      expect(cache.isDependencyGraphCached()).toBe(true);
    });

    test("increments tickets version on invalidation", () => {
      expect(cache.getTicketsVersion()).toBe(0);

      cache.invalidateTicketMap();
      expect(cache.getTicketsVersion()).toBe(1);

      cache.invalidateTicketMap();
      expect(cache.getTicketsVersion()).toBe(2);
    });

    test("includes tickets from ticket document manager", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      // Add a ticket
      const ticketContent = JSON.stringify({
        version: "1.0",
        source: "test.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement login",
            status: "complete",
            constraints_satisfied: [],
          },
        ],
      });
      ticketDocumentManager.onDocumentOpen("file:///test.tickets.json", 1, ticketContent);

      const result = cache.getTicketMap();

      const info = result.map.get("auth.login.basic-auth");
      expect(info).toBeDefined();
      expect(info?.tickets.length).toBe(1);
      expect(info?.status).toBe("complete");
    });
  });

  describe("invalidateAll", () => {
    test("clears both caches", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      cache.getDependencyGraph();
      cache.getTicketMap();
      expect(cache.isDependencyGraphCached()).toBe(true);
      expect(cache.isTicketMapCached()).toBe(true);

      cache.invalidateAll();

      expect(cache.isDependencyGraphCached()).toBe(false);
      expect(cache.isTicketMapCached()).toBe(false);
    });

    test("increments both versions", () => {
      const initialSymbolVersion = cache.getSymbolIndexVersion();
      const initialTicketsVersion = cache.getTicketsVersion();

      cache.invalidateAll();

      expect(cache.getSymbolIndexVersion()).toBe(initialSymbolVersion + 1);
      expect(cache.getTicketsVersion()).toBe(initialTicketsVersion + 1);
    });
  });

  describe("cleanup", () => {
    test("clears all caches and resets versions", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      // Build caches and increment versions
      cache.getDependencyGraph();
      cache.getTicketMap();
      cache.invalidateDependencyGraph();
      cache.invalidateTicketMap();

      expect(cache.getSymbolIndexVersion()).toBeGreaterThan(0);
      expect(cache.getTicketsVersion()).toBeGreaterThan(0);

      cache.cleanup();

      expect(cache.isDependencyGraphCached()).toBe(false);
      expect(cache.isTicketMapCached()).toBe(false);
      expect(cache.getSymbolIndexVersion()).toBe(0);
      expect(cache.getTicketsVersion()).toBe(0);
    });
  });

  describe("cache behavior with dependencies", () => {
    test("detects cycles in cached dependency graph", async () => {
      const ast = await createAST(`
        @module auth
        @feature login
          @depends-on auth.session
        @requirement req1
          First requirement
          
        @feature session
          @depends-on auth.login
        @requirement req2
          Second requirement
      `);
      symbolIndex.addFile("file:///test.bp", ast);

      const result = cache.getDependencyGraph();

      expect(result.isAcyclic).toBe(false);
      expect(result.cycles.length).toBeGreaterThan(0);
    });

    test("cached graph reflects current symbol index state", async () => {
      // Initial state with no dependencies
      const ast1 = await createAST(`
        @module auth
        @feature login
        @requirement basic-auth
          User login
      `);
      symbolIndex.addFile("file:///test.bp", ast1);

      const result1 = cache.getDependencyGraph();
      expect(result1.edges.length).toBe(0);

      // Update with a dependency
      cache.invalidateDependencyGraph();
      const ast2 = await createAST(`
        @module auth
        @feature login
          @depends-on auth.session
        @requirement basic-auth
          User login
          
        @feature session
        @requirement session-req
          Session requirement
      `);
      symbolIndex.addFile("file:///test.bp", ast2);

      const result2 = cache.getDependencyGraph();
      expect(result2.edges.length).toBeGreaterThan(0);
    });
  });
});
