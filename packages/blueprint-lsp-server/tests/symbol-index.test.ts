import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import {
  CrossFileSymbolIndex,
  type IndexedSymbol,
  type UnresolvedReference,
} from "../src/symbol-index";

describe("CrossFileSymbolIndex", () => {
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

  describe("addFile", () => {
    test("indexes a simple module", () => {
      const code = `
@module authentication
  Handles user authentication.
`;
      const ast = parseToAST(code);
      index.addFile("file:///auth.bp", ast);

      expect(index.getFileCount()).toBe(1);
      expect(index.getSymbolCount()).toBe(1);
      expect(index.hasSymbol("authentication")).toBe(true);
    });

    test("indexes module with features and requirements", () => {
      const code = `
@module authentication

@feature login
  Login functionality.

@requirement basic-auth
  Email/password login.
`;
      const ast = parseToAST(code);
      index.addFile("file:///auth.bp", ast);

      expect(index.hasSymbol("authentication")).toBe(true);
      expect(index.hasSymbol("authentication.login")).toBe(true);
      expect(index.hasSymbol("authentication.login.basic-auth")).toBe(true);
    });

    test("indexes constraints", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth
  Email/password login.

  @constraint bcrypt-hashing
    Use bcrypt.
`;
      const ast = parseToAST(code);
      index.addFile("file:///auth.bp", ast);

      expect(index.hasSymbol("authentication.login.basic-auth.bcrypt-hashing")).toBe(true);
    });

    test("indexes module-level requirements", () => {
      const code = `
@module utilities

@requirement common-utils
  Shared utilities.
`;
      const ast = parseToAST(code);
      index.addFile("file:///utils.bp", ast);

      expect(index.hasSymbol("utilities")).toBe(true);
      expect(index.hasSymbol("utilities.common-utils")).toBe(true);
    });

    test("replaces existing file symbols on re-add", () => {
      const code1 = `
@module auth

@feature login
`;
      const code2 = `
@module auth

@feature logout
`;
      const ast1 = parseToAST(code1);
      const ast2 = parseToAST(code2);

      index.addFile("file:///auth.bp", ast1);
      expect(index.hasSymbol("auth.login")).toBe(true);
      expect(index.hasSymbol("auth.logout")).toBe(false);

      index.addFile("file:///auth.bp", ast2);
      expect(index.hasSymbol("auth.login")).toBe(false);
      expect(index.hasSymbol("auth.logout")).toBe(true);
    });

    test("indexes multiple files", () => {
      const authCode = `
@module authentication

@feature login
`;
      const paymentCode = `
@module payments

@feature checkout
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));

      expect(index.getFileCount()).toBe(2);
      expect(index.hasSymbol("authentication")).toBe(true);
      expect(index.hasSymbol("payments")).toBe(true);
    });

    test("tracks file references from @depends-on", () => {
      const code = `
@module payments
  @depends-on authentication

@feature checkout
  @depends-on payments.cart, inventory.stock
`;
      const ast = parseToAST(code);
      index.addFile("file:///payments.bp", ast);

      // References should be tracked (for dependency analysis)
      const unresolved = index.getUnresolvedReferencesForFile("file:///payments.bp");
      expect(unresolved.length).toBeGreaterThan(0);
    });
  });

  describe("removeFile", () => {
    test("removes all symbols from a file", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth
`;
      const ast = parseToAST(code);
      index.addFile("file:///auth.bp", ast);

      expect(index.getSymbolCount()).toBe(3);
      index.removeFile("file:///auth.bp");

      expect(index.getFileCount()).toBe(0);
      expect(index.getSymbolCount()).toBe(0);
      expect(index.hasSymbol("authentication")).toBe(false);
    });

    test("removing non-existent file is a no-op", () => {
      index.removeFile("file:///nonexistent.bp");
      expect(index.getFileCount()).toBe(0);
    });

    test("removing one file doesn't affect others", () => {
      const authCode = `@module authentication`;
      const paymentCode = `@module payments`;

      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));

      index.removeFile("file:///auth.bp");

      expect(index.getFileCount()).toBe(1);
      expect(index.hasSymbol("authentication")).toBe(false);
      expect(index.hasSymbol("payments")).toBe(true);
    });
  });

  describe("resolveReference", () => {
    beforeEach(() => {
      const authCode = `
@module authentication

@feature login

@requirement basic-auth
  Basic login.

@requirement oauth
  OAuth login.
`;
      const paymentCode = `
@module payments

@feature checkout
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));
    });

    test("resolves exact module reference", () => {
      const ref = {
        type: "reference" as const,
        parts: ["authentication"],
        path: "authentication",
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: 0, endOffset: 0 },
      };

      const result = index.resolveReference(ref);
      expect(result.symbol).not.toBeNull();
      expect(result.symbol!.kind).toBe("module");
      expect(result.symbol!.path).toBe("authentication");
      expect(result.isPartialMatch).toBe(false);
    });

    test("resolves exact feature reference", () => {
      const ref = {
        type: "reference" as const,
        parts: ["authentication", "login"],
        path: "authentication.login",
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: 0, endOffset: 0 },
      };

      const result = index.resolveReference(ref);
      expect(result.symbol).not.toBeNull();
      expect(result.symbol!.kind).toBe("feature");
      expect(result.symbol!.path).toBe("authentication.login");
    });

    test("resolves exact requirement reference", () => {
      const ref = {
        type: "reference" as const,
        parts: ["authentication", "login", "basic-auth"],
        path: "authentication.login.basic-auth",
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: 0, endOffset: 0 },
      };

      const result = index.resolveReference(ref);
      expect(result.symbol).not.toBeNull();
      expect(result.symbol!.kind).toBe("requirement");
    });

    test("returns null for non-existent reference", () => {
      const ref = {
        type: "reference" as const,
        parts: ["nonexistent"],
        path: "nonexistent",
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: 0, endOffset: 0 },
      };

      const result = index.resolveReference(ref);
      expect(result.symbol).toBeNull();
      expect(result.matchingSymbols).toHaveLength(0);
    });

    test("partial match finds children", () => {
      const ref = {
        type: "reference" as const,
        parts: ["authentication", "login"],
        path: "authentication.login",
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, startOffset: 0, endOffset: 0 },
      };

      const result = index.resolveReference(ref);
      // Should match the feature exactly, plus find children (requirements)
      expect(result.symbol).not.toBeNull();
    });
  });

  describe("getUnresolvedReferences", () => {
    test("detects unresolved cross-file references", () => {
      const code = `
@module payments
  @depends-on authentication
  @depends-on nonexistent.module

@feature checkout
  @depends-on authentication.login.basic-auth
`;
      index.addFile("file:///payments.bp", parseToAST(code));

      const unresolved = index.getUnresolvedReferences();
      // "authentication" and "authentication.login.basic-auth" don't exist
      // "nonexistent.module" doesn't exist
      expect(unresolved.length).toBe(3);
    });

    test("returns empty when all references resolve", () => {
      const authCode = `
@module authentication

@feature login

@requirement basic-auth
`;
      const paymentCode = `
@module payments
  @depends-on authentication
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));

      const unresolved = index.getUnresolvedReferences();
      expect(unresolved.length).toBe(0);
    });

    test("getUnresolvedReferencesForFile scopes to single file", () => {
      const authCode = `
@module authentication
  @depends-on missing1
`;
      const paymentCode = `
@module payments
  @depends-on missing2
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));

      const authUnresolved = index.getUnresolvedReferencesForFile("file:///auth.bp");
      expect(authUnresolved.length).toBe(1);
      expect(authUnresolved[0]!.reference.path).toBe("missing1");

      const paymentUnresolved = index.getUnresolvedReferencesForFile("file:///payments.bp");
      expect(paymentUnresolved.length).toBe(1);
      expect(paymentUnresolved[0]!.reference.path).toBe("missing2");
    });
  });

  describe("getFilesDependingOn", () => {
    test("finds files that reference symbols in another file", () => {
      const authCode = `
@module authentication

@feature login
`;
      const paymentCode = `
@module payments
  @depends-on authentication
`;
      const notificationCode = `
@module notifications
  @depends-on authentication.login
`;
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));
      index.addFile("file:///notifications.bp", parseToAST(notificationCode));

      const dependents = index.getFilesDependingOn("file:///auth.bp");
      expect(dependents).toContain("file:///payments.bp");
      expect(dependents).toContain("file:///notifications.bp");
    });

    test("returns empty array when no dependents", () => {
      const authCode = `@module authentication`;
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const dependents = index.getFilesDependingOn("file:///auth.bp");
      expect(dependents).toHaveLength(0);
    });

    test("doesn't include self as dependent", () => {
      const code = `
@module authentication

@feature login
  @depends-on authentication
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const dependents = index.getFilesDependingOn("file:///auth.bp");
      expect(dependents).not.toContain("file:///auth.bp");
    });
  });

  describe("getSymbol", () => {
    test("returns symbol by path", () => {
      const code = `
@module authentication

@feature login
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const symbols = index.getSymbol("authentication.login");
      expect(symbols).toBeDefined();
      expect(symbols).toHaveLength(1);
      expect(symbols![0]!.kind).toBe("feature");
    });

    test("returns undefined for non-existent path", () => {
      const symbols = index.getSymbol("nonexistent");
      expect(symbols).toBeUndefined();
    });
  });

  describe("getSymbolsByKind", () => {
    beforeEach(() => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  @constraint bcrypt
`;
      index.addFile("file:///auth.bp", parseToAST(code));
    });

    test("returns all modules", () => {
      const modules = index.getSymbolsByKind("module");
      expect(modules).toHaveLength(1);
      expect(modules[0]!.path).toBe("auth");
    });

    test("returns all features", () => {
      const features = index.getSymbolsByKind("feature");
      expect(features).toHaveLength(1);
      expect(features[0]!.path).toBe("auth.login");
    });

    test("returns all requirements", () => {
      const requirements = index.getSymbolsByKind("requirement");
      expect(requirements).toHaveLength(1);
      expect(requirements[0]!.path).toBe("auth.login.basic-auth");
    });

    test("returns all constraints", () => {
      const constraints = index.getSymbolsByKind("constraint");
      expect(constraints).toHaveLength(1);
      expect(constraints[0]!.path).toBe("auth.login.basic-auth.bcrypt");
    });
  });

  describe("getSymbolsInFile", () => {
    test("returns all symbols defined in a file", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const symbols = index.getSymbolsInFile("file:///auth.bp");
      expect(symbols).toHaveLength(3);

      const paths = symbols.map((s) => s.path);
      expect(paths).toContain("auth");
      expect(paths).toContain("auth.login");
      expect(paths).toContain("auth.login.basic-auth");
    });

    test("returns empty array for non-indexed file", () => {
      const symbols = index.getSymbolsInFile("file:///nonexistent.bp");
      expect(symbols).toHaveLength(0);
    });
  });

  describe("getFileSymbolTable", () => {
    test("returns symbol table for indexed file", () => {
      const code = `
@module auth

@feature login
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const symbolTable = index.getFileSymbolTable("file:///auth.bp");
      expect(symbolTable).toBeDefined();
      expect(symbolTable!.modules.has("auth")).toBe(true);
      expect(symbolTable!.features.has("auth.login")).toBe(true);
    });

    test("returns undefined for non-indexed file", () => {
      const symbolTable = index.getFileSymbolTable("file:///nonexistent.bp");
      expect(symbolTable).toBeUndefined();
    });
  });

  describe("getIndexedFiles", () => {
    test("returns all indexed file URIs", () => {
      index.addFile("file:///auth.bp", parseToAST("@module auth"));
      index.addFile("file:///payments.bp", parseToAST("@module payments"));

      const files = index.getIndexedFiles();
      expect(files).toContain("file:///auth.bp");
      expect(files).toContain("file:///payments.bp");
    });
  });

  describe("getConflictingPaths", () => {
    test("detects same symbol defined in multiple files", () => {
      const code1 = `@module shared`;
      const code2 = `@module shared`;

      index.addFile("file:///file1.bp", parseToAST(code1));
      index.addFile("file:///file2.bp", parseToAST(code2));

      const conflicts = index.getConflictingPaths();
      expect(conflicts).toContain("shared");
    });

    test("returns empty when no conflicts", () => {
      index.addFile("file:///auth.bp", parseToAST("@module auth"));
      index.addFile("file:///payments.bp", parseToAST("@module payments"));

      const conflicts = index.getConflictingPaths();
      expect(conflicts).toHaveLength(0);
    });
  });

  describe("clear", () => {
    test("removes all indexed data", () => {
      index.addFile("file:///auth.bp", parseToAST("@module auth"));
      index.addFile("file:///payments.bp", parseToAST("@module payments"));

      index.clear();

      expect(index.getFileCount()).toBe(0);
      expect(index.getSymbolCount()).toBe(0);
      expect(index.getIndexedFiles()).toHaveLength(0);
    });
  });

  describe("cross-file reference scenarios", () => {
    test("full cross-file dependency chain", () => {
      // Set up a realistic multi-file scenario
      const storageCode = `
@module storage

@feature database

@requirement user-table
  User table schema.
`;
      const authCode = `
@module authentication
  @depends-on storage.database

@feature login
  @depends-on storage.database.user-table

@requirement basic-auth
  @depends-on authentication.login
`;
      const paymentCode = `
@module payments
  @depends-on authentication

@feature checkout
  @depends-on authentication.login.basic-auth
`;

      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///payments.bp", parseToAST(paymentCode));

      // All references should resolve
      const unresolved = index.getUnresolvedReferences();
      expect(unresolved).toHaveLength(0);

      // Changing storage should affect auth and payments
      const storageDependents = index.getFilesDependingOn("file:///storage.bp");
      expect(storageDependents).toContain("file:///auth.bp");

      // Changing auth should affect payments
      const authDependents = index.getFilesDependingOn("file:///auth.bp");
      expect(authDependents).toContain("file:///payments.bp");
    });

    test("handles requirement-level @depends-on", () => {
      const code = `
@module auth

@feature login

@requirement oauth
  @depends-on auth.login.basic-auth

@requirement basic-auth
  Basic login.
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      // Self-referential dependency should resolve
      const unresolved = index.getUnresolvedReferences();
      expect(unresolved).toHaveLength(0);
    });
  });
});
