import { describe, test, expect, beforeAll } from "bun:test";
import { initializeParser, parseDocument } from "./parser";
import {
  findNodeAtPosition,
  findReferencesTarget,
  buildReferences,
  getReferencesStats,
  type ReferencesContext,
} from "./references";
import { CrossFileSymbolIndex } from "./symbol-index";
import { DependencyGraph } from "./dependency-graph";
import { transformToAST } from "./ast";

describe("references", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("findNodeAtPosition", () => {
    test("finds node at exact position", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      // Position on "auth" identifier
      const node = findNodeAtPosition(tree!, { line: 0, character: 8 });
      expect(node).not.toBeNull();
      expect(node!.text).toBe("auth");
    });

    test("returns null for position outside document", () => {
      const source = `@module auth`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const node = findNodeAtPosition(tree!, { line: 10, character: 0 });
      expect(node).toBeNull();
    });
  });

  describe("findReferencesTarget", () => {
    test("finds module target", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on "auth" identifier
      const target = findReferencesTarget(
        tree!,
        { line: 0, character: 8 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("module");
      expect(target!.path).toBe("auth");
      expect(target!.symbol).toBeDefined();
    });

    test("finds feature target", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on "login" identifier
      const target = findReferencesTarget(
        tree!,
        { line: 3, character: 12 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("feature");
      expect(target!.path).toBe("auth.login");
    });

    test("finds requirement target", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.

    @requirement basic-auth
      Users can log in with email and password.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on "basic-auth" identifier
      const target = findReferencesTarget(
        tree!,
        { line: 6, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("requirement");
      expect(target!.path).toBe("auth.login.basic-auth");
    });

    test("finds constraint target", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

      @constraint bcrypt-cost
        Use bcrypt with cost >= 12.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on "bcrypt-cost" identifier
      const target = findReferencesTarget(
        tree!,
        { line: 5, character: 20 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("constraint");
      expect(target!.path).toBe("auth.login.basic-auth.bcrypt-cost");
    });

    test("finds reference target in @depends-on", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

  @feature session
    @depends-on auth.login.basic-auth

    Session management.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on the reference "auth.login.basic-auth"
      const target = findReferencesTarget(
        tree!,
        { line: 6, character: 20 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("requirement");
      expect(target!.path).toBe("auth.login.basic-auth");
      expect(target!.symbol).toBeDefined();
    });

    test("returns keyword target for @module keyword", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();

      // Position on "@module" keyword
      const target = findReferencesTarget(
        tree!,
        { line: 0, character: 3 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("keyword");
    });
  });

  describe("buildReferences", () => {
    function createContext(
      symbolIndex: CrossFileSymbolIndex,
      includeDeclaration: boolean = false
    ): ReferencesContext {
      const { graph, edges } = DependencyGraph.build(symbolIndex);
      return {
        symbolIndex,
        dependencyGraph: graph,
        edges,
        fileUri: "file:///test.bp",
        includeDeclaration,
      };
    }

    test("returns null for keyword target", () => {
      const symbolIndex = new CrossFileSymbolIndex();
      const context = createContext(symbolIndex);

      const result = buildReferences({ kind: "keyword" }, context);
      expect(result).toBeNull();
    });

    test("returns null for target without path", () => {
      const symbolIndex = new CrossFileSymbolIndex();
      const context = createContext(symbolIndex);

      const result = buildReferences({ kind: "module" }, context);
      expect(result).toBeNull();
    });

    test("finds references to a requirement", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

  @feature session
    @depends-on auth.login.basic-auth

    @requirement create-token
      Create session tokens.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to basic-auth
      const target = findReferencesTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0]!.uri).toBe("file:///test.bp");
      // The reference is on line 6 (0-indexed)
      expect(result![0]!.range.start.line).toBe(6);
    });

    test("finds references to a feature", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

@module payments
  @depends-on auth.login

  @feature checkout
    Checkout feature.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to auth.login
      const target = findReferencesTarget(
        tree!,
        { line: 1, character: 12 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0]!.uri).toBe("file:///test.bp");
      // The reference is on line 6 (0-indexed)
      expect(result![0]!.range.start.line).toBe(6);
    });

    test("finds references to a module", () => {
      const source = `@module storage
  @feature user-accounts
    @requirement user-table
      User table schema.

@module auth
  @depends-on storage

  @feature login
    Login feature.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to storage module
      const target = findReferencesTarget(
        tree!,
        { line: 0, character: 8 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0]!.uri).toBe("file:///test.bp");
      expect(result![0]!.range.start.line).toBe(6);
    });

    test("finds multiple references to the same symbol", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

  @feature session
    @depends-on auth.login.basic-auth

    @requirement create-token
      Create session tokens.

  @feature logout
    @depends-on auth.login.basic-auth

    @requirement invalidate-token
      Invalidate tokens.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to basic-auth
      const target = findReferencesTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      // Both references should be in the same file
      expect(result![0]!.uri).toBe("file:///test.bp");
      expect(result![1]!.uri).toBe("file:///test.bp");
    });

    test("returns null for symbol with no references", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to basic-auth (which has no references)
      const target = findReferencesTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).toBeNull();
    });

    test("includes declaration when includeDeclaration is true", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

  @feature session
    @depends-on auth.login.basic-auth

    @requirement create-token
      Create session tokens.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to basic-auth
      const target = findReferencesTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex, true);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      // Should include the declaration + the reference
      expect(result!.length).toBe(2);
      
      // One of them should be the declaration (line 2)
      const hasDeclaration = result!.some((loc) => loc.range.start.line === 2);
      expect(hasDeclaration).toBe(true);
      
      // One of them should be the reference (line 6)
      const hasReference = result!.some((loc) => loc.range.start.line === 6);
      expect(hasReference).toBe(true);
    });

    test("finds cross-file references", () => {
      const sourceA = `@module storage
  @feature user-accounts
    @requirement user-table
      User table schema.`;

      const sourceB = `@module auth
  @depends-on storage.user-accounts

  @feature login
    Login feature.`;

      const treeA = parseDocument(sourceA);
      const treeB = parseDocument(sourceB);
      const astA = transformToAST(treeA!);
      const astB = transformToAST(treeB!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///storage.bp", astA);
      symbolIndex.addFile("file:///auth.bp", astB);

      // Find references to storage.user-accounts from storage.bp
      const target = findReferencesTarget(
        treeA!,
        { line: 1, character: 12 },
        symbolIndex,
        "file:///storage.bp"
      );

      const context = createContext(symbolIndex);
      context.fileUri = "file:///storage.bp";
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      // The reference should be in auth.bp
      expect(result![0]!.uri).toBe("file:///auth.bp");
    });

    test("finds references from @depends-on target position", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

  @feature session
    @depends-on auth.login.basic-auth

    @requirement create-token
      @depends-on auth.login.basic-auth
      Create session tokens.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on the reference in @depends-on (find all other references)
      const target = findReferencesTarget(
        tree!,
        { line: 6, character: 20 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      // Should find both @depends-on references
      expect(result!.length).toBe(2);
    });

    test("finds references to parent when child is referenced", () => {
      // When @depends-on auth.login exists, it should show up when
      // finding references to auth.login.basic-auth (because the parent reference
      // implicitly includes all children)
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

@module payments
  @depends-on auth.login

  @feature checkout
    Checkout feature.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      // Find references to basic-auth requirement
      const target = findReferencesTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildReferences(target!, context);

      expect(result).not.toBeNull();
      // The @depends-on auth.login reference should be found because it
      // implicitly includes auth.login.basic-auth
      expect(result!.length).toBe(1);
      expect(result![0]!.range.start.line).toBe(6);
    });
  });

  describe("getReferencesStats", () => {
    test("returns correct stats for references", () => {
      const sourceA = `@module storage
  @feature user-accounts
    @requirement user-table
      User table schema.`;

      const sourceB = `@module auth
  @depends-on storage.user-accounts

  @feature login
    @depends-on storage.user-accounts
    Login feature.`;

      const treeA = parseDocument(sourceA);
      const treeB = parseDocument(sourceB);
      const astA = transformToAST(treeA!);
      const astB = transformToAST(treeB!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///storage.bp", astA);
      symbolIndex.addFile("file:///auth.bp", astB);

      const { edges } = DependencyGraph.build(symbolIndex);

      const target = findReferencesTarget(
        treeA!,
        { line: 1, character: 12 },
        symbolIndex,
        "file:///storage.bp"
      );

      const context: ReferencesContext = {
        symbolIndex,
        dependencyGraph: DependencyGraph.build(symbolIndex).graph,
        edges,
        fileUri: "file:///storage.bp",
        includeDeclaration: false,
      };

      const stats = getReferencesStats(target!, context);

      expect(stats).not.toBeNull();
      expect(stats!.referenceCount).toBe(2);
      expect(stats!.fileCount).toBe(1); // Both references are in auth.bp
    });

    test("returns null for target without path", () => {
      const symbolIndex = new CrossFileSymbolIndex();
      const { graph, edges } = DependencyGraph.build(symbolIndex);

      const context: ReferencesContext = {
        symbolIndex,
        dependencyGraph: graph,
        edges,
        fileUri: "file:///test.bp",
        includeDeclaration: false,
      };

      const stats = getReferencesStats({ kind: "module" }, context);
      expect(stats).toBeNull();
    });
  });
});
