import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import { initializeParser, parseDocument } from "../src/parser";
import { transformToAST } from "../src/ast";
import { CrossFileSymbolIndex } from "../src/symbol-index";
import {
  computeCircularDependencyDiagnostics,
  computeUnresolvedReferenceDiagnostics,
  computeWorkspaceDiagnostics,
  mergeDiagnosticResults,
} from "../src/workspace-diagnostics";

describe("workspace-diagnostics", () => {
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

  describe("computeCircularDependencyDiagnostics", () => {
    test("returns empty result for empty index", () => {
      const result = computeCircularDependencyDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("returns empty result for acyclic graph", () => {
      const storageCode = `@module storage`;
      const authCode = `
@module auth
  @depends-on storage
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

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

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.filesWithDiagnostics).toHaveLength(2);
      expect(result.byFile.has("file:///a.bp")).toBe(true);
      expect(result.byFile.has("file:///b.bp")).toBe(true);

      // Check diagnostics in file a
      const diagsA = result.byFile.get("file:///a.bp")!;
      expect(diagsA.length).toBeGreaterThanOrEqual(1);
      expect(diagsA[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagsA[0]!.message).toContain("Circular dependency detected");
      expect(diagsA[0]!.code).toBe("circular-dependency");
      expect(diagsA[0]!.source).toBe("blueprint");

      // Check diagnostics in file b
      const diagsB = result.byFile.get("file:///b.bp")!;
      expect(diagsB.length).toBeGreaterThanOrEqual(1);
      expect(diagsB[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagsB[0]!.message).toContain("Circular dependency detected");
    });

    test("cycle message contains the full cycle path", () => {
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

      const result = computeCircularDependencyDiagnostics(index);

      // At least one file should have the cycle path in its message
      let foundCyclePath = false;
      for (const [, diags] of result.byFile) {
        for (const diag of diags) {
          if (
            diag.message.includes("a") &&
            diag.message.includes("b") &&
            diag.message.includes("c")
          ) {
            foundCyclePath = true;
            break;
          }
        }
      }
      expect(foundCyclePath).toBe(true);
    });

    test("diagnostic range points to the @depends-on reference", () => {
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

      const result = computeCircularDependencyDiagnostics(index);

      const diagsA = result.byFile.get("file:///a.bp")!;
      expect(diagsA.length).toBeGreaterThanOrEqual(1);

      // The diagnostic should point to line 2 (0-indexed) where @depends-on b is
      const diag = diagsA[0]!;
      expect(diag.range.start.line).toBe(2);
    });

    test("handles multiple independent cycles", () => {
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

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.filesWithDiagnostics).toContain("file:///test.bp");

      const diags = result.byFile.get("file:///test.bp")!;
      // Should have diagnostics for both cycles
      expect(diags.length).toBeGreaterThanOrEqual(2);
    });

    test("handles cycle within same file", () => {
      const code = `
@module auth

@feature login
  @depends-on auth.session

@feature session
  @depends-on auth.login
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeCircularDependencyDiagnostics(index);

      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags.length).toBeGreaterThanOrEqual(1);
      expect(diags[0]!.message).toContain("Circular dependency detected");
    });

    test("does not duplicate diagnostics for same location", () => {
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

      const result = computeCircularDependencyDiagnostics(index);

      // Each file should have exactly one diagnostic for the cycle
      const diagsA = result.byFile.get("file:///a.bp")!;
      const diagsB = result.byFile.get("file:///b.bp")!;

      // Count circular-dependency diagnostics
      const circularDiagsA = diagsA.filter(
        (d) => d.code === "circular-dependency"
      );
      const circularDiagsB = diagsB.filter(
        (d) => d.code === "circular-dependency"
      );

      expect(circularDiagsA).toHaveLength(1);
      expect(circularDiagsB).toHaveLength(1);
    });
  });

  describe("computeUnresolvedReferenceDiagnostics", () => {
    test("returns empty result for empty index", () => {
      const result = computeUnresolvedReferenceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("returns empty result when all references resolve", () => {
      const storageCode = `@module storage`;
      const authCode = `
@module auth
  @depends-on storage
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = computeUnresolvedReferenceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
    });

    test("detects unresolved reference", () => {
      const code = `
@module auth
  @depends-on nonexistent
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeUnresolvedReferenceDiagnostics(index);

      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diags[0]!.message).toContain("nonexistent");
      expect(diags[0]!.code).toBe("unresolved-reference");
      expect(diags[0]!.source).toBe("blueprint");
    });

    test("detects multiple unresolved references", () => {
      const code = `
@module auth
  @depends-on nonexistent1, nonexistent2

@feature login
  @depends-on also-missing
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeUnresolvedReferenceDiagnostics(index);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(3);
    });

    test("diagnostic range points to the reference", () => {
      const code = `
@module auth
  @depends-on nonexistent
`;
      index.addFile("file:///auth.bp", parseToAST(code));

      const result = computeUnresolvedReferenceDiagnostics(index);

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags[0]!.range.start.line).toBe(2);
    });

    test("reports unresolved cross-file references", () => {
      const authCode = `
@module auth
  @depends-on storage.database
`;
      // Note: storage module exists but storage.database does not
      const storageCode = `@module storage`;

      index.addFile("file:///auth.bp", parseToAST(authCode));
      index.addFile("file:///storage.bp", parseToAST(storageCode));

      const result = computeUnresolvedReferenceDiagnostics(index);

      // storage.database should be unresolved because only storage exists
      expect(result.filesWithDiagnostics).toContain("file:///auth.bp");

      const diags = result.byFile.get("file:///auth.bp")!;
      expect(diags).toHaveLength(1);
      expect(diags[0]!.message).toContain("storage.database");
    });
  });

  describe("mergeDiagnosticResults", () => {
    test("merges empty results", () => {
      const result1 = { byFile: new Map(), filesWithDiagnostics: [] };
      const result2 = { byFile: new Map(), filesWithDiagnostics: [] };

      const merged = mergeDiagnosticResults(result1, result2);

      expect(merged.byFile.size).toBe(0);
      expect(merged.filesWithDiagnostics).toHaveLength(0);
    });

    test("merges results from different files", () => {
      const result1 = {
        byFile: new Map([
          [
            "file:///a.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "Error 1",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///a.bp"],
      };
      const result2 = {
        byFile: new Map([
          [
            "file:///b.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "Error 2",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///b.bp"],
      };

      const merged = mergeDiagnosticResults(result1, result2);

      expect(merged.byFile.size).toBe(2);
      expect(merged.filesWithDiagnostics).toContain("file:///a.bp");
      expect(merged.filesWithDiagnostics).toContain("file:///b.bp");
    });

    test("merges results from same file", () => {
      const result1 = {
        byFile: new Map([
          [
            "file:///a.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "Error 1",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///a.bp"],
      };
      const result2 = {
        byFile: new Map([
          [
            "file:///a.bp",
            [
              {
                severity: DiagnosticSeverity.Error,
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 5 },
                },
                message: "Error 2",
              },
            ],
          ],
        ]),
        filesWithDiagnostics: ["file:///a.bp"],
      };

      const merged = mergeDiagnosticResults(result1, result2);

      expect(merged.byFile.size).toBe(1);
      expect(merged.byFile.get("file:///a.bp")).toHaveLength(2);
    });
  });

  describe("computeWorkspaceDiagnostics", () => {
    test("returns empty result for empty index", () => {
      const result = computeWorkspaceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });

    test("combines circular dependency and unresolved reference diagnostics", () => {
      const codeA = `
@module a
  @depends-on b
  @depends-on nonexistent
`;
      const codeB = `
@module b
  @depends-on a
`;
      index.addFile("file:///a.bp", parseToAST(codeA));
      index.addFile("file:///b.bp", parseToAST(codeB));

      const result = computeWorkspaceDiagnostics(index);

      const diagsA = result.byFile.get("file:///a.bp")!;

      // Should have both circular dependency and unresolved reference diagnostics
      const circularDiags = diagsA.filter(
        (d) => d.code === "circular-dependency"
      );
      const unresolvedDiags = diagsA.filter(
        (d) => d.code === "unresolved-reference"
      );

      expect(circularDiags.length).toBeGreaterThanOrEqual(1);
      expect(unresolvedDiags).toHaveLength(1);
    });

    test("returns clean result for valid workspace", () => {
      const storageCode = `
@module storage

@feature database

@requirement user-table
`;
      const authCode = `
@module auth
  @depends-on storage

@feature login
  @depends-on storage.database

@requirement basic-auth
  @depends-on storage.database.user-table
`;
      index.addFile("file:///storage.bp", parseToAST(storageCode));
      index.addFile("file:///auth.bp", parseToAST(authCode));

      const result = computeWorkspaceDiagnostics(index);

      expect(result.byFile.size).toBe(0);
      expect(result.filesWithDiagnostics).toHaveLength(0);
    });
  });
});
