import { describe, test, expect, beforeAll } from "bun:test";
import { initializeParser, parseDocument } from "./parser";
import {
  buildSemanticTokens,
  buildRequirementStatusMap,
  semanticTokensLegend,
  TokenTypes,
  TokenModifiers,
  type RequirementHighlightStatus,
} from "./semantic-tokens";
import { SemanticTokenTypes, SemanticTokenModifiers } from "vscode-languageserver/node";
import type { RequirementTicketMap, RequirementTicketInfo } from "./requirement-ticket-map";
import type { BlockingStatusResult, BlockingInfo } from "./blocking-status";

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
        "noTicket",
        "blocked",
        "inProgress",
        "complete",
        "obsolete",
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
      expect(TokenModifiers.noTicket).toBe(4);
      expect(TokenModifiers.blocked).toBe(8);
      expect(TokenModifiers.inProgress).toBe(16);
      expect(TokenModifiers.complete).toBe(32);
      expect(TokenModifiers.obsolete).toBe(64);
    });

    test("can be combined", () => {
      const combined = TokenModifiers.declaration | TokenModifiers.definition;
      expect(combined).toBe(3);
    });

    test("status modifiers can be combined with declaration", () => {
      const combined =
        TokenModifiers.declaration | TokenModifiers.definition | TokenModifiers.complete;
      expect(combined).toBe(1 | 2 | 32);
      expect(combined).toBe(35);
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
      const featureToken = decoded.find((t) => t.line === 2 && t.tokenType === TokenTypes.keyword);
      expect(featureToken).toBeDefined();
      expect(featureToken!.length).toBe(8); // "@feature"

      // Find the feature identifier
      const featureId = decoded.find((t) => t.line === 2 && t.tokenType === TokenTypes.variable);
      expect(featureId).toBeDefined();
      expect(featureId!.length).toBe(5); // "login"

      tree!.delete();
    });

    test("tokenizes @requirement keyword", () => {
      const tree = parseDocument("@module m\n\n@feature f\n\n  @requirement basic-auth");
      expect(tree).not.toBeNull();
      const tokens = buildSemanticTokens(tree!);
      const decoded = decodeTokens(tokens.data);

      // Find the @requirement token
      const reqToken = decoded.find((t) => t.tokenType === TokenTypes.keyword && t.length === 12);
      expect(reqToken).toBeDefined();
      expect(reqToken!.length).toBe(12); // "@requirement"

      tree!.delete();
    });

    test("tokenizes @depends-on keyword and references", () => {
      const tree = parseDocument("@module m\n\n@feature f\n  @depends-on other.module");
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
      const commentToken = decoded.find((t) => t.tokenType === TokenTypes.comment);
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
      const commentTokens = decoded.filter((t) => t.tokenType === TokenTypes.comment);
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
      expect(idToken!.tokenModifiers).toBe(TokenModifiers.declaration | TokenModifiers.definition);

      tree!.delete();
    });

    test("reference identifiers have no modifiers", () => {
      const tree = parseDocument("@module m\n\n@feature f\n  @depends-on other.ref");
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
      const keywordCount = decoded.filter((t) => t.tokenType === TokenTypes.keyword).length;
      const variableCount = decoded.filter((t) => t.tokenType === TokenTypes.variable).length;
      const typeCount = decoded.filter((t) => t.tokenType === TokenTypes.type).length;
      const commentCount = decoded.filter((t) => t.tokenType === TokenTypes.comment).length;

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

    describe("progress-based highlighting", () => {
      test("applies no-ticket modifier when status map provided but requirement not found", () => {
        const tree = parseDocument("@module m\n\n@feature f\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        // Empty status map - requirement not found means no ticket
        const statusMap = new Map<string, RequirementHighlightStatus>();
        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.noTicket);

        // Find the requirement identifier
        const reqId = decoded.find(
          (t) => t.tokenType === TokenTypes.variable && t.length === 10 // "basic-auth"
        );
        expect(reqId).toBeDefined();
        expect(reqId!.tokenModifiers).toBe(
          TokenModifiers.declaration | TokenModifiers.definition | TokenModifiers.noTicket
        );

        tree!.delete();
      });

      test("applies complete modifier for complete requirements", () => {
        const tree = parseDocument("@module auth\n\n@feature login\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.login.basic-auth", "complete");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.complete);

        tree!.delete();
      });

      test("applies in-progress modifier for in-progress requirements", () => {
        const tree = parseDocument("@module auth\n\n@feature login\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.login.basic-auth", "in-progress");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.inProgress);

        tree!.delete();
      });

      test("applies blocked modifier for blocked requirements", () => {
        const tree = parseDocument("@module auth\n\n@feature login\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.login.basic-auth", "blocked");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.blocked);

        tree!.delete();
      });

      test("applies obsolete modifier for obsolete requirements", () => {
        const tree = parseDocument("@module auth\n\n@feature login\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.login.basic-auth", "obsolete");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.obsolete);

        tree!.delete();
      });

      test("applies no modifier for pending requirements (default)", () => {
        const tree = parseDocument("@module auth\n\n@feature login\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.login.basic-auth", "pending");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.none);

        tree!.delete();
      });

      test("without status map, no status modifiers are applied", () => {
        const tree = parseDocument("@module auth\n\n@feature login\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        // No status map passed
        const tokens = buildSemanticTokens(tree!);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.none);

        tree!.delete();
      });

      test("handles multiple requirements with different statuses", () => {
        const tree = parseDocument(`@module auth

@feature login

  @requirement basic-auth
    Users can log in

  @requirement oauth
    OAuth support`);
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.login.basic-auth", "complete");
        statusMap.set("auth.login.oauth", "in-progress");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find all @requirement keyword tokens
        const reqKeywords = decoded.filter(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeywords.length).toBe(2);

        // First requirement should be complete
        expect(reqKeywords[0]!.tokenModifiers).toBe(TokenModifiers.complete);

        // Second requirement should be in-progress
        expect(reqKeywords[1]!.tokenModifiers).toBe(TokenModifiers.inProgress);

        tree!.delete();
      });

      test("handles requirement directly under module (no feature)", () => {
        const tree = parseDocument("@module auth\n\n  @requirement basic-auth");
        expect(tree).not.toBeNull();

        const statusMap = new Map<string, RequirementHighlightStatus>();
        statusMap.set("auth.basic-auth", "complete");

        const tokens = buildSemanticTokens(tree!, statusMap);
        const decoded = decodeTokens(tokens.data);

        // Find the @requirement keyword token
        const reqKeyword = decoded.find(
          (t) => t.tokenType === TokenTypes.keyword && t.length === 12
        );
        expect(reqKeyword).toBeDefined();
        expect(reqKeyword!.tokenModifiers).toBe(TokenModifiers.complete);

        tree!.delete();
      });
    });
  });

  describe("buildRequirementStatusMap", () => {
    // Helper to create mock RequirementTicketInfo
    function mockTicketInfo(
      path: string,
      status: "no-ticket" | "pending" | "in-progress" | "complete" | "obsolete"
    ): RequirementTicketInfo {
      return {
        requirementPath: path,
        requirement: {} as any,
        tickets: [],
        status,
        constraintStatuses: [],
        constraintsSatisfied: 0,
        constraintsTotal: 0,
        implementationFiles: [],
        testFiles: [],
      };
    }

    test("converts ticket statuses to highlight statuses", () => {
      const ticketMap: RequirementTicketMap = new Map();
      ticketMap.set("auth.login.basic", mockTicketInfo("auth.login.basic", "complete"));
      ticketMap.set("auth.login.oauth", mockTicketInfo("auth.login.oauth", "in-progress"));
      ticketMap.set("auth.login.2fa", mockTicketInfo("auth.login.2fa", "pending"));
      ticketMap.set("auth.login.old", mockTicketInfo("auth.login.old", "obsolete"));
      ticketMap.set("auth.login.new", mockTicketInfo("auth.login.new", "no-ticket"));

      const statusMap = buildRequirementStatusMap(ticketMap);

      expect(statusMap.get("auth.login.basic")).toBe("complete");
      expect(statusMap.get("auth.login.oauth")).toBe("in-progress");
      expect(statusMap.get("auth.login.2fa")).toBe("pending");
      expect(statusMap.get("auth.login.old")).toBe("obsolete");
      expect(statusMap.get("auth.login.new")).toBe("no-ticket");
    });

    test("blocked status from blocking info takes precedence", () => {
      const ticketMap: RequirementTicketMap = new Map();
      ticketMap.set("auth.login.basic", mockTicketInfo("auth.login.basic", "pending"));

      const blockingStatus: BlockingStatusResult = {
        blockingInfo: new Map<string, BlockingInfo>([
          [
            "auth.login.basic",
            {
              status: "blocked",
              directBlockers: [{ path: "storage.users", status: "pending" }],
              transitiveBlockers: [],
            },
          ],
        ]),
        blockedRequirements: ["auth.login.basic"],
        requirementsInCycles: [],
        unblockedRequirements: [],
      };

      const statusMap = buildRequirementStatusMap(ticketMap, blockingStatus);

      // Should be blocked, not pending
      expect(statusMap.get("auth.login.basic")).toBe("blocked");
    });

    test("in-cycle status is treated as blocked", () => {
      const ticketMap: RequirementTicketMap = new Map();
      ticketMap.set("auth.a", mockTicketInfo("auth.a", "pending"));

      const blockingStatus: BlockingStatusResult = {
        blockingInfo: new Map<string, BlockingInfo>([
          [
            "auth.a",
            {
              status: "in-cycle",
              directBlockers: [],
              transitiveBlockers: [],
              cycleInfo: {
                cycle: { cycle: ["auth.a", "auth.b", "auth.a"], edges: [] },
                cyclePeers: ["auth.b"],
              },
            },
          ],
        ]),
        blockedRequirements: [],
        requirementsInCycles: ["auth.a"],
        unblockedRequirements: [],
      };

      const statusMap = buildRequirementStatusMap(ticketMap, blockingStatus);

      expect(statusMap.get("auth.a")).toBe("blocked");
    });

    test("not-blocked status does not override ticket status", () => {
      const ticketMap: RequirementTicketMap = new Map();
      ticketMap.set("auth.login.basic", mockTicketInfo("auth.login.basic", "in-progress"));

      const blockingStatus: BlockingStatusResult = {
        blockingInfo: new Map<string, BlockingInfo>([
          [
            "auth.login.basic",
            {
              status: "not-blocked",
              directBlockers: [],
              transitiveBlockers: [],
            },
          ],
        ]),
        blockedRequirements: [],
        requirementsInCycles: [],
        unblockedRequirements: ["auth.login.basic"],
      };

      const statusMap = buildRequirementStatusMap(ticketMap, blockingStatus);

      // Should keep in-progress status
      expect(statusMap.get("auth.login.basic")).toBe("in-progress");
    });
  });
});
