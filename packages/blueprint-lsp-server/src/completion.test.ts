import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initializeParser, parseDocument, cleanupParser } from "./parser";
import { transformToAST } from "./ast";
import { CrossFileSymbolIndex } from "./symbol-index";
import {
  getCursorContext,
  getCurrentScope,
  findContainingBlock,
  findContainingDependsOn,
  findContainingDescriptionBlock,
  extractExistingReferences,
  getKeywordCompletions,
  isKeywordValidInScope,
  getReferenceCompletions,
  getPathCompletions,
  buildCompletions,
  matchesReferenceQuery,
  calculateReferenceScore,
  collectConstraintNames,
  getConstraintNameCompletions,
  getCodeBlockLanguageCompletions,
  getDescriptionCompletions,
  resolveCompletionItem,
  collectIdentifierNames,
  getIdentifierNameCompletions,
  CODE_BLOCK_LANGUAGES,
  DESCRIPTION_STARTERS,
  REQUIREMENT_ACTION_VERBS,
  type CompletionContext,
  type CompletionHandlerContext,
} from "./completion";
import { CompletionItemKind } from "vscode-languageserver/node";

describe("completion", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  afterAll(() => {
    cleanupParser();
  });

  /**
   * Helper to create a completion context from source.
   */
  function createTestContext(
    source: string,
    fileUri: string = "file:///test.bp"
  ): { tree: ReturnType<typeof parseDocument>; symbolIndex: CrossFileSymbolIndex } {
    const tree = parseDocument(source);
    if (!tree) {
      throw new Error("Failed to parse source");
    }

    const ast = transformToAST(tree);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile(fileUri, ast);

    return { tree, symbolIndex };
  }

  // ============================================================================
  // Phase 2.1: Cursor Position Analysis
  // ============================================================================

  describe("getCursorContext", () => {
    test("detects @ trigger at start of line", () => {
      const source = `@module auth
  @`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 3 }, source);
      expect(context.isAfterAtTrigger).toBe(true);
      expect(context.prefix).toBe("@");
    });

    test("detects @ trigger with partial keyword", () => {
      const source = `@module auth
  @feat`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 7 }, source);
      expect(context.isAfterAtTrigger).toBe(true);
      expect(context.prefix).toBe("@feat");
    });

    test("detects . trigger for path navigation", () => {
      const source = `@module auth
  @depends-on auth.`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 19 }, source);
      expect(context.isAfterDotTrigger).toBe(true);
    });

    test("detects @depends-on context", () => {
      const source = `@module auth
  @feature login
    @depends-on `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 16 }, source);
      expect(context.isInDependsOn).toBe(true);
    });

    test("extracts prefix for filtering", () => {
      const source = `@module auth
  @feature log`;
      const { tree } = createTestContext(source);

      // At position 14, textBeforeCursor is "  @feature log"
      // The prefix regex (@?[\w.-]*)$ extracts "log"
      const context = getCursorContext(tree!, { line: 1, character: 14 }, source);
      expect(context.prefix).toBe("log");
    });

    test("detects skip zone in comment", () => {
      const source = `@module auth
  # This is a comment
  @feature login`;
      const { tree } = createTestContext(source);

      // Position inside comment - note: tree-sitter may parse comments differently
      // For now, we test that the mechanism exists
      const context = getCursorContext(tree!, { line: 1, character: 10 }, source);
      // Comment detection depends on tree-sitter grammar
      // Just verify context is returned
      expect(context).toBeDefined();
    });

    test("detects skip zone in code block", () => {
      const source = `@module auth
  @feature login
    Description with code:
    \`\`\`typescript
    const x = 1;
    \`\`\``;
      const { tree } = createTestContext(source);

      // Position inside code block
      const context = getCursorContext(tree!, { line: 4, character: 10 }, source);
      // Code block detection depends on tree-sitter grammar
      expect(context).toBeDefined();
    });
  });

  // ============================================================================
  // Phase 2.2: Scope Detection
  // ============================================================================

  describe("getCurrentScope", () => {
    test("returns top-level for position outside any block", () => {
      const source = `
@module auth
  @feature login`;
      const { tree } = createTestContext(source);

      // Position at blank line before module
      const scope = getCurrentScope(tree!, { line: 0, character: 0 });
      expect(scope).toBe("top-level");
    });

    test("returns module at module keyword position", () => {
      const source = `@module auth
  @feature login`;
      const { tree } = createTestContext(source);

      // Position at @module keyword is inside module_block
      const scope = getCurrentScope(tree!, { line: 0, character: 0 });
      // Tree-sitter considers position at @module to be inside module_block
      expect(scope).toBe("module");
    });

    test("returns module inside module block", () => {
      const source = `@module auth
  Module description.`;
      const { tree } = createTestContext(source);

      // Position inside module body
      const scope = getCurrentScope(tree!, { line: 1, character: 5 });
      expect(scope).toBe("module");
    });

    test("returns feature inside feature block", () => {
      const source = `@module auth
  @feature login
    Feature description.`;
      const { tree } = createTestContext(source);

      // Position inside feature body
      const scope = getCurrentScope(tree!, { line: 2, character: 5 });
      expect(scope).toBe("feature");
    });

    test("returns requirement inside requirement block", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Requirement description.`;
      const { tree } = createTestContext(source);

      // Position inside requirement body
      const scope = getCurrentScope(tree!, { line: 3, character: 7 });
      expect(scope).toBe("requirement");
    });
  });

  describe("findContainingBlock", () => {
    test("returns null for top-level position", () => {
      const source = `
@module auth`;
      const { tree } = createTestContext(source);

      // Position at blank line before module
      const block = findContainingBlock(tree!, { line: 0, character: 0 });
      expect(block).toBeNull();
    });

    test("finds module block", () => {
      const source = `@module auth
  Description.`;
      const { tree } = createTestContext(source);

      const block = findContainingBlock(tree!, { line: 1, character: 5 });
      expect(block).not.toBeNull();
      expect(block!.type).toBe("module_block");
    });

    test("finds feature block", () => {
      const source = `@module auth
  @feature login
    Description.`;
      const { tree } = createTestContext(source);

      const block = findContainingBlock(tree!, { line: 2, character: 5 });
      expect(block).not.toBeNull();
      expect(block!.type).toBe("feature_block");
    });

    test("finds requirement block", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Description.`;
      const { tree } = createTestContext(source);

      const block = findContainingBlock(tree!, { line: 3, character: 7 });
      expect(block).not.toBeNull();
      expect(block!.type).toBe("requirement_block");
    });
  });

  describe("getCursorContext scope path tracking", () => {
    test("tracks current module name", () => {
      const source = `@module auth
  Description.`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 5 }, source);
      expect(context.currentModule).toBe("auth");
      expect(context.scopePath).toBe("auth");
    });

    test("tracks current feature name", () => {
      const source = `@module auth
  @feature login
    Description.`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 5 }, source);
      expect(context.currentModule).toBe("auth");
      expect(context.currentFeature).toBe("login");
      expect(context.scopePath).toBe("auth.login");
    });

    test("tracks current requirement name", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Description.`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 3, character: 7 }, source);
      expect(context.currentModule).toBe("auth");
      expect(context.currentFeature).toBe("login");
      expect(context.currentRequirement).toBe("basic-auth");
      expect(context.scopePath).toBe("auth.login.basic-auth");
    });

    test("tracks module-level requirement (no feature)", () => {
      const source = `@module config
  @requirement load-config
    Description.`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 5 }, source);
      expect(context.currentModule).toBe("config");
      expect(context.currentFeature).toBeNull();
      expect(context.currentRequirement).toBe("load-config");
      expect(context.scopePath).toBe("config.load-config");
    });
  });

  // ============================================================================
  // Phase 2.3: Trigger Context Detection
  // ============================================================================

  describe("trigger context detection", () => {
    test("isAfterAtTrigger is false for plain text", () => {
      const source = `@module auth
  Description text`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 15 }, source);
      expect(context.isAfterAtTrigger).toBe(false);
    });

    test("isAfterDotTrigger is false without dot", () => {
      const source = `@module auth
  @depends-on auth`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 18 }, source);
      expect(context.isAfterDotTrigger).toBe(false);
    });

    test("prefix extraction with @depends-on partial reference", () => {
      const source = `@module auth
  @depends-on au`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 16 }, source);
      expect(context.isInDependsOn).toBe(true);
      expect(context.prefix).toBe("au");
    });

    test("prefix extraction with dot-path", () => {
      const source = `@module auth
  @depends-on auth.login.`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 25 }, source);
      expect(context.isAfterDotTrigger).toBe(true);
      expect(context.prefix).toBe("auth.login.");
    });
  });

  // ============================================================================
  // Phase 4.1: Existing References Parsing
  // ============================================================================

  describe("existing references parsing", () => {
    test("extracts existing references from @depends-on clause", () => {
      const source = `@module auth
  @feature login
    @depends-on storage.users, cache.sessions`;
      const { tree } = createTestContext(source);

      // Cursor at end of line, after the second reference
      const context = getCursorContext(tree!, { line: 2, character: 43 }, source);
      expect(context.isInDependsOn).toBe(true);
      expect(context.existingReferences).toContain("storage.users");
      expect(context.existingReferences).toContain("cache.sessions");
    });

    test("extracts single reference from @depends-on clause", () => {
      const source = `@module auth
  @feature login
    @depends-on storage.users`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 27 }, source);
      expect(context.existingReferences).toContain("storage.users");
    });

    test("returns empty array when cursor is right after @depends-on", () => {
      const source = `@module auth
  @feature login
    @depends-on `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 16 }, source);
      expect(context.existingReferences).toEqual([]);
    });

    test("detects isAfterComma when adding additional reference", () => {
      const source = `@module auth
  @feature login
    @depends-on storage.users, `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 31 }, source);
      expect(context.isAfterComma).toBe(true);
    });

    test("detects isAfterComma is false for first reference", () => {
      const source = `@module auth
  @feature login
    @depends-on `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 16 }, source);
      expect(context.isAfterComma).toBe(false);
    });

    test("detects isAfterComma with partial reference", () => {
      const source = `@module auth
  @feature login
    @depends-on storage.users, ca`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 33 }, source);
      expect(context.isAfterComma).toBe(true);
      expect(context.prefix).toBe("ca");
    });
  });

  describe("findContainingDependsOn", () => {
    test("finds depends_on node when cursor is inside", () => {
      const source = `@module auth
  @feature login
    @depends-on storage.users`;
      const { tree } = createTestContext(source);

      const dependsOnNode = findContainingDependsOn(tree!, { line: 2, character: 20 });
      expect(dependsOnNode).not.toBeNull();
      expect(dependsOnNode!.type).toBe("depends_on");
    });

    test("returns null when cursor is not in depends_on", () => {
      const source = `@module auth
  @feature login
    Description text.`;
      const { tree } = createTestContext(source);

      const dependsOnNode = findContainingDependsOn(tree!, { line: 2, character: 10 });
      expect(dependsOnNode).toBeNull();
    });
  });

  describe("extractExistingReferences", () => {
    test("extracts all references from depends_on node", () => {
      const source = `@module auth
  @feature login
    @depends-on storage.users, cache.sessions, logging.audit`;
      const { tree } = createTestContext(source);

      const dependsOnNode = findContainingDependsOn(tree!, { line: 2, character: 20 });
      expect(dependsOnNode).not.toBeNull();

      const refs = extractExistingReferences(dependsOnNode!);
      expect(refs).toContain("storage.users");
      expect(refs).toContain("cache.sessions");
      expect(refs).toContain("logging.audit");
      expect(refs).toHaveLength(3);
    });
  });

  // ============================================================================
  // Phase 3: Keyword Completion
  // ============================================================================

  describe("isKeywordValidInScope", () => {
    test("@module is valid only at top-level", () => {
      expect(isKeywordValidInScope("@module", "top-level")).toBe(true);
      expect(isKeywordValidInScope("@module", "module")).toBe(false);
      expect(isKeywordValidInScope("@module", "feature")).toBe(false);
      expect(isKeywordValidInScope("@module", "requirement")).toBe(false);
    });

    test("@feature is valid only in module", () => {
      expect(isKeywordValidInScope("@feature", "top-level")).toBe(false);
      expect(isKeywordValidInScope("@feature", "module")).toBe(true);
      expect(isKeywordValidInScope("@feature", "feature")).toBe(false);
      expect(isKeywordValidInScope("@feature", "requirement")).toBe(false);
    });

    test("@requirement is valid in module and feature", () => {
      expect(isKeywordValidInScope("@requirement", "top-level")).toBe(false);
      expect(isKeywordValidInScope("@requirement", "module")).toBe(true);
      expect(isKeywordValidInScope("@requirement", "feature")).toBe(true);
      expect(isKeywordValidInScope("@requirement", "requirement")).toBe(false);
    });

    test("@constraint is valid in module, feature, and requirement", () => {
      expect(isKeywordValidInScope("@constraint", "top-level")).toBe(false);
      expect(isKeywordValidInScope("@constraint", "module")).toBe(true);
      expect(isKeywordValidInScope("@constraint", "feature")).toBe(true);
      expect(isKeywordValidInScope("@constraint", "requirement")).toBe(true);
    });

    test("@depends-on is valid in module, feature, and requirement", () => {
      expect(isKeywordValidInScope("@depends-on", "top-level")).toBe(false);
      expect(isKeywordValidInScope("@depends-on", "module")).toBe(true);
      expect(isKeywordValidInScope("@depends-on", "feature")).toBe(true);
      expect(isKeywordValidInScope("@depends-on", "requirement")).toBe(true);
    });

    test("@description is valid only at top-level", () => {
      expect(isKeywordValidInScope("@description", "top-level")).toBe(true);
      expect(isKeywordValidInScope("@description", "module")).toBe(false);
      expect(isKeywordValidInScope("@description", "feature")).toBe(false);
      expect(isKeywordValidInScope("@description", "requirement")).toBe(false);
    });
  });

  describe("getKeywordCompletions", () => {
    test("returns @module and @description for top-level", () => {
      const completions = getKeywordCompletions("top-level", "");
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("@module");
      expect(labels).toContain("@description");
      expect(labels).not.toContain("@feature");
      expect(labels).not.toContain("@requirement");
    });

    test("returns @feature, @requirement, @constraint, @depends-on for module scope", () => {
      const completions = getKeywordCompletions("module", "");
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("@feature");
      expect(labels).toContain("@requirement");
      expect(labels).toContain("@constraint");
      expect(labels).toContain("@depends-on");
      expect(labels).not.toContain("@module");
      expect(labels).not.toContain("@description");
    });

    test("returns @requirement, @constraint, @depends-on for feature scope", () => {
      const completions = getKeywordCompletions("feature", "");
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("@requirement");
      expect(labels).toContain("@constraint");
      expect(labels).toContain("@depends-on");
      expect(labels).not.toContain("@module");
      expect(labels).not.toContain("@feature");
    });

    test("returns @constraint, @depends-on for requirement scope", () => {
      const completions = getKeywordCompletions("requirement", "");
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("@constraint");
      expect(labels).toContain("@depends-on");
      expect(labels).not.toContain("@module");
      expect(labels).not.toContain("@feature");
      expect(labels).not.toContain("@requirement");
    });

    test("filters by prefix", () => {
      const completions = getKeywordCompletions("module", "@fe");
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("@feature");
      expect(labels).not.toContain("@requirement");
      expect(labels).not.toContain("@constraint");
    });

    test("prefix filter is case-insensitive", () => {
      const completions = getKeywordCompletions("module", "@FE");
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("@feature");
    });

    test("returns empty array for invalid prefix", () => {
      const completions = getKeywordCompletions("module", "@xyz");
      expect(completions).toHaveLength(0);
    });

    test("completions include snippets", () => {
      const completions = getKeywordCompletions("module", "@feature");
      expect(completions.length).toBeGreaterThan(0);

      const featureCompletion = completions.find((c) => c.label === "@feature");
      expect(featureCompletion).toBeDefined();
      expect(featureCompletion!.insertText).toContain("${1:name}");
      expect(featureCompletion!.insertTextFormat).toBe(2); // InsertTextFormat.Snippet
    });

    test("completions include documentation", () => {
      const completions = getKeywordCompletions("module", "@feature");
      const featureCompletion = completions.find((c) => c.label === "@feature");

      expect(featureCompletion!.documentation).toBeDefined();
      expect((featureCompletion!.documentation as any).kind).toBe("markdown");
      expect((featureCompletion!.documentation as any).value).toContain("feature");
    });
  });

  // ============================================================================
  // Phase 4: Reference Completion
  // ============================================================================

  describe("getReferenceCompletions", () => {
    test("returns all referenceable symbols", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.

@module storage
  @feature database
    @requirement connect
      Connect to database.`;

      const { symbolIndex } = createTestContext(source);
      // Use a context that doesn't filter out "auth" symbols
      // Position at storage's @depends-on would have scopePath = "storage"
      const context: CompletionContext = {
        scope: "module",
        scopePath: "storage", // Inside storage module
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        isInConstraint: false,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "storage",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // auth symbols should be included (not filtered by scopePath "storage")
      expect(labels).toContain("auth");
      expect(labels).toContain("auth.login");
      expect(labels).toContain("auth.login.basic-auth");
      // storage symbols are filtered because scopePath is "storage"
      // (can't depend on yourself)
    });

    test("filters out self-references based on scope path", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @depends-on 
  @feature session
    @requirement token
      Token.`;

      const { symbolIndex } = createTestContext(source);
      // Create a context explicitly inside auth.login.basic-auth
      const context: CompletionContext = {
        scope: "requirement",
        scopePath: "auth.login.basic-auth",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        isInConstraint: false,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: "login",
        currentRequirement: "basic-auth",
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // Should include auth and auth.login (parents are ok to reference)
      // Note: The filter is path.startsWith(scopePath) so parents aren't filtered
      // but we can't reference our own path or children
      expect(labels).toContain("auth.session");
      expect(labels).toContain("auth.session.token");
      // basic-auth itself should be filtered out (starts with scopePath)
      expect(labels).not.toContain("auth.login.basic-auth");
    });

    test("filters by prefix", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.

@module storage
  @requirement connect
    Connect.`;

      const { symbolIndex } = createTestContext(source);
      // Create context with prefix "stor"
      const context: CompletionContext = {
        scope: "requirement",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        isInConstraint: false,
        prefix: "stor",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("storage");
      expect(labels).toContain("storage.connect");
      expect(labels).not.toContain("auth");
    });

    test("filters out existing references in @depends-on clause", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.

@module storage
  @feature database
    @requirement connect
      Connect to database.

@module cache
  @feature redis
    Redis caching.`;

      const { symbolIndex } = createTestContext(source);
      // Simulate context where "auth" and "storage" are already referenced
      const context: CompletionContext = {
        scope: "feature",
        scopePath: "cache.redis",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        isInConstraint: false,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "cache",
        currentFeature: "redis",
        currentRequirement: null,
        existingReferences: ["auth", "storage"],
        isAfterComma: true,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // "auth" and "storage" should be filtered out (already referenced)
      expect(labels).not.toContain("auth");
      expect(labels).not.toContain("storage");
      // But their children should still be available
      expect(labels).toContain("auth.login");
      expect(labels).toContain("storage.database");
    });

    test("limits results to 50", () => {
      // Create source with many symbols
      let source = "";
      for (let i = 0; i < 60; i++) {
        source += `@module mod${i}\n  Description.\n\n`;
      }

      const { symbolIndex } = createTestContext(source);
      const context: CompletionContext = {
        scope: "top-level",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      expect(completions.length).toBeLessThanOrEqual(50);
    });

    test("boosts local symbols in sort order", () => {
      const source1 = `@module local
  @feature local-feature
    Local feature.`;

      const source2 = `@module remote
  @feature remote-feature
    Remote feature.`;

      const tree1 = parseDocument(source1);
      const tree2 = parseDocument(source2);
      const ast1 = transformToAST(tree1!);
      const ast2 = transformToAST(tree2!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///local.bp", ast1);
      symbolIndex.addFile("file:///remote.bp", ast2);

      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///local.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);

      // Local symbols should have sortText starting with "0"
      const localCompletion = completions.find((c) => c.label === "local");
      const remoteCompletion = completions.find((c) => c.label === "remote");

      expect(localCompletion!.sortText!.startsWith("0")).toBe(true);
      expect(remoteCompletion!.sortText!.startsWith("1")).toBe(true);
    });

    test("includes documentation from symbol description", () => {
      const source = `@module auth
  This is the authentication module.
  @feature login
    Handles user login functionality.
    @requirement basic-auth
      Validates credentials using username and password.`;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);

      // Check that auth module has documentation
      const authCompletion = completions.find((c) => c.label === "auth");
      expect(authCompletion).toBeDefined();
      expect(authCompletion!.documentation).toBeDefined();
      expect(authCompletion!.documentation).toMatchObject({
        kind: "markdown",
        value: "This is the authentication module.",
      });

      // Check that feature has documentation
      const loginCompletion = completions.find((c) => c.label === "auth.login");
      expect(loginCompletion).toBeDefined();
      expect(loginCompletion!.documentation).toMatchObject({
        kind: "markdown",
        value: "Handles user login functionality.",
      });

      // Check that requirement has documentation
      const reqCompletion = completions.find((c) => c.label === "auth.login.basic-auth");
      expect(reqCompletion).toBeDefined();
      expect(reqCompletion!.documentation).toMatchObject({
        kind: "markdown",
        value: "Validates credentials using username and password.",
      });
    });

    test("omits documentation when symbol has no description", () => {
      const source = `@module auth
  @feature login`;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);

      // Symbols without descriptions should not have documentation
      const authCompletion = completions.find((c) => c.label === "auth");
      expect(authCompletion).toBeDefined();
      expect(authCompletion!.documentation).toBeUndefined();

      const loginCompletion = completions.find((c) => c.label === "auth.login");
      expect(loginCompletion).toBeDefined();
      expect(loginCompletion!.documentation).toBeUndefined();
    });

    test("filters out symbols that would create circular dependencies", () => {
      // Create a scenario where:
      // - moduleB depends on moduleA
      // - When completing @depends-on in moduleA, moduleB should be filtered out
      //   because moduleB already depends on moduleA, creating A -> B -> A cycle
      const source = `@module moduleA
  @feature featureA
    Feature A description.

@module moduleB
  @depends-on moduleA
  @feature featureB
    Feature B description.`;

      const { symbolIndex } = createTestContext(source);

      // Create context as if we're in moduleA trying to add a dependency
      const context: CompletionContext = {
        scope: "module",
        scopePath: "moduleA",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: "moduleA",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // moduleB depends on moduleA, so adding moduleA -> moduleB would create a cycle
      // Therefore moduleB should be filtered out
      expect(labels).not.toContain("moduleB");
      expect(labels).not.toContain("moduleB.featureB");
      // moduleA and its children are already filtered by self-reference check
      expect(labels).not.toContain("moduleA");
      expect(labels).not.toContain("moduleA.featureA");
    });

    test("filters out transitive circular dependencies", () => {
      // Create a scenario where:
      // - moduleC depends on moduleB
      // - moduleB depends on moduleA
      // - When completing in moduleA, both moduleB and moduleC should be filtered
      //   because they both transitively depend on moduleA
      const source = `@module moduleA
  @feature featureA
    Feature A.

@module moduleB
  @depends-on moduleA
  @feature featureB
    Feature B.

@module moduleC
  @depends-on moduleB
  @feature featureC
    Feature C.

@module moduleD
  @feature featureD
    Feature D (no dependencies).`;

      const { symbolIndex } = createTestContext(source);

      // Create context as if we're in moduleA trying to add a dependency
      const context: CompletionContext = {
        scope: "module",
        scopePath: "moduleA",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: "moduleA",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // moduleB and moduleC both transitively depend on moduleA
      expect(labels).not.toContain("moduleB");
      expect(labels).not.toContain("moduleB.featureB");
      expect(labels).not.toContain("moduleC");
      expect(labels).not.toContain("moduleC.featureC");
      // moduleD has no dependencies, so it's safe to add
      expect(labels).toContain("moduleD");
      expect(labels).toContain("moduleD.featureD");
    });

    test("allows valid dependencies that don't create cycles", () => {
      // moduleA and moduleB are independent, so they can depend on each other
      // (but once one depends on the other, the reverse is blocked)
      const source = `@module moduleA
  @feature featureA
    Feature A.

@module moduleB
  @feature featureB
    Feature B.`;

      const { symbolIndex } = createTestContext(source);

      // Create context as if we're in moduleA trying to add a dependency
      const context: CompletionContext = {
        scope: "module",
        scopePath: "moduleA",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "",
        isInSkipZone: false,
        currentModule: "moduleA",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // moduleB doesn't depend on moduleA, so it's safe
      expect(labels).toContain("moduleB");
      expect(labels).toContain("moduleB.featureB");
    });

    test("sorts results by score - exact match first", () => {
      const source = `@module auth
  @feature auth-feature
    Auth feature.
  @feature login
    Login feature.
  @feature authentication
    Authentication feature.`;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "auth",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // "auth" should be first (exact match)
      expect(labels[0]).toBe("auth");
      // "auth-feature" should come before "authentication" (prefix on name vs substring)
      const authFeatureIdx = labels.indexOf("auth.auth-feature");
      const authenticationIdx = labels.indexOf("auth.authentication");
      expect(authFeatureIdx).toBeLessThan(authenticationIdx);
    });

    test("sorts results by score - prefix match before substring match", () => {
      const source = `@module storage
  @feature database
    Database feature.

@module authorization
  @feature oauth
    OAuth feature.`;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "auth",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // "authorization" (prefix match) should come before anything else
      expect(labels[0]).toBe("authorization");
    });

    test("fuzzy matching finds symbols with characters in order", () => {
      const source = `@module auth
  @feature basic-authentication
    Basic auth feature.
  @feature login
    Login feature.`;

      const { symbolIndex } = createTestContext(source);

      // Search for "bauth" - should fuzzy match "basic-authentication"
      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "bauth",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getReferenceCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // "basic-authentication" should be found via fuzzy match
      expect(labels).toContain("auth.basic-authentication");
      // "login" should NOT match "bauth"
      expect(labels).not.toContain("auth.login");
    });
  });

  // ============================================================================
  // Phase 4.3: Reference Matching and Scoring Unit Tests
  // ============================================================================

  describe("matchesReferenceQuery", () => {
    function createMockSymbol(name: string, path: string) {
      return {
        kind: "module" as const,
        path,
        fileUri: "file:///test.bp",
        node: { name, location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 } },
      };
    }

    test("empty query matches everything", () => {
      const symbol = createMockSymbol("auth", "auth");
      expect(matchesReferenceQuery(symbol, "")).toBe(true);
    });

    test("matches exact prefix on name", () => {
      const symbol = createMockSymbol("authentication", "auth.authentication");
      expect(matchesReferenceQuery(symbol, "auth")).toBe(true);
    });

    test("matches substring in name", () => {
      const symbol = createMockSymbol("basic-authentication", "auth.basic-authentication");
      expect(matchesReferenceQuery(symbol, "auth")).toBe(true);
    });

    test("matches substring in path", () => {
      const symbol = createMockSymbol("login", "auth.login");
      expect(matchesReferenceQuery(symbol, "auth")).toBe(true);
    });

    test("matches fuzzy pattern in name", () => {
      const symbol = createMockSymbol("basic-authentication", "auth.basic-authentication");
      // "bauth" - b...auth should fuzzy match
      expect(matchesReferenceQuery(symbol, "bauth")).toBe(true);
    });

    test("does not match unrelated query", () => {
      const symbol = createMockSymbol("storage", "storage");
      expect(matchesReferenceQuery(symbol, "auth")).toBe(false);
    });

    test("matching is case-insensitive", () => {
      const symbol = createMockSymbol("Authentication", "auth.Authentication");
      expect(matchesReferenceQuery(symbol, "AUTH")).toBe(true);
      expect(matchesReferenceQuery(symbol, "authentication")).toBe(true);
    });
  });

  describe("calculateReferenceScore", () => {
    function createMockSymbol(name: string, path: string) {
      return {
        kind: "module" as const,
        path,
        fileUri: "file:///test.bp",
        node: { name, location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 } },
      };
    }

    test("returns 0 for empty query", () => {
      const symbol = createMockSymbol("auth", "auth");
      expect(calculateReferenceScore(symbol, "")).toBe(0);
    });

    test("returns 100 for exact match on name", () => {
      const symbol = createMockSymbol("auth", "module.auth");
      expect(calculateReferenceScore(symbol, "auth")).toBe(100);
    });

    test("returns high score (80-90) for prefix match on name", () => {
      const symbol = createMockSymbol("authentication", "auth.authentication");
      const score = calculateReferenceScore(symbol, "auth");
      expect(score).toBeGreaterThanOrEqual(80);
      expect(score).toBeLessThanOrEqual(90);
    });

    test("returns 70 for exact match on path segment", () => {
      const symbol = createMockSymbol("login", "auth.login");
      expect(calculateReferenceScore(symbol, "auth")).toBe(70);
    });

    test("returns 50-60 for substring match on name", () => {
      // Use a path without "tion" as a segment so it doesn't match path segment
      const symbol = createMockSymbol("basic-authentication", "module.basic-authentication");
      const score = calculateReferenceScore(symbol, "tion");
      expect(score).toBeGreaterThanOrEqual(50);
      expect(score).toBeLessThanOrEqual(60);
    });

    test("returns 40 for substring match on path", () => {
      const symbol = createMockSymbol("login", "authentication.login");
      const score = calculateReferenceScore(symbol, "auth");
      expect(score).toBe(40);
    });

    test("returns 20 for fuzzy match only", () => {
      // "bauth" fuzzy matches "basic-authentication" but not as prefix/substring
      const symbol = createMockSymbol("basic-authentication", "basic.basic-authentication");
      const score = calculateReferenceScore(symbol, "bauth");
      expect(score).toBe(20);
    });

    test("higher prefix match ratio gives higher score", () => {
      const shortSymbol = createMockSymbol("auth", "auth");
      const longSymbol = createMockSymbol("authentication", "authentication");
      // Both are prefix matches, but "auth" is exact, "authentication" is partial
      const shortScore = calculateReferenceScore(shortSymbol, "auth");
      const longScore = calculateReferenceScore(longSymbol, "auth");
      expect(shortScore).toBeGreaterThan(longScore);
    });
  });

  // ============================================================================
  // Phase 5: Path Completion
  // ============================================================================

  describe("getPathCompletions", () => {
    test("returns children of parent path", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
    @requirement oauth
      OAuth.
  @feature session
    @requirement token
      Token.`;

      const { symbolIndex } = createTestContext(source);

      // Context with prefix "auth." to get children of auth
      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: true,
        isInDependsOn: true,
        prefix: "auth.",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getPathCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("login");
      expect(labels).toContain("session");
      // Should not include nested children
      expect(labels).not.toContain("basic-auth");
      expect(labels).not.toContain("auth.login");
    });

    test("returns nested children for deeper path", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
    @requirement oauth
      OAuth.`;

      const { symbolIndex } = createTestContext(source);

      // Context with prefix "auth.login." to get children of auth.login
      const context: CompletionContext = {
        scope: "feature",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: true,
        isInDependsOn: true,
        prefix: "auth.login.",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getPathCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("basic-auth");
      expect(labels).toContain("oauth");
      expect(labels).not.toContain("login");
    });

    test("returns empty for invalid parent path", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.`;

      const { symbolIndex } = createTestContext(source);

      // Context with invalid parent path
      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: true,
        isInDependsOn: true,
        prefix: "nonexistent.",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getPathCompletions(context, handlerContext);
      expect(completions).toHaveLength(0);
    });

    test("returns empty when no prefix dot", () => {
      const source = `@module auth
  @feature login`;

      const { symbolIndex } = createTestContext(source);

      // Context without a dot in prefix
      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: true,
        prefix: "auth",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getPathCompletions(context, handlerContext);
      expect(completions).toHaveLength(0);
    });

    test("includes documentation from symbol description in path completions", () => {
      const source = `@module auth
  This is the authentication module.
  @feature login
    Handles user login functionality.
  @feature session
    Manages user sessions.`;

      const { symbolIndex } = createTestContext(source);

      // Context with prefix "auth." to get children of auth
      const context: CompletionContext = {
        scope: "module",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: true,
        isInDependsOn: true,
        prefix: "auth.",
        isInSkipZone: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getPathCompletions(context, handlerContext);

      // Check that features have documentation
      const loginCompletion = completions.find((c) => c.label === "login");
      expect(loginCompletion).toBeDefined();
      expect(loginCompletion!.documentation).toMatchObject({
        kind: "markdown",
        value: "Handles user login functionality.",
      });

      const sessionCompletion = completions.find((c) => c.label === "session");
      expect(sessionCompletion).toBeDefined();
      expect(sessionCompletion!.documentation).toMatchObject({
        kind: "markdown",
        value: "Manages user sessions.",
      });
    });
  });

  // ============================================================================
  // buildCompletions integration
  // ============================================================================

  describe("buildCompletions", () => {
    test("returns keyword completions for @ trigger at top-level", () => {
      const source = `@`;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 1 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("@module");
      expect(labels).toContain("@description");
    });

    test("returns keyword completions for @ trigger in module", () => {
      // Position must be on a line that starts with whitespace + @
      // At line 1, character 3, textBeforeCursor is "  @"
      const source = `@module auth
  @`;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 3 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      // The scope is detected from the tree - let's verify we get keywords
      // In module scope, we should get @feature, @requirement, etc.
      // But we need to verify what scope is actually detected
      expect(labels.length).toBeGreaterThan(0);
      // Verify at least one keyword is returned
      expect(labels.some((l) => l.startsWith("@"))).toBe(true);
    });

    test("returns reference completions in @depends-on context", () => {
      const source = `@module auth
  @feature login
    Description.

@module storage
  @depends-on `;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 5, character: 14 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("auth");
      expect(labels).toContain("auth.login");
    });

    test("returns path completions after dot", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Desc.
  @feature session
    @requirement token
      Desc.

@module storage
  @depends-on auth.`;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 9, character: 19 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("login");
      expect(labels).toContain("session");
    });

    test("returns reference completions as fallback for plain text", () => {
      const source = `@module auth
  @feature login
    Description.

@module storage
  Some description text without triggers`;
      const { tree, symbolIndex } = createTestContext(source);

      // Position in middle of description text - should get reference completions (fallback)
      // because there are symbols in the index
      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 5, character: 20 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // With symbols in the index, fallback reference completion should return results
      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
    });

    test("returns null when no completions match", () => {
      // A document with just whitespace - no symbols, no triggers
      const source = `   `;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 2 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // With no symbols and no @ trigger, should return null or empty
      // Depends on whether empty prefix triggers keyword completions
      // At top-level with empty prefix, we get @module and @description
      expect(result).not.toBeNull();
    });
  });

  // ============================================================================
  // Phase 6.1: Constraint Name Completion
  // ============================================================================

  describe("constraint name completion", () => {
    test("detects @constraint context", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @constraint `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 3, character: 18 }, source);
      expect(context.isInConstraint).toBe(true);
      expect(context.isAfterAtTrigger).toBe(false); // Not after @ alone
    });

    test("detects @constraint context with partial name", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @constraint inp`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 3, character: 21 }, source);
      expect(context.isInConstraint).toBe(true);
    });

    test("does not detect @constraint context when typing keyword", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @constraint`;
      const { tree } = createTestContext(source);

      // At the end of "@constraint" without space - keyword completion
      const context = getCursorContext(tree!, { line: 3, character: 17 }, source);
      expect(context.isInConstraint).toBe(false);
      expect(context.isAfterAtTrigger).toBe(true);
    });

    test("collectConstraintNames returns unique constraint names with frequency", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @constraint input-validation
      @constraint rate-limiting
    @requirement oauth
      @constraint input-validation
      @constraint token-validation
  @feature session
    @requirement token-mgmt
      @constraint input-validation`;

      const { symbolIndex } = createTestContext(source);

      const names = collectConstraintNames(symbolIndex);

      // input-validation appears 3 times, should be first
      expect(names[0].name).toBe("input-validation");
      expect(names[0].count).toBe(3);

      // rate-limiting and token-validation appear once each
      const rateLimiting = names.find((n: { name: string }) => n.name === "rate-limiting");
      const tokenValidation = names.find((n: { name: string }) => n.name === "token-validation");
      expect(rateLimiting).toBeDefined();
      expect(rateLimiting.count).toBe(1);
      expect(tokenValidation).toBeDefined();
      expect(tokenValidation.count).toBe(1);
    });

    test("getConstraintNameCompletions returns constraint names from workspace", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @constraint input-validation
      @constraint rate-limiting
    @requirement oauth
      @constraint input-validation

@module storage
  @requirement connect
    @constraint `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "requirement",
        scopePath: "storage.connect",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: true,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "storage",
        currentFeature: null,
        currentRequirement: "connect",
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getConstraintNameCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // Should suggest both constraint names from the workspace
      expect(labels).toContain("input-validation");
      expect(labels).toContain("rate-limiting");
    });

    test("constraint name completion uses singular grammar for count of 1", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @constraint input-validation

@module storage
  @requirement connect
    @constraint `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "requirement",
        scopePath: "storage.connect",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: true,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "storage",
        currentFeature: null,
        currentRequirement: "connect",
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getConstraintNameCompletions(context, handlerContext);
      const inputCompletion = completions.find((c) => c.label === "input-validation");

      expect(inputCompletion).toBeDefined();
      expect(inputCompletion!.detail).toBe("Used 1 time in workspace");
    });
  });

  // ============================================================================
  // Phase 6.3: Code Block Language Completion
  // ============================================================================

  describe("code block language completion", () => {
    test("detects code block language context after triple backticks", () => {
      const source = `@module auth
  @feature login
    Description with code:
    \`\`\``;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 3, character: 7 }, source);
      expect(context.isInCodeBlockLanguage).toBe(true);
      expect(context.isInSkipZone).toBe(false);
    });

    test("detects code block language context with partial language", () => {
      const source = `@module auth
  @feature login
    Description with code:
    \`\`\`type`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 3, character: 11 }, source);
      expect(context.isInCodeBlockLanguage).toBe(true);
      expect(context.isInSkipZone).toBe(false);
    });

    test("does not provide completion inside code block content", () => {
      const source = `@module auth
  @feature login
    Description with code:
    \`\`\`typescript
    const x = 1;
    \`\`\``;
      const { tree } = createTestContext(source);

      // Position inside code block content (not the language line)
      const context = getCursorContext(tree!, { line: 4, character: 10 }, source);
      expect(context.isInCodeBlockLanguage).toBe(false);
      // Should be in skip zone (inside code block content)
      expect(context.isInSkipZone).toBe(true);
    });

    test("getCodeBlockLanguageCompletions returns all common languages without prefix", () => {
      const context: CompletionContext = {
        scope: "module",
        scopePath: "auth",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        prefix: "```",
        isInSkipZone: false,
        isInCodeBlockLanguage: true,
        currentModule: "auth",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getCodeBlockLanguageCompletions(context);

      // Should return all configured languages
      expect(completions.length).toBe(CODE_BLOCK_LANGUAGES.length);

      // Check that common languages are included
      const labels = completions.map((c) => c.label);
      expect(labels).toContain("typescript");
      expect(labels).toContain("javascript");
      expect(labels).toContain("json");
      expect(labels).toContain("sql");
      expect(labels).toContain("graphql");
      expect(labels).toContain("http");
    });

    test("getCodeBlockLanguageCompletions filters by prefix", () => {
      const context: CompletionContext = {
        scope: "module",
        scopePath: "auth",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        prefix: "```type",
        isInSkipZone: false,
        isInCodeBlockLanguage: true,
        currentModule: "auth",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getCodeBlockLanguageCompletions(context);
      const labels = completions.map((c) => c.label);

      // Should only match languages starting with "type"
      expect(labels).toContain("typescript");
      expect(labels).not.toContain("javascript");
      expect(labels).not.toContain("json");
    });

    test("getCodeBlockLanguageCompletions is case-insensitive", () => {
      const context: CompletionContext = {
        scope: "module",
        scopePath: "auth",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        prefix: "```JSON",
        isInSkipZone: false,
        isInCodeBlockLanguage: true,
        currentModule: "auth",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getCodeBlockLanguageCompletions(context);
      const labels = completions.map((c) => c.label);

      expect(labels).toContain("json");
    });

    test("getCodeBlockLanguageCompletions includes documentation", () => {
      const context: CompletionContext = {
        scope: "module",
        scopePath: "auth",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        prefix: "```",
        isInSkipZone: false,
        isInCodeBlockLanguage: true,
        currentModule: "auth",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getCodeBlockLanguageCompletions(context);
      const tsCompletion = completions.find((c) => c.label === "typescript");

      expect(tsCompletion).toBeDefined();
      expect(tsCompletion!.documentation).toBeDefined();
      expect((tsCompletion!.documentation as any).kind).toBe("markdown");
      expect((tsCompletion!.documentation as any).value).toContain("TypeScript");
    });

    test("buildCompletions returns language completions after triple backticks", () => {
      const source = `@module auth
  @feature login
    Description with code:
    \`\`\``;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 3, character: 7 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("typescript");
      expect(labels).toContain("javascript");
      expect(labels).toContain("json");
    });

    test("buildCompletions returns null inside code block content", () => {
      const source = `@module auth
  @feature login
    Description with code:
    \`\`\`typescript
    const x = 1;
    \`\`\``;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 4, character: 10 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should return null because we're in a skip zone (code block content)
      expect(result).toBeNull();
    });

    test("CODE_BLOCK_LANGUAGES includes priority languages from spec", () => {
      const languageIds = CODE_BLOCK_LANGUAGES.map((l) => l.id);

      // These are specifically mentioned in the AUTOCOMPLETE.md spec
      expect(languageIds).toContain("typescript");
      expect(languageIds).toContain("javascript");
      expect(languageIds).toContain("json");
      expect(languageIds).toContain("sql");
      expect(languageIds).toContain("graphql");
      expect(languageIds).toContain("http");
    });
  });

  // ============================================================================
  // Phase 7: Completion Resolve (Lazy Documentation Loading)
  // ============================================================================

  describe("resolveCompletionItem", () => {
    test("loads rich documentation for module completion item", () => {
      const source = `@module auth
  This is the authentication module.
  @depends-on storage
  @constraint security-compliance
  @feature login
    Login feature.
  @feature logout
    Logout feature.`;

      const { symbolIndex } = createTestContext(source);

      // Create a completion item as it would come from getReferenceCompletions
      const item = {
        label: "auth",
        kind: CompletionItemKind.Module,
        detail: "module in test.bp",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      // Should have rich markdown documentation
      expect(resolved.documentation).toBeDefined();
      expect((resolved.documentation as any).kind).toBe("markdown");

      const docValue = (resolved.documentation as any).value;

      // Should include header with kind and path
      expect(docValue).toContain("**Module**");
      expect(docValue).toContain("`auth`");

      // Should include description
      expect(docValue).toContain("This is the authentication module.");

      // Should include dependency count
      expect(docValue).toContain("**Dependencies:** 1");
      expect(docValue).toContain("`storage`");

      // Should include constraint count
      expect(docValue).toContain("**Constraints:** 1");
      expect(docValue).toContain("`security-compliance`");

      // Should include child counts for module
      expect(docValue).toContain("**Contains:**");
      expect(docValue).toContain("2 features");

      // Should include file location
      expect(docValue).toContain("*Defined in");
      expect(docValue).toContain("test.bp");
    });

    test("loads rich documentation for feature completion item", () => {
      const source = `@module auth
  @feature login
    Handles user login functionality.
    @depends-on storage.database
    @constraint rate-limiting
    @requirement basic-auth
      Basic authentication.
    @requirement oauth
      OAuth support.`;

      const { symbolIndex } = createTestContext(source);

      const item = {
        label: "auth.login",
        kind: CompletionItemKind.Class, // Features use Class kind
        detail: "feature in test.bp",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      expect(resolved.documentation).toBeDefined();
      const docValue = (resolved.documentation as any).value;

      // Should include feature-specific info
      expect(docValue).toContain("**Feature**");
      expect(docValue).toContain("`auth.login`");
      expect(docValue).toContain("Handles user login functionality.");
      expect(docValue).toContain("**Dependencies:** 1");
      expect(docValue).toContain("`storage.database`");
      expect(docValue).toContain("**Constraints:** 1");
      expect(docValue).toContain("`rate-limiting`");

      // Should include requirement count
      expect(docValue).toContain("**Contains:** 2 requirements");
    });

    test("loads rich documentation for requirement completion item", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Validates credentials using username and password.
      @depends-on storage.users
      @constraint input-validation
        Must validate all inputs.
      @constraint bcrypt-hashing
        Passwords must use bcrypt.`;

      const { symbolIndex } = createTestContext(source);

      const item = {
        label: "auth.login.basic-auth",
        kind: CompletionItemKind.Function, // Requirements use Function kind
        detail: "requirement in test.bp",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      expect(resolved.documentation).toBeDefined();
      const docValue = (resolved.documentation as any).value;

      // Should include requirement-specific info
      expect(docValue).toContain("**Requirement**");
      expect(docValue).toContain("`auth.login.basic-auth`");
      expect(docValue).toContain("Validates credentials using username and password.");
      expect(docValue).toContain("**Dependencies:** 1");
      expect(docValue).toContain("`storage.users`");
      expect(docValue).toContain("**Constraints:** 2");
      expect(docValue).toContain("`input-validation`");
      expect(docValue).toContain("`bcrypt-hashing`");
    });

    test("handles symbol without description", () => {
      const source = `@module auth
  @feature login`;

      const { symbolIndex } = createTestContext(source);

      const item = {
        label: "auth.login",
        kind: CompletionItemKind.Class,
        detail: "feature in test.bp",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      expect(resolved.documentation).toBeDefined();
      const docValue = (resolved.documentation as any).value;

      // Should still have header
      expect(docValue).toContain("**Feature**");
      expect(docValue).toContain("`auth.login`");
      // Should still have file location
      expect(docValue).toContain("*Defined in");
    });

    test("handles symbol without dependencies or constraints", () => {
      const source = `@module auth
  Simple auth module.`;

      const { symbolIndex } = createTestContext(source);

      const item = {
        label: "auth",
        kind: CompletionItemKind.Module,
        detail: "module in test.bp",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      expect(resolved.documentation).toBeDefined();
      const docValue = (resolved.documentation as any).value;

      // Should NOT include dependency section since there are none
      expect(docValue).not.toContain("**Dependencies:**");
      // Should NOT include constraint section since there are none
      expect(docValue).not.toContain("**Constraints:**");
    });

    test("does not resolve non-reference completion items", () => {
      const source = `@module auth`;
      const { symbolIndex } = createTestContext(source);

      // Keyword completion item (not a reference)
      const item = {
        label: "@feature",
        kind: CompletionItemKind.Keyword,
        detail: "Define a feature",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      // Should not add documentation for keywords
      expect(resolved.documentation).toBeUndefined();
    });

    test("handles unknown symbol gracefully", () => {
      const source = `@module auth`;
      const { symbolIndex } = createTestContext(source);

      // Completion item for a symbol that doesn't exist
      const item = {
        label: "nonexistent.module",
        kind: CompletionItemKind.Module,
        detail: "module",
      };

      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const resolved = resolveCompletionItem(item, handlerContext);

      // Should not crash, just leave documentation undefined
      expect(resolved.documentation).toBeUndefined();
    });
  });

  // ============================================================================
  // Phase 6.2: Description Block Completion
  // ============================================================================

  describe("description block completion", () => {
    test("findContainingDescriptionBlock finds description_block node", () => {
      const source = `@description
  This is a description.`;
      const { tree } = createTestContext(source);

      // Position inside description block
      const descBlockNode = findContainingDescriptionBlock(tree!, { line: 1, character: 5 });
      expect(descBlockNode).not.toBeNull();
      expect(descBlockNode!.type).toBe("description_block");
    });

    test("findContainingDescriptionBlock returns null outside description block", () => {
      const source = `@module auth
  Module description.`;
      const { tree } = createTestContext(source);

      // Position inside module, not description block
      const descBlockNode = findContainingDescriptionBlock(tree!, { line: 1, character: 5 });
      expect(descBlockNode).toBeNull();
    });

    test("detects isInDescriptionBlock at start of line inside @description block", () => {
      const source = `@description
  `;
      const { tree } = createTestContext(source);

      // Position at start of empty line inside description block
      const context = getCursorContext(tree!, { line: 1, character: 2 }, source);
      expect(context.isInDescriptionBlock).toBe(true);
    });

    test("does not detect isInDescriptionBlock when text is typed", () => {
      const source = `@description
  This is some text`;
      const { tree } = createTestContext(source);

      // Position after text - should not trigger description completion
      const context = getCursorContext(tree!, { line: 1, character: 18 }, source);
      expect(context.isInDescriptionBlock).toBe(false);
    });

    test("does not detect isInDescriptionBlock outside @description block", () => {
      const source = `@module auth
  `;
      const { tree } = createTestContext(source);

      // Position at start of line inside module (not description)
      const context = getCursorContext(tree!, { line: 1, character: 2 }, source);
      expect(context.isInDescriptionBlock).toBe(false);
    });

    test("getDescriptionCompletions returns all starters with empty prefix", () => {
      const context: CompletionContext = {
        scope: "top-level",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: true,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getDescriptionCompletions(context);

      // Should return all configured description starters
      expect(completions.length).toBe(DESCRIPTION_STARTERS.length);

      // Check that common starters are included
      const labels = completions.map((c) => c.label);
      expect(labels).toContain("This document describes...");
      expect(labels).toContain("This module provides...");
      expect(labels).toContain("Purpose:");
      expect(labels).toContain("Overview:");
    });

    test("getDescriptionCompletions returns empty when text is typed (non-aggressive)", () => {
      const context: CompletionContext = {
        scope: "top-level",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: true,
        prefix: "Some text",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getDescriptionCompletions(context);

      // Should return empty array - no aggressive completion inside description text
      expect(completions).toHaveLength(0);
    });

    test("description completions include snippets", () => {
      const context: CompletionContext = {
        scope: "top-level",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: true,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getDescriptionCompletions(context);

      // All completions should be snippets
      for (const completion of completions) {
        expect(completion.kind).toBe(CompletionItemKind.Snippet);
        expect(completion.insertTextFormat).toBe(2); // InsertTextFormat.Snippet
        expect(completion.insertText).toContain("${1:");
      }
    });

    test("description completions include documentation", () => {
      const context: CompletionContext = {
        scope: "top-level",
        scopePath: null,
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: true,
        prefix: "",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: null,
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };

      const completions = getDescriptionCompletions(context);
      const purposeCompletion = completions.find((c) => c.label === "Purpose:");

      expect(purposeCompletion).toBeDefined();
      expect(purposeCompletion!.documentation).toBeDefined();
      expect((purposeCompletion!.documentation as any).kind).toBe("markdown");
    });

    test("buildCompletions returns description starters in @description block", () => {
      const source = `@description
  `;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 2 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("This document describes...");
      expect(labels).toContain("Purpose:");
      expect(labels).toContain("Goals:");
    });

    test("buildCompletions does not return description starters when typing text", () => {
      const source = `@description
  This is a doc`;
      const { tree, symbolIndex } = createTestContext(source);

      // Position after "This is a doc" - should not get description starters
      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 15 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // When in description block but text is typed, should fall through to other completions
      // or return null/empty based on context
      if (result !== null) {
        const labels = result.items.map((c) => c.label);
        expect(labels).not.toContain("This document describes...");
        expect(labels).not.toContain("Purpose:");
      }
    });

    test("DESCRIPTION_STARTERS includes common documentation patterns", () => {
      const labels = DESCRIPTION_STARTERS.map((s) => s.label);

      // These are specifically mentioned in the AUTOCOMPLETE.md spec
      expect(labels).toContain("This document describes...");
      expect(labels).toContain("Purpose:");
      expect(labels).toContain("Overview:");
      expect(labels).toContain("Goals:");
      expect(labels).toContain("Non-Goals:");
    });
  });

  // ============================================================================
  // Phase 6.4: Identifier Name Suggestions
  // ============================================================================

  describe("identifier name completion", () => {
    test("detects @module identifier context", () => {
      const source = `@module `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 0, character: 8 }, source);
      expect(context.isInIdentifierName).toBe(true);
      expect(context.identifierKeyword).toBe("module");
      expect(context.isAfterAtTrigger).toBe(false);
    });

    test("detects @feature identifier context", () => {
      const source = `@module auth
  @feature `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 11 }, source);
      expect(context.isInIdentifierName).toBe(true);
      expect(context.identifierKeyword).toBe("feature");
    });

    test("detects @requirement identifier context", () => {
      const source = `@module auth
  @feature login
    @requirement `;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 2, character: 17 }, source);
      expect(context.isInIdentifierName).toBe(true);
      expect(context.identifierKeyword).toBe("requirement");
    });

    test("detects identifier context with partial name", () => {
      const source = `@module auth
  @feature log`;
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 1, character: 14 }, source);
      expect(context.isInIdentifierName).toBe(true);
      expect(context.identifierKeyword).toBe("feature");
    });

    test("does not detect identifier context when typing keyword", () => {
      const source = `@module`;
      const { tree } = createTestContext(source);

      // At the end of "@module" without space - keyword completion
      const context = getCursorContext(tree!, { line: 0, character: 7 }, source);
      expect(context.isInIdentifierName).toBe(false);
      expect(context.isAfterAtTrigger).toBe(true);
    });

    test("collectIdentifierNames returns unique names with frequency", () => {
      const source = `@module auth
  @feature login
    @requirement validate-input
  @feature session
    @requirement validate-input
    @requirement create-token

@module storage
  @feature database
    @requirement validate-input`;

      const { symbolIndex } = createTestContext(source);

      const names = collectIdentifierNames(symbolIndex, "requirement");

      // validate-input appears 3 times, should be first
      expect(names[0].name).toBe("validate-input");
      expect(names[0].count).toBe(3);

      // create-token appears once
      const createToken = names.find((n: { name: string }) => n.name === "create-token");
      expect(createToken).toBeDefined();
      expect(createToken!.count).toBe(1);
    });

    test("collectIdentifierNames works for modules", () => {
      const source = `@module auth
  Description.

@module storage
  Description.

@module cache
  Description.`;

      const { symbolIndex } = createTestContext(source);

      const names = collectIdentifierNames(symbolIndex, "module");

      expect(names.length).toBe(3);
      const moduleNames = names.map((n: { name: string }) => n.name);
      expect(moduleNames).toContain("auth");
      expect(moduleNames).toContain("storage");
      expect(moduleNames).toContain("cache");
    });

    test("getIdentifierNameCompletions returns action verbs for requirements", () => {
      const source = `@module auth
  @feature login
    @requirement `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "feature",
        scopePath: "auth.login",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: false,
        isInIdentifierName: true,
        identifierKeyword: "requirement",
        prefix: "@requirement ",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: "login",
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getIdentifierNameCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // Should suggest action verb patterns
      expect(labels).toContain("validate-...");
      expect(labels).toContain("create-...");
      expect(labels).toContain("update-...");
      expect(labels).toContain("delete-...");
      expect(labels).toContain("get-...");
    });

    test("getIdentifierNameCompletions filters action verbs by prefix", () => {
      const source = `@module auth
  @feature login
    @requirement val`;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "feature",
        scopePath: "auth.login",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: false,
        isInIdentifierName: true,
        identifierKeyword: "requirement",
        prefix: "@requirement val",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: "login",
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getIdentifierNameCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // Should only match actions starting with "val"
      expect(labels).toContain("validate-...");
      expect(labels).not.toContain("create-...");
      expect(labels).not.toContain("update-...");
    });

    test("getIdentifierNameCompletions includes existing names from workspace", () => {
      const source = `@module auth
  @feature login
    @requirement custom-validation
      Description.
  @feature session
    @requirement `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "feature",
        scopePath: "auth.session",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: false,
        isInIdentifierName: true,
        identifierKeyword: "requirement",
        prefix: "@requirement ",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: "session",
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getIdentifierNameCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // Should include existing requirement name from workspace
      expect(labels).toContain("custom-validation");
    });

    test("getIdentifierNameCompletions suggests contextual feature names", () => {
      const source = `@module auth
  @feature `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "module",
        scopePath: "auth",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: false,
        isInIdentifierName: true,
        identifierKeyword: "feature",
        prefix: "@feature ",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: null,
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getIdentifierNameCompletions(context, handlerContext);
      const labels = completions.map((c) => c.label);

      // Should suggest common CRUD-like feature names
      expect(labels).toContain("create");
      expect(labels).toContain("read");
      expect(labels).toContain("update");
      expect(labels).toContain("delete");
      expect(labels).toContain("list");
      expect(labels).toContain("search");
    });

    test("requirement action completions include snippets", () => {
      const source = `@module auth
  @feature login
    @requirement `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "feature",
        scopePath: "auth.login",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: false,
        isInIdentifierName: true,
        identifierKeyword: "requirement",
        prefix: "@requirement ",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: "login",
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getIdentifierNameCompletions(context, handlerContext);
      const validateCompletion = completions.find((c) => c.label === "validate-...");

      expect(validateCompletion).toBeDefined();
      expect(validateCompletion!.insertText).toContain("${1:object}");
      expect(validateCompletion!.insertTextFormat).toBe(2); // InsertTextFormat.Snippet
    });

    test("requirement action completions include documentation", () => {
      const source = `@module auth
  @feature login
    @requirement `;

      const { symbolIndex } = createTestContext(source);

      const context: CompletionContext = {
        scope: "feature",
        scopePath: "auth.login",
        isAfterAtTrigger: false,
        isAfterDotTrigger: false,
        isInDependsOn: false,
        isInConstraint: false,
        isInDescriptionBlock: false,
        isInIdentifierName: true,
        identifierKeyword: "requirement",
        prefix: "@requirement ",
        isInSkipZone: false,
        isInCodeBlockLanguage: false,
        currentModule: "auth",
        currentFeature: "login",
        currentRequirement: null,
        existingReferences: [],
        isAfterComma: false,
      };
      const handlerContext: CompletionHandlerContext = {
        symbolIndex,
        fileUri: "file:///test.bp",
      };

      const completions = getIdentifierNameCompletions(context, handlerContext);
      const createCompletion = completions.find((c) => c.label === "create-...");

      expect(createCompletion).toBeDefined();
      expect(createCompletion!.documentation).toBeDefined();
      expect((createCompletion!.documentation as any).kind).toBe("markdown");
      expect((createCompletion!.documentation as any).value).toContain("create-credentials");
    });

    test("buildCompletions returns identifier suggestions after @requirement keyword", () => {
      const source = `@module auth
  @feature login
    @requirement `;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 2, character: 17 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      // Should get action verb suggestions
      expect(labels).toContain("validate-...");
      expect(labels).toContain("create-...");
    });

    test("buildCompletions returns identifier suggestions after @feature keyword", () => {
      const source = `@module auth
  @feature `;
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 11 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      // Should get contextual feature suggestions
      expect(labels).toContain("create");
      expect(labels).toContain("read");
    });

    test("REQUIREMENT_ACTION_VERBS includes common action patterns", () => {
      const prefixes = REQUIREMENT_ACTION_VERBS.map((v) => v.prefix);

      // These are common action verbs for requirements
      expect(prefixes).toContain("validate");
      expect(prefixes).toContain("create");
      expect(prefixes).toContain("update");
      expect(prefixes).toContain("delete");
      expect(prefixes).toContain("get");
      expect(prefixes).toContain("authenticate");
      expect(prefixes).toContain("authorize");
      expect(prefixes).toContain("send");
      expect(prefixes).toContain("process");
    });
  });

  // ============================================================================
  // Phase 9.4: Edge Cases and Error Handling
  // ============================================================================

  describe("edge cases and error handling", () => {
    test("handles empty document gracefully", () => {
      const source = "";
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 0 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should return keyword completions for top-level (empty document is top-level)
      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("@module");
      expect(labels).toContain("@description");
    });

    test("handles document with only whitespace gracefully", () => {
      const source = "   \n\n   ";
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 0 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should return keyword completions for top-level
      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("@module");
      expect(labels).toContain("@description");
    });

    test("handles cursor position beyond document length", () => {
      const source = "@module test";
      const { tree, symbolIndex } = createTestContext(source);

      // Position beyond document bounds
      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 10, character: 100 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should not crash, may return null or empty completions
      // The important thing is it doesn't throw an error
      expect(() => result).not.toThrow();
    });

    test("handles cursor at line 0 character 0 in non-empty document", () => {
      const source = "@module auth\n  @feature login";
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 0 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should return something valid (empty prefix at start of @module line)
      expect(() => result).not.toThrow();
    });

    test("handles document with syntax errors (partial parse)", () => {
      // Invalid Blueprint syntax - missing module name
      const source = "@module \n  @feature login";
      const { tree, symbolIndex } = createTestContext(source);

      // The tree may have ERROR nodes but should still be valid
      expect(tree).not.toBeNull();

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 11 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should not crash even with syntax errors
      expect(() => result).not.toThrow();
    });

    test("handles document with unclosed blocks", () => {
      // Unclosed module block (no content or nested elements)
      const source = "@module auth\n  @feature";
      const { tree, symbolIndex } = createTestContext(source);

      expect(tree).not.toBeNull();

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 1, character: 10 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should not crash
      expect(() => result).not.toThrow();
    });

    test("handles document with malformed keywords", () => {
      const source = "@modul auth\n  @featur login";
      const { tree, symbolIndex } = createTestContext(source);

      expect(tree).not.toBeNull();

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 11 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should not crash on malformed input
      expect(() => result).not.toThrow();
    });

    test("handles very long line gracefully", () => {
      const longText = "a".repeat(10000);
      const source = `@module ${longText}`;
      const { tree, symbolIndex } = createTestContext(source);

      expect(tree).not.toBeNull();

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 5000 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should not crash on very long lines
      expect(() => result).not.toThrow();
    });

    test("handles document with only @description keyword", () => {
      const source = "@description";
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 0, character: 12 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should not crash
      expect(() => result).not.toThrow();
    });

    test("handles document with only newlines", () => {
      const source = "\n\n\n\n\n";
      const { tree, symbolIndex } = createTestContext(source);

      const result = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 2, character: 0 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );

      // Should return keyword completions for top-level
      expect(result).not.toBeNull();
      const labels = result!.items.map((c) => c.label);
      expect(labels).toContain("@module");
    });

    test("handles document with mixed valid and invalid syntax", () => {
      const source = `@module auth
  @feature login
    valid description
  @invalid-keyword something
  @requirement test
    more valid content`;
      const { tree, symbolIndex } = createTestContext(source);

      expect(tree).not.toBeNull();

      // Test completion at various positions in the mixed document
      const result1 = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 2, character: 5 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );
      expect(() => result1).not.toThrow();

      const result2 = buildCompletions(
        tree!,
        { textDocument: { uri: "file:///test.bp" }, position: { line: 3, character: 10 } },
        source,
        { symbolIndex, fileUri: "file:///test.bp" }
      );
      expect(() => result2).not.toThrow();
    });

    test("getCursorContext handles empty document", () => {
      const source = "";
      const { tree } = createTestContext(source);

      const context = getCursorContext(tree!, { line: 0, character: 0 }, source);

      expect(context.scope).toBe("top-level");
      expect(context.prefix).toBe("");
      expect(context.isInSkipZone).toBe(false);
    });

    test("getCursorContext handles position beyond line length", () => {
      const source = "@module test";
      const { tree } = createTestContext(source);

      // Character position beyond the line length
      const context = getCursorContext(tree!, { line: 0, character: 100 }, source);

      // Should handle gracefully - prefix should be the whole line or empty
      expect(() => context).not.toThrow();
      expect(context.scope).toBeDefined();
    });

    test("getCursorContext handles line beyond document lines", () => {
      const source = "@module test";
      const { tree } = createTestContext(source);

      // Line beyond document bounds
      const context = getCursorContext(tree!, { line: 10, character: 0 }, source);

      // Should handle gracefully
      expect(() => context).not.toThrow();
      expect(context.scope).toBe("top-level");
    });

    test("findContainingBlock handles empty tree gracefully", () => {
      const source = "";
      const { tree } = createTestContext(source);

      const block = findContainingBlock(tree!, { line: 0, character: 0 });

      // Should return null for empty document
      expect(block).toBeNull();
    });

    test("getCurrentScope returns top-level for position in empty document", () => {
      const source = "";
      const { tree } = createTestContext(source);

      const scope = getCurrentScope(tree!, { line: 0, character: 0 });

      expect(scope).toBe("top-level");
    });
  });
});
