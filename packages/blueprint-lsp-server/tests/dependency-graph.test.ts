import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import {
  DependencyGraph,
  type DependencyGraphResult,
  type CircularDependency,
} from "../src/dependency-graph";

describe("DependencyGraph", () => {
  let index: CrossFileSymbolIndex;

  beforeAll(async () => {
    await initializeParser();
  });

  beforeEach(() => {
    index = new CrossFileSymbolIndex();
  });

  /**
   * Helper to parse code and return AST.
   */
  function parseToAST(code: string) {
    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    return transformToAST(tree!);
  }

  describe("build", () => {
    test("builds empty graph from empty index", () => {
      const result = DependencyGraph.build(index);

      expect(result.edges).toHaveLength(0);
      expect(result.cycles).toHaveLength(0);
      expect(result.topologicalOrder).toHaveLength(0);
      expect(result.isAcyclic).toBe(true);
    });

    test("builds graph with no dependencies", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.edges).toHaveLength(0);
      expect(result.cycles).toHaveLength(0);
      expect(result.isAcyclic).toBe(true);
      // Topological order should contain all nodes
      expect(result.topologicalOrder).toContain("auth");
      expect(result.topologicalOrder).toContain("auth.login");
      expect(result.topologicalOrder).toContain("auth.login.basic-auth");
    });

    test("builds graph with single dependency", () => {
      const code = `
@module auth

@feature login
  @depends-on auth

@requirement basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]!.from).toBe("auth.login");
      expect(result.edges[0]!.to).toBe("auth");
      expect(result.isAcyclic).toBe(true);
    });

    test("builds graph with multiple dependencies", () => {
      const code = `
@module auth

@feature login
  @depends-on auth

@requirement basic-auth
  @depends-on auth.login
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.edges).toHaveLength(2);
      expect(result.isAcyclic).toBe(true);
    });

    test("builds graph with comma-separated dependencies", () => {
      const storageCode = `
@module storage

@feature database

@requirement user-table
`;
      const authCode = `
@module auth
  @depends-on storage, storage.database
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = DependencyGraph.build(index);

      expect(result.edges).toHaveLength(2);
      expect(result.isAcyclic).toBe(true);

      const fromAuth = result.edges.filter((e) => e.from === "auth");
      expect(fromAuth).toHaveLength(2);
    });

    test("ignores unresolved references", () => {
      const code = `
@module auth
  @depends-on nonexistent
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      // Unresolved references don't create edges
      expect(result.edges).toHaveLength(0);
      expect(result.isAcyclic).toBe(true);
    });

    test("ignores self-dependencies", () => {
      const code = `
@module auth
  @depends-on auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      // Self-dependencies are ignored
      expect(result.edges).toHaveLength(0);
      expect(result.isAcyclic).toBe(true);
    });

    test("deduplicates identical edges", () => {
      const code = `
@module auth
  @depends-on storage

@feature login
  @depends-on storage
`;
      const storageCode = `@module storage`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      // Two edges: auth->storage and auth.login->storage
      expect(result.edges).toHaveLength(2);
    });
  });

  describe("cycle detection", () => {
    test("detects simple two-node cycle", () => {
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

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(false);
      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]!.cycle).toContain("a");
      expect(result.cycles[0]!.cycle).toContain("b");
    });

    test("detects three-node cycle", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `
@module b
  @depends-on c
`;
      const codeC = `
@module c
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));
      index.addFile("file:///c.bp", parseToAST(codeC));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(false);
      expect(result.cycles).toHaveLength(1);

      const cycle = result.cycles[0]!;
      expect(cycle.cycle).toHaveLength(4); // a, b, c, a
      expect(cycle.cycle[0]).toBe(cycle.cycle[3]); // First and last are same
    });

    test("detects cycle in larger graph with non-cyclic parts", () => {
      const code = `
@module a
  @depends-on b

@module b
  @depends-on c

@module c
  @depends-on b

@module d
  @depends-on a
`;
      index.addFile("file:///test.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(false);
      // Should detect the b<->c cycle
      expect(result.cycles.length).toBeGreaterThanOrEqual(1);

      const cycleNodes = result.cycles.flatMap((c) => c.cycle);
      expect(cycleNodes).toContain("b");
      expect(cycleNodes).toContain("c");
    });

    test("detects multiple independent cycles", () => {
      const code = `
@module a
  @depends-on b

@module b
  @depends-on a

@module x
  @depends-on y

@module y
  @depends-on x
`;
      index.addFile("file:///test.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(false);
      expect(result.cycles).toHaveLength(2);
    });

    test("cycle edges contain location information", () => {
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

      const result = DependencyGraph.build(index);

      expect(result.cycles).toHaveLength(1);
      const cycle = result.cycles[0]!;
      expect(cycle.edges.length).toBeGreaterThan(0);

      for (const edge of cycle.edges) {
        expect(edge.reference).toBeDefined();
        expect(edge.reference.location).toBeDefined();
        expect(edge.fileUri).toBeDefined();
      }
    });

    test("handles nested element cycles", () => {
      const code = `
@module auth

@feature login
  @depends-on auth.session.validate

@feature session

@requirement validate
  @depends-on auth.login
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(false);
      expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("topological sort", () => {
    test("returns empty array for cyclic graph", () => {
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

      const result = DependencyGraph.build(index);

      expect(result.topologicalOrder).toHaveLength(0);
    });

    test("returns valid order for acyclic graph", () => {
      const code = `
@module storage

@module auth
  @depends-on storage

@module payments
  @depends-on auth, storage
`;
      index.addFile("file:///test.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(true);
      expect(result.topologicalOrder).toContain("storage");
      expect(result.topologicalOrder).toContain("auth");
      expect(result.topologicalOrder).toContain("payments");

      // Verify ordering: storage before auth, both before payments
      const storageIdx = result.topologicalOrder.indexOf("storage");
      const authIdx = result.topologicalOrder.indexOf("auth");
      const paymentsIdx = result.topologicalOrder.indexOf("payments");

      expect(storageIdx).toBeLessThan(authIdx);
      expect(storageIdx).toBeLessThan(paymentsIdx);
      expect(authIdx).toBeLessThan(paymentsIdx);
    });

    test("handles diamond dependency pattern", () => {
      const code = `
@module base

@module left
  @depends-on base

@module right
  @depends-on base

@module top
  @depends-on left, right
`;
      index.addFile("file:///test.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(true);

      const baseIdx = result.topologicalOrder.indexOf("base");
      const leftIdx = result.topologicalOrder.indexOf("left");
      const rightIdx = result.topologicalOrder.indexOf("right");
      const topIdx = result.topologicalOrder.indexOf("top");

      expect(baseIdx).toBeLessThan(leftIdx);
      expect(baseIdx).toBeLessThan(rightIdx);
      expect(leftIdx).toBeLessThan(topIdx);
      expect(rightIdx).toBeLessThan(topIdx);
    });
  });

  describe("getDependencies and getDependents", () => {
    let graph: DependencyGraph;
    let result: DependencyGraphResult;

    beforeEach(() => {
      const code = `
@module storage

@module auth
  @depends-on storage

@module payments
  @depends-on auth, storage
`;
      index.addFile("file:///test.bp", parseToAST(code));
      result = DependencyGraph.build(index);

      // We need access to the graph instance, so rebuild manually
      graph = new DependencyGraph();
      // Use the static build which returns result, but we need internal graph
      // For testing, we'll create a workaround
    });

    test("getDependencies returns direct dependencies via result edges", () => {
      const authDeps = result.edges
        .filter((e) => e.from === "auth")
        .map((e) => e.to);

      expect(authDeps).toContain("storage");
      expect(authDeps).toHaveLength(1);
    });

    test("getDependents returns direct dependents via result edges", () => {
      const storageDependents = result.edges
        .filter((e) => e.to === "storage")
        .map((e) => e.from);

      expect(storageDependents).toContain("auth");
      expect(storageDependents).toContain("payments");
    });
  });

  describe("transitive dependencies", () => {
    test("computes transitive dependencies", () => {
      const code = `
@module a

@module b
  @depends-on a

@module c
  @depends-on b

@module d
  @depends-on c
`;
      index.addFile("file:///test.bp", parseToAST(code));
      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(true);

      // d depends transitively on c, b, a
      // We verify this through topological order
      const aIdx = result.topologicalOrder.indexOf("a");
      const bIdx = result.topologicalOrder.indexOf("b");
      const cIdx = result.topologicalOrder.indexOf("c");
      const dIdx = result.topologicalOrder.indexOf("d");

      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
      expect(cIdx).toBeLessThan(dIdx);
    });
  });

  describe("cross-file scenarios", () => {
    test("handles dependencies across multiple files", () => {
      const storageCode = `
@module storage

@feature database

@requirement user-table
`;
      const authCode = `
@module authentication
  @depends-on storage

@feature login
  @depends-on storage.database.user-table

@requirement basic-auth
`;
      const paymentsCode = `
@module payments
  @depends-on authentication

@feature checkout
  @depends-on authentication.login.basic-auth
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentsCode));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(true);
      expect(result.edges.length).toBeGreaterThan(0);

      // Verify specific dependencies
      const authDeps = result.edges.filter((e) => e.from === "authentication");
      expect(authDeps.some((e) => e.to === "storage")).toBe(true);

      const loginDeps = result.edges.filter(
        (e) => e.from === "authentication.login"
      );
      expect(loginDeps.some((e) => e.to === "storage.database.user-table")).toBe(
        true
      );
    });

    test("detects cross-file cycles", () => {
      const authCode = `
@module authentication
  @depends-on payments
`;
      const paymentsCode = `
@module payments
  @depends-on authentication
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentsCode));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(false);
      expect(result.cycles).toHaveLength(1);

      const cycle = result.cycles[0]!;
      expect(cycle.cycle).toContain("authentication");
      expect(cycle.cycle).toContain("payments");
    });

    test("edge fileUri correctly identifies source file", () => {
      const authCode = `
@module auth
  @depends-on storage
`;
      const storageCode = `@module storage`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///storage.bp", parseToAST(storageCode));

      const result = DependencyGraph.build(index);

      const authEdge = result.edges.find((e) => e.from === "auth");
      expect(authEdge).toBeDefined();
      expect(authEdge!.fileUri).toBe("file:///auth.bp");
    });
  });

  describe("edge cases", () => {
    test("handles graph with only constraints (no dependencies)", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  @constraint bcrypt
  @constraint rate-limit
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      // Constraints don't create dependencies
      expect(result.edges).toHaveLength(0);
      expect(result.isAcyclic).toBe(true);
    });

    test("handles deeply nested dependencies", () => {
      const code = `
@module a

@feature a1
  @depends-on a

@requirement a1r1
  @depends-on a.a1

@module b
  @depends-on a.a1.a1r1
`;
      index.addFile("file:///test.bp", parseToAST(code));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(true);
      expect(result.edges).toHaveLength(3);
    });

    test("handles file removal and re-addition", () => {
      const codeA = `
@module a
  @depends-on b
`;
      const codeB = `@module b`;

      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      let result = DependencyGraph.build(index);
      expect(result.edges).toHaveLength(1);
      expect(result.isAcyclic).toBe(true);

      // Remove b.bp
      index.removeFile("file:///b.bp");
      result = DependencyGraph.build(index);

      // Edge should still exist from 'a' but 'b' is now unresolved
      // so no edge is created
      expect(result.edges).toHaveLength(0);

      // Re-add b.bp
      index.addFile("file:///b.bp", parseToAST(codeB));
      result = DependencyGraph.build(index);

      expect(result.edges).toHaveLength(1);
    });
  });

  describe("real-world scenario from SPEC.md", () => {
    test("handles authentication.bp example from spec", () => {
      const storageCode = `
@module storage

@feature user-accounts
  User account storage.

  @requirement user-table
    Database schema.
`;
      const authCode = `
@module authentication
  Handles user identity verification.

@feature login
  @depends-on storage.user-accounts

  @requirement credentials-login
    Email/password login.

  @requirement oauth-login
    @depends-on authentication.login.credentials-login
    OAuth login.

  @requirement two-factor
    @depends-on authentication.login.credentials-login
    2FA support.

@feature session
  @depends-on authentication.login

  @requirement create-token
    JWT generation.

  @requirement refresh-token
    @depends-on authentication.session.create-token
    Token refresh.

  @requirement logout
    @depends-on authentication.session.create-token
    Session termination.
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = DependencyGraph.build(index);

      expect(result.isAcyclic).toBe(true);
      expect(result.cycles).toHaveLength(0);

      // Verify key dependencies exist
      const loginDeps = result.edges.filter(
        (e) => e.from === "authentication.login"
      );
      expect(loginDeps.some((e) => e.to === "storage.user-accounts")).toBe(true);

      const oauthDeps = result.edges.filter(
        (e) => e.from === "authentication.login.oauth-login"
      );
      expect(
        oauthDeps.some((e) => e.to === "authentication.login.credentials-login")
      ).toBe(true);

      const refreshDeps = result.edges.filter(
        (e) => e.from === "authentication.session.refresh-token"
      );
      expect(
        refreshDeps.some((e) => e.to === "authentication.session.create-token")
      ).toBe(true);
    });
  });
});
