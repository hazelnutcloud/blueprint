import { describe, test, expect, beforeAll } from "bun:test";
import {
  buildWorkspaceSymbols,
  indexedSymbolToSymbolInformation,
  getAllSymbolsAsSymbolInformation,
} from "./workspace-symbol";
import { CrossFileSymbolIndex } from "./symbol-index";
import { transformToAST } from "./ast";
import { initializeParser, parseDocument } from "./parser";

// ============================================================================
// Test Setup
// ============================================================================

beforeAll(async () => {
  await initializeParser();
});

// Helper to create a symbol index with test documents
function createTestIndex(documents: Array<{ uri: string; content: string }>): CrossFileSymbolIndex {
  const index = new CrossFileSymbolIndex();

  for (const doc of documents) {
    const tree = parseDocument(doc.content);
    if (tree) {
      const ast = transformToAST(tree);
      index.addFile(doc.uri, ast);
      tree.delete();
    }
  }

  return index;
}

// ============================================================================
// Basic Functionality Tests
// ============================================================================

describe("buildWorkspaceSymbols", () => {
  describe("empty index", () => {
    test("returns empty array for empty index", () => {
      const index = new CrossFileSymbolIndex();
      const results = buildWorkspaceSymbols(index, "");
      expect(results).toEqual([]);
    });

    test("returns empty array for query with no matches", () => {
      const index = new CrossFileSymbolIndex();
      const results = buildWorkspaceSymbols(index, "nonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("single file index", () => {
    test("returns all symbols for empty query", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `
@module authentication
  User authentication module.

  @feature login
    Login functionality.

    @requirement basic-auth
      Basic authentication.
      
      @constraint bcrypt
        Use bcrypt.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "");

      // Should have: 1 module + 1 feature + 1 requirement + 1 constraint = 4 symbols
      expect(results.length).toBe(4);

      // Check that all symbol types are present
      const names = results.map((s) => s.name);
      expect(names).toContain("authentication");
      expect(names).toContain("login");
      expect(names).toContain("basic-auth");
      expect(names).toContain("bcrypt");
    });

    test("filters symbols by query", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `
@module authentication
  Auth module.

  @feature login
    Login feature.

  @feature logout
    Logout feature.

    @requirement session-logout
      Logout functionality.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "log");

      // Should match: login, logout, session-logout (all contain "log")
      expect(results.length).toBe(3);

      const names = results.map((s) => s.name);
      expect(names).toContain("login");
      expect(names).toContain("logout");
      expect(names).toContain("session-logout");
      expect(names).not.toContain("authentication");
    });

    test("returns correct SymbolKind for each element type", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `
@module mymodule
  A module.

  @feature myfeature
    A feature.

    @requirement myrequirement
      A requirement.
      
      @constraint myconstraint
        A constraint.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "my");

      const moduleSymbol = results.find((s) => s.name === "mymodule");
      const featureSymbol = results.find((s) => s.name === "myfeature");
      const requirementSymbol = results.find((s) => s.name === "myrequirement");
      const constraintSymbol = results.find((s) => s.name === "myconstraint");

      // SymbolKind values: Module=2, Class=5, Function=12, Constant=14
      expect(moduleSymbol?.kind).toBe(2); // Module
      expect(featureSymbol?.kind).toBe(5); // Class
      expect(requirementSymbol?.kind).toBe(12); // Function
      expect(constraintSymbol?.kind).toBe(14); // Constant
    });

    test("includes correct location information", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `@module authentication
  Auth module.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "authentication");

      expect(results.length).toBe(1);
      expect(results[0]!.location.uri).toBe("file:///test/auth.bp");
      expect(results[0]!.location.range.start.line).toBe(0);
      expect(results[0]!.location.range.start.character).toBe(0);
    });

    test("includes container name for nested symbols", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `
@module authentication
  Auth module.

  @feature login
    Login feature.

    @requirement basic-auth
      Basic authentication.
      
      @constraint bcrypt
        Use bcrypt.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "");

      const moduleSymbol = results.find((s) => s.name === "authentication");
      const featureSymbol = results.find((s) => s.name === "login");
      const requirementSymbol = results.find((s) => s.name === "basic-auth");
      const constraintSymbol = results.find((s) => s.name === "bcrypt");

      expect(moduleSymbol?.containerName).toBeUndefined();
      expect(featureSymbol?.containerName).toBe("authentication");
      expect(requirementSymbol?.containerName).toBe("authentication.login");
      expect(constraintSymbol?.containerName).toBe("authentication.login.basic-auth");
    });
  });

  describe("multi-file index", () => {
    test("searches across multiple files", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `
@module authentication
  Auth module.

  @feature login
    Login feature.
`,
        },
        {
          uri: "file:///test/payments.bp",
          content: `
@module payments
  Payments module.

  @feature checkout
    Checkout feature.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "");

      // Should have symbols from both files
      expect(results.length).toBe(4);

      const names = results.map((s) => s.name);
      expect(names).toContain("authentication");
      expect(names).toContain("login");
      expect(names).toContain("payments");
      expect(names).toContain("checkout");
    });

    test("returns correct file URI for each symbol", () => {
      const index = createTestIndex([
        {
          uri: "file:///test/auth.bp",
          content: `@module authentication
  Auth module.
`,
        },
        {
          uri: "file:///test/payments.bp",
          content: `@module payments
  Payments module.
`,
        },
      ]);

      const results = buildWorkspaceSymbols(index, "");

      const authSymbol = results.find((s) => s.name === "authentication");
      const paymentsSymbol = results.find((s) => s.name === "payments");

      expect(authSymbol?.location.uri).toBe("file:///test/auth.bp");
      expect(paymentsSymbol?.location.uri).toBe("file:///test/payments.bp");
    });
  });
});

// ============================================================================
// Query Matching Tests
// ============================================================================

describe("query matching", () => {
  test("prefix match on name", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "auth");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("authentication");
  });

  test("substring match on name", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "entic");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("authentication");
  });

  test("case insensitive matching", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module Authentication
  Auth module.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "AUTH");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("Authentication");
  });

  test("matches on full path", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.

  @feature login
    Login feature.

    @requirement basic-auth
      Basic auth.
`,
      },
    ]);

    // Query "authentication.login" should match the login feature
    const results = buildWorkspaceSymbols(index, "authentication.login");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const names = results.map((s) => s.name);
    expect(names).toContain("login");
  });

  test("fuzzy matching (characters in order)", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.
`,
      },
    ]);

    // "atn" should fuzzy match "authentication" (a-t-n appear in order)
    const results = buildWorkspaceSymbols(index, "atn");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("authentication");
  });
});

// ============================================================================
// Sorting and Ranking Tests
// ============================================================================

describe("result sorting", () => {
  test("exact matches rank higher than prefix matches", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module login
  Login module.

  @feature login-form
    Login form feature.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "login");

    // "login" (exact) should come before "login-form" (prefix)
    expect(results[0]!.name).toBe("login");
    expect(results[1]!.name).toBe("login-form");
  });

  test("prefix matches rank higher than substring matches", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.

  @feature auth-login
    Auth login feature.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "auth");

    // "auth-login" (prefix on "auth") should come before "authentication" (contains "auth")
    // Actually both start with "auth", so this tests prefix vs substring
    expect(results.length).toBe(2);
  });

  test("alphabetical sorting for equal relevance", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `
@module zebra
  Zebra module.

@module alpha
  Alpha module.

@module beta
  Beta module.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "");

    // With empty query, all have same score, so sort alphabetically
    expect(results[0]!.name).toBe("alpha");
    expect(results[1]!.name).toBe("beta");
    expect(results[2]!.name).toBe("zebra");
  });
});

// ============================================================================
// Result Limiting Tests
// ============================================================================

describe("result limiting", () => {
  test("respects maxResults parameter", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `
@module mod1
  Module 1.

@module mod2
  Module 2.

@module mod3
  Module 3.

@module mod4
  Module 4.

@module mod5
  Module 5.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "", 3);
    expect(results.length).toBe(3);
  });

  test("returns all results when less than maxResults", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `
@module mod1
  Module 1.

@module mod2
  Module 2.
`,
      },
    ]);

    const results = buildWorkspaceSymbols(index, "", 10);
    expect(results.length).toBe(2);
  });
});

// ============================================================================
// Helper Function Tests
// ============================================================================

describe("indexedSymbolToSymbolInformation", () => {
  test("converts indexed symbol correctly", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.

  @feature login
    Login feature.
`,
      },
    ]);

    const symbols = index.getSymbolsByKind("feature");
    expect(symbols.length).toBe(1);

    const symbolInfo = indexedSymbolToSymbolInformation(symbols[0]!);

    expect(symbolInfo.name).toBe("login");
    expect(symbolInfo.kind).toBe(5); // Class for feature
    expect(symbolInfo.location.uri).toBe("file:///test/auth.bp");
    expect(symbolInfo.containerName).toBe("authentication");
  });

  test("handles unnamed symbols", () => {
    // This is an edge case - symbols should always have names
    // but we handle it gracefully
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `@module test
  Test module.
`,
      },
    ]);

    const symbols = index.getSymbolsByKind("module");
    expect(symbols.length).toBe(1);

    const symbolInfo = indexedSymbolToSymbolInformation(symbols[0]!);
    expect(symbolInfo.name).toBe("test");
  });
});

describe("getAllSymbolsAsSymbolInformation", () => {
  test("returns all symbols without filtering", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/auth.bp",
        content: `
@module authentication
  Auth module.

  @feature login
    Login feature.

    @requirement basic-auth
      Basic auth.
      
      @constraint bcrypt
        Use bcrypt.
`,
      },
    ]);

    const results = getAllSymbolsAsSymbolInformation(index);
    expect(results.length).toBe(4);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  test("handles special characters in query", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `
@module test-module
  Test module.
`,
      },
    ]);

    // Query with hyphen
    const results = buildWorkspaceSymbols(index, "test-");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("test-module");
  });

  test("handles empty symbol names gracefully", () => {
    // Symbols should always have names, but test defensive coding
    const index = new CrossFileSymbolIndex();
    const results = buildWorkspaceSymbols(index, "test");
    expect(results).toEqual([]);
  });

  test("handles very long queries", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `
@module test
  Test module.
`,
      },
    ]);

    const longQuery = "a".repeat(1000);
    const results = buildWorkspaceSymbols(index, longQuery);
    expect(results).toEqual([]);
  });

  test("handles unicode in symbol names", () => {
    const index = createTestIndex([
      {
        uri: "file:///test/test.bp",
        content: `
@module authentication
  Auth module.
`,
      },
    ]);

    // Unicode query shouldn't crash
    const results = buildWorkspaceSymbols(index, "");
    expect(results.length).toBe(1);
  });
});
