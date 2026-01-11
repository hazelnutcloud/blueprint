import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import { DependencyGraph, type CircularDependency } from "../src/dependency-graph";
import {
  buildRequirementTicketMap,
  type RequirementTicketMap,
} from "../src/requirement-ticket-map";
import type { RequirementNode, ConstraintNode, SourceLocation } from "../src/ast";
import type { Ticket, TicketFile } from "../src/tickets";
import {
  isCompleteStatus,
  isNonBlockingStatus,
  computeBlockingInfo,
  computeAllBlockingStatus,
  propagateBlockingToHierarchy,
  getUnblockedIfCompleted,
  createBlockingStatusCache,
  invalidateBlockingStatusCache,
  updateBlockingStatusCache,
  shouldInvalidateCache,
  type BlockingInfo,
  type BlockingStatus,
  type BlockingStatusResult,
} from "../src/blocking-status";

// ============================================================================
// Test Helpers
// ============================================================================

const dummyLocation: SourceLocation = {
  startLine: 0,
  startColumn: 0,
  endLine: 0,
  endColumn: 0,
  startOffset: 0,
  endOffset: 0,
};

function createConstraint(name: string): ConstraintNode {
  return {
    type: "constraint",
    name,
    description: `Constraint ${name}`,
    location: dummyLocation,
  };
}

function createRequirement(
  name: string,
  constraints: string[] = []
): RequirementNode {
  return {
    type: "requirement",
    name,
    description: `Requirement ${name}`,
    dependencies: [],
    constraints: constraints.map(createConstraint),
    location: dummyLocation,
  };
}

function createTicket(
  id: string,
  ref: string,
  status: Ticket["status"],
  constraintsSatisfied: string[] = []
): Ticket {
  return {
    id,
    ref,
    description: `Ticket ${id}`,
    status,
    constraints_satisfied: constraintsSatisfied,
  };
}

function createTicketFile(source: string, tickets: Ticket[]): TicketFile {
  return {
    version: "1.0",
    source,
    tickets,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("blocking-status", () => {
  describe("isCompleteStatus", () => {
    test("returns true for complete status", () => {
      expect(isCompleteStatus("complete")).toBe(true);
    });

    test("returns false for other statuses", () => {
      expect(isCompleteStatus("pending")).toBe(false);
      expect(isCompleteStatus("in-progress")).toBe(false);
      expect(isCompleteStatus("no-ticket")).toBe(false);
      expect(isCompleteStatus("obsolete")).toBe(false);
    });
  });

  describe("isNonBlockingStatus", () => {
    test("returns true for complete status", () => {
      expect(isNonBlockingStatus("complete")).toBe(true);
    });

    test("returns true for obsolete status", () => {
      expect(isNonBlockingStatus("obsolete")).toBe(true);
    });

    test("returns false for blocking statuses", () => {
      expect(isNonBlockingStatus("pending")).toBe(false);
      expect(isNonBlockingStatus("in-progress")).toBe(false);
      expect(isNonBlockingStatus("no-ticket")).toBe(false);
    });
  });

  describe("computeBlockingInfo", () => {
    let index: CrossFileSymbolIndex;

    beforeAll(async () => {
      await initializeParser();
    });

    beforeEach(() => {
      index = new CrossFileSymbolIndex();
    });

    function parseToAST(code: string) {
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      return transformToAST(tree!);
    }

    test("returns not-blocked when no dependencies", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic-auth", createRequirement("basic-auth")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic-auth", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.basic-auth",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("not-blocked");
      expect(info.directBlockers).toHaveLength(0);
      expect(info.transitiveBlockers).toHaveLength(0);
    });

    test("returns blocked when direct dependency is not complete", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth

@requirement oauth
  @depends-on auth.login.basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic-auth", createRequirement("basic-auth")],
        ["auth.login.oauth", createRequirement("oauth")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic-auth", "pending"),
        createTicket("TKT-002", "auth.login.oauth", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.oauth",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("blocked");
      expect(info.directBlockers).toHaveLength(1);
      expect(info.directBlockers[0]?.path).toBe("auth.login.basic-auth");
      expect(info.directBlockers[0]?.status).toBe("pending");
    });

    test("returns not-blocked when direct dependency is complete", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth

@requirement oauth
  @depends-on auth.login.basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic-auth", createRequirement("basic-auth")],
        ["auth.login.oauth", createRequirement("oauth")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic-auth", "complete"),
        createTicket("TKT-002", "auth.login.oauth", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.oauth",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("not-blocked");
      expect(info.directBlockers).toHaveLength(0);
    });

    test("returns blocked when transitive dependency is not complete", () => {
      const code = `
@module auth

@feature login

@requirement a

@requirement b
  @depends-on auth.login.a

@requirement c
  @depends-on auth.login.b
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.a", createRequirement("a")],
        ["auth.login.b", createRequirement("b")],
        ["auth.login.c", createRequirement("c")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.a", "pending"), // Not complete
        createTicket("TKT-002", "auth.login.b", "complete"),
        createTicket("TKT-003", "auth.login.c", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.c",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("blocked");
      // b is direct, a is transitive
      expect(info.directBlockers).toHaveLength(0); // b is complete
      expect(info.transitiveBlockers).toHaveLength(1);
      expect(info.transitiveBlockers[0]?.path).toBe("auth.login.a");
    });

    test("returns in-cycle when part of circular dependency", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>();
      const mapResult = buildRequirementTicketMap(requirements, null);

      // Even though 'a' is a module, not a requirement, we can still check blocking
      const info = computeBlockingInfo(
        "a",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("in-cycle");
      expect(info.cycleInfo).toBeDefined();
      expect(info.cycleInfo?.cyclePeers).toContain("b");
    });

    test("treats no-ticket as blocking", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth

@requirement oauth
  @depends-on auth.login.basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic-auth", createRequirement("basic-auth")],
        ["auth.login.oauth", createRequirement("oauth")],
      ]);
      // No ticket for basic-auth!
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-002", "auth.login.oauth", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.oauth",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("blocked");
      expect(info.directBlockers).toHaveLength(1);
      expect(info.directBlockers[0]?.status).toBe("no-ticket");
    });

    test("treats obsolete as non-blocking", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth

@requirement oauth
  @depends-on auth.login.basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.basic-auth", createRequirement("basic-auth")],
        ["auth.login.oauth", createRequirement("oauth")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.basic-auth", "obsolete"),
        createTicket("TKT-002", "auth.login.oauth", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.oauth",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("not-blocked");
    });

    test("handles multiple direct blockers", () => {
      const storageCode = `
@module storage

@feature db

@requirement user-table

@requirement session-table
`;
      const authCode = `
@module auth

@feature login

@requirement basic-auth
  @depends-on storage.db.user-table, storage.db.session-table
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["storage.db.user-table", createRequirement("user-table")],
        ["storage.db.session-table", createRequirement("session-table")],
        ["auth.login.basic-auth", createRequirement("basic-auth")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "storage.db.user-table", "in-progress"),
        createTicket("TKT-002", "storage.db.session-table", "pending"),
        createTicket("TKT-003", "auth.login.basic-auth", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const info = computeBlockingInfo(
        "auth.login.basic-auth",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(info.status).toBe("blocked");
      expect(info.directBlockers).toHaveLength(2);
      const blockerPaths = info.directBlockers.map((b) => b.path);
      expect(blockerPaths).toContain("storage.db.user-table");
      expect(blockerPaths).toContain("storage.db.session-table");
    });

    // Helper to get a DependencyGraph instance with the getDependencies method
    function rebuildGraph(index: CrossFileSymbolIndex): DependencyGraph {
      // DependencyGraph.build returns a result, but we need the instance
      // The class exposes static build() but we can create instance for testing
      const result = DependencyGraph.build(index);
      // Create a mock graph that uses the result
      const mockGraph = {
        getDependencies: (path: string) =>
          result.edges.filter((e) => e.from === path).map((e) => e.to),
        getDependents: (path: string) =>
          result.edges.filter((e) => e.to === path).map((e) => e.from),
        getTransitiveDependencies: (path: string) => {
          const visited = new Set<string>();
          const stack = [path];
          while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            if (current !== path) visited.add(current);
            const deps = result.edges
              .filter((e) => e.from === current)
              .map((e) => e.to);
            stack.push(...deps);
          }
          return visited;
        },
        getTransitiveDependents: (path: string) => {
          const visited = new Set<string>();
          const stack = [path];
          while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            if (current !== path) visited.add(current);
            const deps = result.edges
              .filter((e) => e.to === current)
              .map((e) => e.from);
            stack.push(...deps);
          }
          return visited;
        },
      } as DependencyGraph;
      return mockGraph;
    }
  });

  describe("computeAllBlockingStatus", () => {
    let index: CrossFileSymbolIndex;

    beforeAll(async () => {
      await initializeParser();
    });

    beforeEach(() => {
      index = new CrossFileSymbolIndex();
    });

    function parseToAST(code: string) {
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      return transformToAST(tree!);
    }

    function rebuildGraph(index: CrossFileSymbolIndex): DependencyGraph {
      const result = DependencyGraph.build(index);
      const mockGraph = {
        getDependencies: (path: string) =>
          result.edges.filter((e) => e.from === path).map((e) => e.to),
        getDependents: (path: string) =>
          result.edges.filter((e) => e.to === path).map((e) => e.from),
        getTransitiveDependencies: (path: string) => {
          const visited = new Set<string>();
          const stack = [path];
          while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            if (current !== path) visited.add(current);
            const deps = result.edges
              .filter((e) => e.from === current)
              .map((e) => e.to);
            stack.push(...deps);
          }
          return visited;
        },
        getTransitiveDependents: (path: string) => {
          const visited = new Set<string>();
          const stack = [path];
          while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            if (current !== path) visited.add(current);
            const deps = result.edges
              .filter((e) => e.to === current)
              .map((e) => e.from);
            stack.push(...deps);
          }
          return visited;
        },
      } as DependencyGraph;
      return mockGraph;
    }

    test("categorizes all requirements correctly", () => {
      const code = `
@module auth

@feature login

@requirement a

@requirement b
  @depends-on auth.login.a

@requirement c
  @depends-on auth.login.b
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.a", createRequirement("a")],
        ["auth.login.b", createRequirement("b")],
        ["auth.login.c", createRequirement("c")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.a", "complete"),
        createTicket("TKT-002", "auth.login.b", "pending"),
        createTicket("TKT-003", "auth.login.c", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const result = computeAllBlockingStatus(
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(result.unblockedRequirements).toContain("auth.login.a");
      expect(result.unblockedRequirements).toContain("auth.login.b");
      expect(result.blockedRequirements).toContain("auth.login.c"); // blocked by b
    });

    test("handles empty ticket map", () => {
      const result = computeAllBlockingStatus(
        {} as DependencyGraph,
        new Map(),
        []
      );

      expect(result.blockedRequirements).toHaveLength(0);
      expect(result.requirementsInCycles).toHaveLength(0);
      expect(result.unblockedRequirements).toHaveLength(0);
    });
  });

  describe("propagateBlockingToHierarchy", () => {
    test("aggregates blocking status to modules and features", () => {
      // Create a blocking result with mixed statuses
      const blockingInfo = new Map<string, BlockingInfo>([
        [
          "auth.login.basic",
          {
            status: "blocked",
            directBlockers: [{ path: "storage.db.users", status: "pending" }],
            transitiveBlockers: [],
          },
        ],
        [
          "auth.login.oauth",
          {
            status: "not-blocked",
            directBlockers: [],
            transitiveBlockers: [],
          },
        ],
        [
          "auth.logout.session",
          {
            status: "not-blocked",
            directBlockers: [],
            transitiveBlockers: [],
          },
        ],
      ]);

      const ticketMap = new Map<string, any>([
        ["auth.login.basic", {}],
        ["auth.login.oauth", {}],
        ["auth.logout.session", {}],
      ]);

      const result: BlockingStatusResult = {
        blockingInfo,
        blockedRequirements: ["auth.login.basic"],
        requirementsInCycles: [],
        unblockedRequirements: ["auth.login.oauth", "auth.logout.session"],
      };

      const hierarchyStatus = propagateBlockingToHierarchy(result, ticketMap);

      // auth module is blocked because auth.login.basic is blocked
      expect(hierarchyStatus.get("auth")).toBe("blocked");
      // auth.login feature is blocked
      expect(hierarchyStatus.get("auth.login")).toBe("blocked");
      // auth.logout feature is not blocked
      expect(hierarchyStatus.get("auth.logout")).toBe("not-blocked");
    });

    test("in-cycle takes precedence over blocked", () => {
      const blockingInfo = new Map<string, BlockingInfo>([
        [
          "auth.login.basic",
          {
            status: "in-cycle",
            directBlockers: [],
            transitiveBlockers: [],
            cycleInfo: {
              cycle: {
                cycle: ["auth.login.basic", "auth.login.oauth", "auth.login.basic"],
                edges: [],
              },
              cyclePeers: ["auth.login.oauth"],
            },
          },
        ],
        [
          "auth.login.oauth",
          {
            status: "blocked",
            directBlockers: [{ path: "storage.db.users", status: "pending" }],
            transitiveBlockers: [],
          },
        ],
      ]);

      const ticketMap = new Map<string, any>([
        ["auth.login.basic", {}],
        ["auth.login.oauth", {}],
      ]);

      const result: BlockingStatusResult = {
        blockingInfo,
        blockedRequirements: ["auth.login.oauth"],
        requirementsInCycles: ["auth.login.basic"],
        unblockedRequirements: [],
      };

      const hierarchyStatus = propagateBlockingToHierarchy(result, ticketMap);

      // auth.login has both in-cycle and blocked, in-cycle takes precedence
      expect(hierarchyStatus.get("auth.login")).toBe("in-cycle");
    });

    test("returns empty map for empty input", () => {
      const result: BlockingStatusResult = {
        blockingInfo: new Map(),
        blockedRequirements: [],
        requirementsInCycles: [],
        unblockedRequirements: [],
      };

      const hierarchyStatus = propagateBlockingToHierarchy(result, new Map());

      expect(hierarchyStatus.size).toBe(0);
    });
  });

  describe("getUnblockedIfCompleted", () => {
    let index: CrossFileSymbolIndex;

    beforeAll(async () => {
      await initializeParser();
    });

    beforeEach(() => {
      index = new CrossFileSymbolIndex();
    });

    function parseToAST(code: string) {
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      return transformToAST(tree!);
    }

    function rebuildGraph(index: CrossFileSymbolIndex): DependencyGraph {
      const result = DependencyGraph.build(index);
      const mockGraph = {
        getDependencies: (path: string) =>
          result.edges.filter((e) => e.from === path).map((e) => e.to),
        getDependents: (path: string) =>
          result.edges.filter((e) => e.to === path).map((e) => e.from),
        getTransitiveDependencies: (path: string) => {
          const visited = new Set<string>();
          const stack = [path];
          while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            if (current !== path) visited.add(current);
            const deps = result.edges
              .filter((e) => e.from === current)
              .map((e) => e.to);
            stack.push(...deps);
          }
          return visited;
        },
        getTransitiveDependents: (path: string) => {
          const visited = new Set<string>();
          const stack = [path];
          while (stack.length > 0) {
            const current = stack.pop()!;
            if (visited.has(current)) continue;
            if (current !== path) visited.add(current);
            const deps = result.edges
              .filter((e) => e.to === current)
              .map((e) => e.from);
            stack.push(...deps);
          }
          return visited;
        },
      } as DependencyGraph;
      return mockGraph;
    }

    test("returns dependents that would be unblocked", () => {
      const code = `
@module auth

@feature login

@requirement a

@requirement b
  @depends-on auth.login.a

@requirement c
  @depends-on auth.login.a
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.a", createRequirement("a")],
        ["auth.login.b", createRequirement("b")],
        ["auth.login.c", createRequirement("c")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.a", "pending"),
        createTicket("TKT-002", "auth.login.b", "pending"),
        createTicket("TKT-003", "auth.login.c", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const wouldUnblock = getUnblockedIfCompleted(
        "auth.login.a",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(wouldUnblock).toContain("auth.login.b");
      expect(wouldUnblock).toContain("auth.login.c");
    });

    test("returns empty when completing would not unblock anything", () => {
      const code = `
@module auth

@feature login

@requirement a

@requirement b
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const graphResult = DependencyGraph.build(index);
      const graph = rebuildGraph(index);

      const requirements = new Map<string, RequirementNode>([
        ["auth.login.a", createRequirement("a")],
        ["auth.login.b", createRequirement("b")],
      ]);
      const ticketFile = createTicketFile("auth.bp", [
        createTicket("TKT-001", "auth.login.a", "pending"),
        createTicket("TKT-002", "auth.login.b", "pending"),
      ]);
      const mapResult = buildRequirementTicketMap(requirements, ticketFile);

      const wouldUnblock = getUnblockedIfCompleted(
        "auth.login.a",
        graph,
        mapResult.map,
        graphResult.cycles
      );

      expect(wouldUnblock).toHaveLength(0);
    });
  });

  describe("cache functions", () => {
    describe("createBlockingStatusCache", () => {
      test("creates empty cache with version 0", () => {
        const cache = createBlockingStatusCache();

        expect(cache.version).toBe(0);
        expect(cache.result.blockingInfo.size).toBe(0);
        expect(cache.result.blockedRequirements).toHaveLength(0);
        expect(cache.hierarchyStatus.size).toBe(0);
        expect(cache.sourceFiles.size).toBe(0);
      });
    });

    describe("invalidateBlockingStatusCache", () => {
      test("increments version", () => {
        const cache = createBlockingStatusCache();
        expect(cache.version).toBe(0);

        invalidateBlockingStatusCache(cache);
        expect(cache.version).toBe(1);

        invalidateBlockingStatusCache(cache);
        expect(cache.version).toBe(2);
      });
    });

    describe("updateBlockingStatusCache", () => {
      test("updates cache with new data", () => {
        const cache = createBlockingStatusCache();

        const result: BlockingStatusResult = {
          blockingInfo: new Map([
            [
              "auth.login",
              {
                status: "blocked",
                directBlockers: [],
                transitiveBlockers: [],
              },
            ],
          ]),
          blockedRequirements: ["auth.login"],
          requirementsInCycles: [],
          unblockedRequirements: [],
        };

        const hierarchyStatus = new Map<string, BlockingStatus>([
          ["auth", "blocked"],
        ]);

        updateBlockingStatusCache(cache, result, hierarchyStatus, [
          "file:///auth.bp",
        ]);

        expect(cache.result.blockedRequirements).toContain("auth.login");
        expect(cache.hierarchyStatus.get("auth")).toBe("blocked");
        expect(cache.sourceFiles.has("file:///auth.bp")).toBe(true);
      });
    });

    describe("shouldInvalidateCache", () => {
      test("returns true for tracked source file", () => {
        const cache = createBlockingStatusCache();
        cache.sourceFiles.add("file:///auth.bp");

        expect(shouldInvalidateCache(cache, "file:///auth.bp")).toBe(true);
      });

      test("returns true for any .bp file", () => {
        const cache = createBlockingStatusCache();

        expect(shouldInvalidateCache(cache, "file:///new.bp")).toBe(true);
      });

      test("returns true for any .tickets.json file", () => {
        const cache = createBlockingStatusCache();

        expect(
          shouldInvalidateCache(cache, "file:///.blueprint/tickets/auth.tickets.json")
        ).toBe(true);
      });

      test("returns false for unrelated files", () => {
        const cache = createBlockingStatusCache();

        expect(shouldInvalidateCache(cache, "file:///src/main.ts")).toBe(false);
        expect(shouldInvalidateCache(cache, "file:///package.json")).toBe(false);
      });
    });
  });
});
