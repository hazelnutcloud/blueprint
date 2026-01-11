import { describe, test, expect, beforeAll } from "bun:test";
import { initializeParser, parseDocument, cleanupParser } from "./parser";
import {
  buildSemanticTokens,
  semanticTokensLegend,
  TokenTypes,
  TokenModifiers,
} from "./semantic-tokens";
import { SemanticTokenTypes, SemanticTokenModifiers } from "vscode-languageserver/node";

describe("semantic-tokens", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("semanticTokensLegend", () => {
    test("defines expected token types", () => {
      expect(semanticTokensLegend.tokenTypes).toEqual([
        SemanticTokenTypes.keyword,
        SemanticTokenTypes.variable,
        SemanticTokenTypes.type,
        SemanticTokenTypes.comment,
        SemanticTokenTypes.string,
      ]);
    });

    test("defines expected token modifiers", () => {
      expect(semanticTokensLegend.tokenModifiers).toEqual([
        SemanticTokenModifiers.declaration,
        SemanticTokenModifiers.definition,
      ]);
    });
  });

  describe("TokenTypes constants", () => {
    test("match legend indices", () => {
      expect(TokenTypes.keyword).toBe(0);
      expect(TokenTypes.variable).toBe(1);
      expect(TokenTypes.type).toBe(2);
      expect(TokenTypes.comment).toBe(3);
      expect(TokenTypes.string).toBe(4);
    });
  });

  describe("TokenModifiers constants", () => {
    test("are proper bit flags", () => {
      expect(TokenModifiers.none).toBe(0);
      expect(TokenModifiers.declaration).toBe(1);
      expect(TokenModifiers.definition).toBe(2);
    });

    test("can be combined", () => {
      const combined = TokenModifiers.declaration | TokenModifiers.definition;
      expect(combined).toBe(3);
    });
  });

  describe("buildSemanticTokens", () => {
    /**
     * Helper to decode semantic tokens data array.
     * Each token is encoded as 5 integers: deltaLine, deltaChar, length, tokenType, tokenModifiers
     */
    function decodeTokens(data: number[]): Array<{
      line: number;
      char: number;
      length: number;
      tokenType: number;
      tokenModifiers: number;
    }> {
      const tokens: Array<{
        line: number;
        char: number;
        length: number;
        tokenType: number;
        tokenModifiers: number;
      }> = [];

      let currentLine = 0;
      let currentChar = 0;

      for (let i = 0; i < data.length; i += 5) {
        const deltaLine = data[i] ?? 0;
        const deltaChar = data[i + 1] ?? 0;
        const length = data[i + 2] ?? 0;
        const tokenType = data[i + 3] ?? 0;
        const tokenModifiers = data[i + 4] ?? 0;

        if (deltaLine > 0) {
          currentLine += deltaLine;
          currentChar = deltaChar;
        } else {
          currentChar += deltaChar;
        }

        tokens.push({
          line: currentLine,
          char: currentChar,
          length,
          tokenType,
          tokenModifiers,
        });
      }

      return tokens;
    }

    test("handles empty document", () => {
      const tree = parseDocument("");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      expect(tokens.data).toEqual([]);
      tree!.delete();
    });

    test("tokenizes @module keyword", () => {
      const tree = parseDocument("@module test");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Should have 2 tokens: @module keyword and identifier
      expect(decoded.length).toBe(2);

      // First token: @module keyword
      expect(decoded[0]).toEqual({
        line: 0,
        char: 0,
        length: 7, // "@module"
        tokenType: TokenTypes.keyword,
        tokenModifiers: TokenModifiers.none,
      });

      // Second token: identifier "test"
      expect(decoded[1]).toEqual({
        line: 0,
        char: 8,
        length: 4, // "test"
        tokenType: TokenTypes.variable,
        tokenModifiers: TokenModifiers.declaration | TokenModifiers.definition,
      });

      tree!.delete();
    });

    test("tokenizes @feature keyword", () => {
      const tree = parseDocument("@module m\n\n@feature login");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the @feature token
      const featureToken = decoded.find(
        (t) => t.line === 2 && t.tokenType === TokenTypes.keyword
      );
      expect(featureToken).toBeDefined();
      expect(featureToken!.length).toBe(8); // "@feature"

      // Find the feature identifier
      const featureId = decoded.find(
        (t) => t.line === 2 && t.tokenType === TokenTypes.variable
      );
      expect(featureId).toBeDefined();
      expect(featureId!.length).toBe(5); // "login"

      tree!.delete();
    });

    test("tokenizes @requirement keyword", () => {
      const tree = parseDocument(
        "@module m\n\n@feature f\n\n  @requirement basic-auth"
      );
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the @requirement token
      const reqToken = decoded.find(
        (t) => t.tokenType === TokenTypes.keyword && t.length === 12
      );
      expect(reqToken).toBeDefined();
      expect(reqToken!.length).toBe(12); // "@requirement"

      tree!.delete();
    });

    test("tokenizes @depends-on keyword and references", () => {
      const tree = parseDocument(
        "@module m\n\n@feature f\n  @depends-on other.module"
      );
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the @depends-on token
      const dependsOnToken = decoded.find(
        (t) => t.tokenType === TokenTypes.keyword && t.length === 11
      );
      expect(dependsOnToken).toBeDefined();
      expect(dependsOnToken!.length).toBe(11); // "@depends-on"

      // Find the reference tokens (type tokens)
      const refTokens = decoded.filter((t) => t.tokenType === TokenTypes.type);
      expect(refTokens.length).toBe(2); // "other" and "module"

      tree!.delete();
    });

    test("tokenizes @constraint keyword", () => {
      const tree = parseDocument(
        "@module m\n\n@feature f\n\n  @requirement r\n\n    @constraint bcrypt"
      );
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the @constraint token
      const constraintToken = decoded.find(
        (t) => t.tokenType === TokenTypes.keyword && t.length === 11
      );
      expect(constraintToken).toBeDefined();
      expect(constraintToken!.length).toBe(11); // "@constraint"

      tree!.delete();
    });

    test("tokenizes @description keyword", () => {
      const tree = parseDocument("@description\n  This is a description");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // First token should be @description keyword
      expect(decoded[0]).toEqual({
        line: 0,
        char: 0,
        length: 12, // "@description"
        tokenType: TokenTypes.keyword,
        tokenModifiers: TokenModifiers.none,
      });

      tree!.delete();
    });

    test("tokenizes single-line comments", () => {
      const tree = parseDocument("// This is a comment\n@module test");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // First token should be comment
      const commentToken = decoded.find(
        (t) => t.tokenType === TokenTypes.comment
      );
      expect(commentToken).toBeDefined();
      expect(commentToken!.line).toBe(0);
      expect(commentToken!.char).toBe(0);
      expect(commentToken!.length).toBe(20); // "// This is a comment"

      tree!.delete();
    });

    test("tokenizes multi-line comments", () => {
      // Note: Multi-line comments at document level are currently parsed as
      // description_block due to a known grammar bug. This test uses a comment
      // inside a module where it's correctly parsed as a comment.
      const tree = parseDocument("@module test\n  // line 1\n  // line 2");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Should have comment tokens
      const commentTokens = decoded.filter(
        (t) => t.tokenType === TokenTypes.comment
      );
      expect(commentTokens.length).toBe(2);

      tree!.delete();
    });

    test("declaration identifiers have correct modifiers", () => {
      const tree = parseDocument("@module my-module");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the identifier token
      const idToken = decoded.find((t) => t.tokenType === TokenTypes.variable);
      expect(idToken).toBeDefined();
      expect(idToken!.tokenModifiers).toBe(
        TokenModifiers.declaration | TokenModifiers.definition
      );

      tree!.delete();
    });

    test("reference identifiers have no modifiers", () => {
      const tree = parseDocument(
        "@module m\n\n@feature f\n  @depends-on other.ref"
      );
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the reference tokens
      const refTokens = decoded.filter((t) => t.tokenType === TokenTypes.type);
      for (const refToken of refTokens) {
        expect(refToken.tokenModifiers).toBe(TokenModifiers.none);
      }

      tree!.delete();
    });

    test("tokens are in document order", () => {
      const tree = parseDocument(`@module test
  Description here

@feature login
  @depends-on other

  @requirement auth
    Implement auth`);
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Verify tokens are sorted by line, then by character
      for (let i = 1; i < decoded.length; i++) {
        const prev = decoded[i - 1]!;
        const curr = decoded[i]!;
        const prevPos = prev.line * 10000 + prev.char;
        const currPos = curr.line * 10000 + curr.char;
        expect(currPos).toBeGreaterThanOrEqual(prevPos);
      }

      tree!.delete();
    });

    test("complex document with all elements", () => {
      const source = `// Comment at top
@description
  System description here

@module authentication
  Module description

  @feature login
    @depends-on storage.users
    
    @requirement basic-auth
      Users can log in
      
      @constraint bcrypt
        Use bcrypt hashing`;

      const tree = parseDocument(source);
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Count token types
      const keywordCount = decoded.filter(
        (t) => t.tokenType === TokenTypes.keyword
      ).length;
      const variableCount = decoded.filter(
        (t) => t.tokenType === TokenTypes.variable
      ).length;
      const typeCount = decoded.filter(
        (t) => t.tokenType === TokenTypes.type
      ).length;
      const commentCount = decoded.filter(
        (t) => t.tokenType === TokenTypes.comment
      ).length;

      // Should have keywords: @description, @module, @feature, @depends-on, @requirement, @constraint
      expect(keywordCount).toBe(6);

      // Should have variable declarations: authentication, login, basic-auth, bcrypt
      expect(variableCount).toBe(4);

      // Should have type references: storage, users
      expect(typeCount).toBe(2);

      // Should have at least one comment
      expect(commentCount).toBeGreaterThanOrEqual(1);

      tree!.delete();
    });
  });
});
