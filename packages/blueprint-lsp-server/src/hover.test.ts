import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initializeParser, parseDocument, cleanupParser } from "./parser";
import { transformToAST } from "./ast";
import { CrossFileSymbolIndex } from "./symbol-index";
import { DependencyGraph } from "./dependency-graph";
import { buildRequirementTicketMapFromSymbols } from "./requirement-ticket-map";
import type { TicketFile } from "./tickets";
import {
  findNodeAtPosition,
  findHoverTarget,
  buildHoverContent,
  buildHover,
  formatFileLink,
  type HoverContext,
} from "./hover";

describe("hover", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  afterAll(() => {
    cleanupParser();
  });

  /**
   * Helper to create a hover context from source and optional tickets.
   */
  function createHoverContext(
    source: string,
    fileUri: string = "file:///test.bp",
    tickets: TicketFile | null = null
  ): { tree: ReturnType<typeof parseDocument>; context: HoverContext } {
    const tree = parseDocument(source);
    if (!tree) {
      throw new Error("Failed to parse source");
    }

    const ast = transformToAST(tree);
    const symbolIndex = new CrossFileSymbolIndex();
    symbolIndex.addFile(fileUri, ast);

    const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
    const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);

    const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

    return {
      tree,
      context: {
        symbolIndex,
        ticketMap,
        dependencyGraph,
        cycles,
        fileUri,
      },
    };
  }

  describe("findNodeAtPosition", () => {
    test("finds node at the beginning of a module keyword", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const node = findNodeAtPosition(tree!, { line: 0, character: 0 });
      expect(node).not.toBeNull();
      expect(node!.text).toBe("@module");
    });

    test("finds identifier node when hovering over module name", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      // Position on "auth"
      const node = findNodeAtPosition(tree!, { line: 0, character: 8 });
      expect(node).not.toBeNull();
      expect(node!.type).toBe("identifier");
      expect(node!.text).toBe("auth");
    });

    test("finds node in deeply nested structure", () => {
      const source = `@module auth
  Auth module.
  
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic authentication.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      // Position on "basic-auth"
      const node = findNodeAtPosition(tree!, { line: 6, character: 17 });
      expect(node).not.toBeNull();
      expect(node!.type).toBe("identifier");
      expect(node!.text).toBe("basic-auth");
    });

    test("returns null for position outside document", () => {
      const source = `@module auth`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const node = findNodeAtPosition(tree!, { line: 100, character: 0 });
      expect(node).toBeNull();
    });
  });

  describe("findHoverTarget", () => {
    test("finds module target when hovering over module identifier", () => {
      const source = `@module auth
  Authentication module.`;
      const { tree, context } = createHoverContext(source);

      const target = findHoverTarget(
        tree!,
        { line: 0, character: 8 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("module");
      expect(target!.path).toBe("auth");
    });

    test("finds feature target when hovering over feature identifier", () => {
      const source = `@module auth
  Auth module.
  
  @feature login
    Login feature.`;
      const { tree, context } = createHoverContext(source);

      // Position on "login"
      const target = findHoverTarget(
        tree!,
        { line: 3, character: 11 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("feature");
      expect(target!.path).toBe("auth.login");
    });

    test("finds requirement target when hovering over requirement identifier", () => {
      const source = `@module auth
  Auth module.
  
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic authentication.`;
      const { tree, context } = createHoverContext(source);

      // Position on "basic-auth"
      const target = findHoverTarget(
        tree!,
        { line: 6, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("requirement");
      expect(target!.path).toBe("auth.login.basic-auth");
    });

    test("finds constraint target when hovering over constraint identifier", () => {
      const source = `@module auth
  Auth module.
  
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic authentication.
      
      @constraint bcrypt-cost
        Use bcrypt with cost >= 12.`;
      const { tree, context } = createHoverContext(source);

      // Position on "bcrypt-cost"
      const target = findHoverTarget(
        tree!,
        { line: 9, character: 18 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("constraint");
      expect(target!.path).toBe("auth.login.basic-auth.bcrypt-cost");
    });

    test("finds reference target in depends-on", () => {
      const source = `@module auth
  Auth module.
  
  @feature login
    @depends-on auth
    Login feature.`;
      const { tree, context } = createHoverContext(source);

      // Position on the reference "auth" in depends-on
      const target = findHoverTarget(
        tree!,
        { line: 4, character: 16 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("reference");
      expect(target!.path).toBe("auth");
    });

    test("finds keyword target when hovering over @module keyword", () => {
      const source = `@module auth
  Authentication module.`;
      const { tree, context } = createHoverContext(source);

      const target = findHoverTarget(
        tree!,
        { line: 0, character: 0 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("keyword");
    });
  });

  describe("buildHoverContent", () => {
    describe("requirement hover", () => {
      test("shows no tickets message when requirement has no tickets", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.`;
        const { tree, context } = createHoverContext(source);

        const target = findHoverTarget(
          tree!,
          { line: 2, character: 17 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();

        const content = buildHoverContent(target!, context);
        expect(content).not.toBeNull();
        expect(content!.value).toContain("@requirement basic-auth");
        expect(content!.value).toContain("No tickets");
      });

      test("shows ticket information when requirement has tickets", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.
      
      @constraint bcrypt-cost
        Use bcrypt.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "in-progress",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 2, character: 17 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();

        const content = buildHoverContent(target!, context);
        expect(content).not.toBeNull();
        expect(content!.value).toContain("TKT-001");
        expect(content!.value).toContain("in progress");
        expect(content!.value).toContain("0/1 satisfied");
      });

      test("shows constraint satisfaction details", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.
      
      @constraint bcrypt-cost
        Use bcrypt.
      
      @constraint audit-log
        Log attempts.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: ["bcrypt-cost"],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 2, character: 17 },
          context.symbolIndex,
          context.fileUri
        );
        const content = buildHoverContent(target!, context);

        expect(content!.value).toContain("1/2 satisfied");
        expect(content!.value).toContain("\u2713 bcrypt-cost"); // checkmark
        expect(content!.value).toContain("\u25CB audit-log"); // empty circle
      });

      test("shows implementation files when present", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: [],
              implementation: {
                files: ["src/auth/login.ts"],
                tests: ["tests/auth/login.test.ts"],
              },
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 2, character: 17 },
          context.symbolIndex,
          context.fileUri
        );
        const content = buildHoverContent(target!, context);

        expect(content!.value).toContain("src/auth/login.ts");
        expect(content!.value).toContain("tests/auth/login.test.ts");
      });
    });

    describe("feature hover", () => {
      test("shows progress summary", () => {
        const source = `@module auth
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic auth.
    
    @requirement oauth
      OAuth login.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: [],
            },
            {
              id: "TKT-002",
              ref: "auth.login.oauth",
              description: "Implement OAuth",
              status: "pending",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 1, character: 11 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("feature");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("1/2 requirements complete");
        expect(content!.value).toContain("50%");
      });

      test("shows requirement list with statuses", () => {
        const source = `@module auth
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic auth.
    
    @requirement oauth
      OAuth login.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 1, character: 11 },
          context.symbolIndex,
          context.fileUri
        );
        const content = buildHoverContent(target!, context);

        expect(content!.value).toContain("basic-auth");
        expect(content!.value).toContain("oauth");
      });
    });

    describe("module hover", () => {
      test("shows aggregate progress", () => {
        const source = `@module auth
  Auth module.
  
  @feature login
    @requirement basic-auth
      Basic auth.
  
  @feature session
    @requirement token
      Session token.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 0, character: 8 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("module");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("1/2 requirements complete");
      });

      test("shows status breakdown", () => {
        const source = `@module auth
  Auth module.
  
  @feature login
    @requirement basic-auth
      Basic auth.
    @requirement oauth
      OAuth.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: [],
            },
            {
              id: "TKT-002",
              ref: "auth.login.oauth",
              description: "OAuth",
              status: "in-progress",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 0, character: 8 },
          context.symbolIndex,
          context.fileUri
        );
        const content = buildHoverContent(target!, context);

        expect(content!.value).toContain("Complete: 1");
        expect(content!.value).toContain("In progress: 1");
      });

      test("shows features list with per-feature progress", () => {
        const source = `@module auth
  Auth module.
  
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic auth.
    
    @requirement oauth
      OAuth login.
  
  @feature session
    Session management.
    
    @requirement create-token
      Create session token.
    
    @requirement refresh-token
      Refresh session token.
    
    @requirement logout
      Logout and invalidate session.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: [],
            },
            {
              id: "TKT-002",
              ref: "auth.login.oauth",
              description: "Implement OAuth",
              status: "complete",
              constraints_satisfied: [],
            },
            {
              id: "TKT-003",
              ref: "auth.session.create-token",
              description: "Create token",
              status: "complete",
              constraints_satisfied: [],
            },
            {
              id: "TKT-004",
              ref: "auth.session.refresh-token",
              description: "Refresh token",
              status: "in-progress",
              constraints_satisfied: [],
            },
            {
              id: "TKT-005",
              ref: "auth.session.logout",
              description: "Logout",
              status: "pending",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 0, character: 8 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("module");

        const content = buildHoverContent(target!, context);
        expect(content).not.toBeNull();

        // Should show Features section
        expect(content!.value).toContain("**Features:**");

        // Should list both features with their progress
        // login: 2/2 complete (basic-auth and oauth both complete)
        expect(content!.value).toContain("login: 2/2 complete");

        // session: 1/3 complete (only create-token is complete)
        expect(content!.value).toContain("session: 1/3 complete");
      });

      test("does not show features section when module has no features", () => {
        // A module with only module-level requirements (no features)
        const source = `@module config
  Configuration module.
  
  @requirement load-config
    Load configuration from file.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "config.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "config.load-config",
              description: "Load config",
              status: "pending",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 0, character: 8 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("module");

        const content = buildHoverContent(target!, context);
        expect(content).not.toBeNull();

        // Should NOT show Features section
        expect(content!.value).not.toContain("**Features:**");

        // Should still show progress for the module-level requirement
        expect(content!.value).toContain("0/1 requirements complete");
      });
    });

    describe("constraint hover", () => {
      test("shows satisfied status when constraint is met", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
      
      @constraint bcrypt-cost
        Use bcrypt.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "complete",
              constraints_satisfied: ["bcrypt-cost"],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 5, character: 18 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("constraint");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("Satisfied");
        expect(content!.value).toContain("TKT-001");
      });

      test("shows not satisfied when constraint is not met", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
      
      @constraint bcrypt-cost
        Use bcrypt.`;

        const tickets: TicketFile = {
          version: "1.0",
          source: "auth.bp",
          tickets: [
            {
              id: "TKT-001",
              ref: "auth.login.basic-auth",
              description: "Implement basic auth",
              status: "in-progress",
              constraints_satisfied: [],
            },
          ],
        };

        const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

        const target = findHoverTarget(
          tree!,
          { line: 5, character: 18 },
          context.symbolIndex,
          context.fileUri
        );
        const content = buildHoverContent(target!, context);

        expect(content!.value).toContain("Not satisfied");
      });
    });

    describe("reference hover", () => {
      test("shows resolved reference information", () => {
        const source = `@module auth
  Auth module.

@module payments
  @depends-on auth
  Payments require auth.`;

        const { tree, context } = createHoverContext(source);

        // Position on "auth" in depends-on
        const target = findHoverTarget(
          tree!,
          { line: 4, character: 14 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("reference");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("module: auth");
      });

      test("shows unresolved reference warning", () => {
        const source = `@module auth
  @depends-on nonexistent
  Auth module.`;

        const { tree, context } = createHoverContext(source);

        const target = findHoverTarget(
          tree!,
          { line: 1, character: 14 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("reference");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("Unresolved reference");
        expect(content!.value).toContain("nonexistent");
      });
    });

    describe("keyword hover", () => {
      test("shows keyword documentation for @module", () => {
        const source = `@module auth
  Auth module.`;

        const { tree, context } = createHoverContext(source);

        const target = findHoverTarget(
          tree!,
          { line: 0, character: 0 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("keyword");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("Blueprint DSL Keyword");
        expect(content!.value).toContain("@module");
        expect(content!.value).toContain("@feature");
        expect(content!.value).toContain("@requirement");
      });

      test("shows keyword documentation for @depends-on", () => {
        const source = `@module auth
  Auth module.
  
  @feature login
    @depends-on auth
    Login feature.`;

        const { tree, context } = createHoverContext(source);

        // Position on "@depends-on" keyword (line 4, character 4 is the start of @depends-on)
        const target = findHoverTarget(
          tree!,
          { line: 4, character: 4 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("keyword");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("Blueprint DSL Keyword");
        expect(content!.value).toContain("@depends-on");
        expect(content!.value).toContain("Dependencies on other elements");
      });

      test("shows keyword documentation for @constraint", () => {
        const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
      
      @constraint bcrypt-cost
        Use bcrypt.`;

        const { tree, context } = createHoverContext(source);

        // Position on "@constraint" keyword (line 5, character 6)
        const target = findHoverTarget(
          tree!,
          { line: 5, character: 6 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("keyword");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("Blueprint DSL Keyword");
        expect(content!.value).toContain("@constraint");
        expect(content!.value).toContain("Implementation requirements");
      });
    });
  });

  describe("buildHover", () => {
    test("returns Hover object with content and range", () => {
      const source = `@module auth
  Authentication module.`;

      const { tree, context } = createHoverContext(source);

      const target = findHoverTarget(
        tree!,
        { line: 0, character: 8 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();

      const hover = buildHover(target!, context);
      expect(hover).not.toBeNull();
      expect(hover!.contents).toBeDefined();
      expect(hover!.range).toBeDefined();
      expect(hover!.range!.start.line).toBe(0);
      expect(hover!.range!.start.character).toBe(8);
    });

    test("returns null for unknown target types", () => {
      const source = `@module auth`;
      const { context } = createHoverContext(source);

      // Create a target with an unknown kind
      const target = {
        kind: "unknown" as any,
        range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 5 },
      };

      const hover = buildHover(target as any, context);
      expect(hover).toBeNull();
    });
  });

  describe("blocking status in hover", () => {
    test("shows circular dependency warning when requirement is in a cycle", () => {
      // Create a circular dependency: A depends on B, B depends on A
      const source = `@module auth
  @feature login
    @requirement basic-auth
      @depends-on auth.login.oauth
      Basic auth.
    
    @requirement oauth
      @depends-on auth.login.basic-auth
      OAuth login.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.login.oauth",
            description: "Implement OAuth",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      // Hover over basic-auth requirement (which is in the cycle)
      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("requirement");
      expect(target!.path).toBe("auth.login.basic-auth");

      const content = buildHoverContent(target!, context);
      expect(content).not.toBeNull();

      // Should show circular dependency warning
      expect(content!.value).toContain("Part of circular dependency");
      // Should show the cycle path with arrow notation
      expect(content!.value).toContain("Cycle:");
      // The cycle should include both requirements
      expect(content!.value).toContain("auth.login.basic-auth");
      expect(content!.value).toContain("auth.login.oauth");
    });

    test("shows circular dependency for all requirements in the cycle", () => {
      // Create a 3-node cycle: A -> B -> C -> A
      const source = `@module auth
  @feature flow
    @requirement step-a
      @depends-on auth.flow.step-c
      Step A.
    
    @requirement step-b
      @depends-on auth.flow.step-a
      Step B.
    
    @requirement step-c
      @depends-on auth.flow.step-b
      Step C.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.flow.step-a",
            description: "Step A",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.flow.step-b",
            description: "Step B",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-003",
            ref: "auth.flow.step-c",
            description: "Step C",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      // All three requirements should show they're in a cycle
      for (const [line, _reqName] of [
        [2, "step-a"],
        [6, "step-b"],
        [10, "step-c"],
      ] as const) {
        const target = findHoverTarget(
          tree!,
          { line, character: 17 },
          context.symbolIndex,
          context.fileUri
        );
        expect(target).not.toBeNull();
        expect(target!.kind).toBe("requirement");

        const content = buildHoverContent(target!, context);
        expect(content!.value).toContain("Part of circular dependency");
        expect(content!.value).toContain("Cycle:");
      }
    });

    test("shows blocked status when dependency is not complete", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
    
    @requirement oauth
      @depends-on auth.login.basic-auth
      OAuth needs basic auth first.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.login.oauth",
            description: "Implement OAuth",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      // Hover over oauth requirement
      const target = findHoverTarget(
        tree!,
        { line: 5, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();

      const content = buildHoverContent(target!, context);
      expect(content!.value).toContain("Blocked");
      expect(content!.value).toContain("auth.login.basic-auth");
    });

    test("shows completed dependencies", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
    
    @requirement oauth
      @depends-on auth.login.basic-auth
      OAuth needs basic auth first.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "complete",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.login.oauth",
            description: "Implement OAuth",
            status: "in-progress",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      // Hover over oauth requirement
      const target = findHoverTarget(
        tree!,
        { line: 5, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("Dependencies");
      expect(content!.value).toContain("\u2713"); // checkmark for completed dep
    });

    test("truncates transitive blockers when more than 3", () => {
      // Create a chain: final-step depends on mid-step, which depends on 4 incomplete steps
      // This creates 1 direct blocker (mid-step) and 4 transitive blockers (step-1 through step-4)
      const source = `@module auth
  @feature setup
    @requirement step-1
      Step 1.
    
    @requirement step-2
      Step 2.
    
    @requirement step-3
      Step 3.
    
    @requirement step-4
      Step 4.
    
    @requirement mid-step
      @depends-on auth.setup.step-1, auth.setup.step-2, auth.setup.step-3, auth.setup.step-4
      Mid step depends on all setup steps.
    
    @requirement final-step
      @depends-on auth.setup.mid-step
      Final step depends on mid-step.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.setup.step-1",
            description: "Step 1",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.setup.step-2",
            description: "Step 2",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-003",
            ref: "auth.setup.step-3",
            description: "Step 3",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-004",
            ref: "auth.setup.step-4",
            description: "Step 4",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-005",
            ref: "auth.setup.mid-step",
            description: "Mid step",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-006",
            ref: "auth.setup.final-step",
            description: "Final step",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      // Hover over final-step requirement
      // Line positions: step-1 at 2, step-2 at 5, step-3 at 8, step-4 at 11, mid-step at 14, final-step at 18
      const target = findHoverTarget(
        tree!,
        { line: 18, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("requirement");
      expect(target!.path).toBe("auth.setup.final-step");

      const content = buildHoverContent(target!, context);
      expect(content).not.toBeNull();

      // Should show blocked status
      expect(content!.value).toContain("Blocked");

      // Should show direct blocker
      expect(content!.value).toContain("auth.setup.mid-step");

      // Should show "Transitive blockers" section
      expect(content!.value).toContain("Transitive blockers");

      // Should show exactly 3 transitive blockers and truncation message
      // The truncation message should say "... and 1 more" (4 total - 3 shown = 1 more)
      expect(content!.value).toContain("... and 1 more");
    });

    test("shows all transitive blockers when 3 or fewer", () => {
      // Create a chain with exactly 3 transitive blockers
      const source = `@module auth
  @feature setup
    @requirement step-1
      Step 1.
    
    @requirement step-2
      Step 2.
    
    @requirement step-3
      Step 3.
    
    @requirement mid-step
      @depends-on auth.setup.step-1, auth.setup.step-2, auth.setup.step-3
      Mid step depends on setup steps.
    
    @requirement final-step
      @depends-on auth.setup.mid-step
      Final step depends on mid-step.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.setup.step-1",
            description: "Step 1",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.setup.step-2",
            description: "Step 2",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-003",
            ref: "auth.setup.step-3",
            description: "Step 3",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-004",
            ref: "auth.setup.mid-step",
            description: "Mid step",
            status: "pending",
            constraints_satisfied: [],
          },
          {
            id: "TKT-005",
            ref: "auth.setup.final-step",
            description: "Final step",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      // Hover over final-step requirement (line 15)
      const target = findHoverTarget(
        tree!,
        { line: 15, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.path).toBe("auth.setup.final-step");

      const content = buildHoverContent(target!, context);
      expect(content).not.toBeNull();

      // Should show all 3 transitive blockers
      expect(content!.value).toContain("auth.setup.step-1");
      expect(content!.value).toContain("auth.setup.step-2");
      expect(content!.value).toContain("auth.setup.step-3");

      // Should NOT show truncation message
      expect(content!.value).not.toContain("... and");
      expect(content!.value).not.toContain("more");
    });
  });

  describe("multiple tickets per requirement", () => {
    test("shows all tickets for a requirement", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
      
      @constraint bcrypt-cost
        Use bcrypt.
      
      @constraint rate-limit
        Rate limit logins.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Core login implementation",
            status: "complete",
            constraints_satisfied: ["bcrypt-cost"],
          },
          {
            id: "TKT-002",
            ref: "auth.login.basic-auth",
            description: "Add rate limiting",
            status: "in-progress",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("TKT-001");
      expect(content!.value).toContain("TKT-002");
      expect(content!.value).toContain("Core login implementation");
      expect(content!.value).toContain("Add rate limiting");
    });

    test("aggregates constraint satisfaction from multiple tickets", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
      
      @constraint bcrypt-cost
        Use bcrypt.
      
      @constraint rate-limit
        Rate limit logins.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Core login",
            status: "complete",
            constraints_satisfied: ["bcrypt-cost"],
          },
          {
            id: "TKT-002",
            ref: "auth.login.basic-auth",
            description: "Rate limiting",
            status: "complete",
            constraints_satisfied: ["rate-limit"],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("2/2 satisfied");
      expect(content!.value).toContain("\u2713 bcrypt-cost");
      expect(content!.value).toContain("\u2713 rate-limit");
    });
  });

  describe("formatFileLink", () => {
    test("returns plain text when no workspace folders provided", () => {
      const result = formatFileLink("src/auth/login.ts");
      expect(result).toBe("src/auth/login.ts");
    });

    test("returns plain text when workspace folders array is empty", () => {
      const result = formatFileLink("src/auth/login.ts", []);
      expect(result).toBe("src/auth/login.ts");
    });

    test("creates markdown link with file URI for relative path", () => {
      const result = formatFileLink("src/auth/login.ts", ["file:///workspace"]);
      expect(result).toContain("[src/auth/login.ts]");
      expect(result).toContain("file:///workspace/src/auth/login.ts");
    });

    test("creates markdown link for absolute path", () => {
      const result = formatFileLink("/absolute/path/file.ts", ["file:///workspace"]);
      expect(result).toContain("[/absolute/path/file.ts]");
      expect(result).toContain("file:///absolute/path/file.ts");
    });

    test("uses first workspace folder for resolution", () => {
      const result = formatFileLink("src/file.ts", [
        "file:///first-workspace",
        "file:///second-workspace",
      ]);
      expect(result).toContain("file:///first-workspace/src/file.ts");
      expect(result).not.toContain("second-workspace");
    });

    test("handles paths with special characters", () => {
      const result = formatFileLink("src/my file.ts", ["file:///workspace"]);
      expect(result).toContain("[src/my file.ts]");
      // URI should be properly encoded
      expect(result).toContain("file:///workspace/src/my%20file.ts");
    });

    test("handles nested relative paths", () => {
      const result = formatFileLink("src/auth/handlers/login.ts", ["file:///workspace"]);
      expect(result).toContain("[src/auth/handlers/login.ts]");
      expect(result).toContain("file:///workspace/src/auth/handlers/login.ts");
    });
  });

  describe("file links in hover", () => {
    /**
     * Helper to create a hover context with workspace folders.
     */
    function createHoverContextWithWorkspace(
      source: string,
      fileUri: string = "file:///test.bp",
      tickets: TicketFile | null = null,
      workspaceFolderUris: string[] = []
    ): { tree: ReturnType<typeof parseDocument>; context: HoverContext } {
      const tree = parseDocument(source);
      if (!tree) {
        throw new Error("Failed to parse source");
      }

      const ast = transformToAST(tree);
      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile(fileUri, ast);

      const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
      const { map: ticketMap } = buildRequirementTicketMapFromSymbols(requirementSymbols, tickets);

      const { graph: dependencyGraph, cycles } = DependencyGraph.build(symbolIndex);

      return {
        tree,
        context: {
          symbolIndex,
          ticketMap,
          dependencyGraph,
          cycles,
          fileUri,
          workspaceFolderUris,
        },
      };
    }

    test("renders implementation files as clickable links when workspace is available", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "complete",
            constraints_satisfied: [],
            implementation: {
              files: ["src/auth/login.ts"],
              tests: [],
            },
          },
        ],
      };

      const { tree, context } = createHoverContextWithWorkspace(
        source,
        "file:///workspace/test.bp",
        tickets,
        ["file:///workspace"]
      );

      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("[src/auth/login.ts]");
      expect(content!.value).toContain("file:///workspace/src/auth/login.ts");
    });

    test("renders test files as clickable links when workspace is available", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "complete",
            constraints_satisfied: [],
            implementation: {
              files: [],
              tests: ["tests/auth/login.test.ts"],
            },
          },
        ],
      };

      const { tree, context } = createHoverContextWithWorkspace(
        source,
        "file:///workspace/test.bp",
        tickets,
        ["file:///workspace"]
      );

      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("[tests/auth/login.test.ts]");
      expect(content!.value).toContain("file:///workspace/tests/auth/login.test.ts");
    });

    test("renders files as plain text when no workspace available", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "complete",
            constraints_satisfied: [],
            implementation: {
              files: ["src/auth/login.ts"],
              tests: ["tests/auth/login.test.ts"],
            },
          },
        ],
      };

      const { tree, context } = createHoverContextWithWorkspace(
        source,
        "file:///test.bp",
        tickets,
        [] // No workspace folders
      );

      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      // Should contain file paths but NOT as markdown links
      expect(content!.value).toContain("src/auth/login.ts");
      expect(content!.value).toContain("tests/auth/login.test.ts");
      expect(content!.value).not.toContain("[src/auth/login.ts]");
    });

    test("renders multiple files as clickable links", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Basic authentication.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "complete",
            constraints_satisfied: [],
            implementation: {
              files: ["src/auth/login.ts", "src/auth/password.ts"],
              tests: ["tests/auth/login.test.ts", "tests/auth/password.test.ts"],
            },
          },
        ],
      };

      const { tree, context } = createHoverContextWithWorkspace(
        source,
        "file:///workspace/test.bp",
        tickets,
        ["file:///workspace"]
      );

      const target = findHoverTarget(
        tree!,
        { line: 2, character: 17 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      // All files should be rendered as links
      expect(content!.value).toContain("[src/auth/login.ts]");
      expect(content!.value).toContain("[src/auth/password.ts]");
      expect(content!.value).toContain("[tests/auth/login.test.ts]");
      expect(content!.value).toContain("[tests/auth/password.test.ts]");
    });
  });

  describe("description hover", () => {
    test("finds description target when hovering over @description keyword", () => {
      const source = `@description
  This is a test project for authentication.

@module auth
  Authentication module.`;
      const { tree, context } = createHoverContext(source);

      // Position on "@description"
      const target = findHoverTarget(
        tree!,
        { line: 0, character: 0 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("description");
    });

    test("finds description target when hovering over description text", () => {
      const source = `@description
  This is a test project for authentication.

@module auth
  Authentication module.`;
      const { tree, context } = createHoverContext(source);

      // Position on description text
      const target = findHoverTarget(
        tree!,
        { line: 1, character: 10 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("description");
      expect(target!.descriptionText).toContain("This is a test project");
    });

    test("builds hover content for description block", () => {
      const source = `@description
  CloudVault Authentication System
  
  This document specifies the authentication requirements.

@module auth
  Authentication module.
  
  @feature login
    Login feature.
    
    @requirement basic-auth
      Basic authentication.`;
      const { tree, context } = createHoverContext(source);

      const target = findHoverTarget(
        tree!,
        { line: 1, character: 5 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content).not.toBeNull();
      expect(content!.value).toContain("### @description");
      expect(content!.value).toContain("Document-level description");
      expect(content!.value).toContain("CloudVault Authentication System");
      expect(content!.value).toContain("authentication requirements");
    });

    test("shows document progress in description hover", () => {
      const source = `@description
  Project overview.

@module auth
  @feature login
    @requirement basic-auth
      Basic auth.
    @requirement oauth
      OAuth login.`;

      const tickets: TicketFile = {
        version: "1.0",
        source: "auth.bp",
        tickets: [
          {
            id: "TKT-001",
            ref: "auth.login.basic-auth",
            description: "Implement basic auth",
            status: "complete",
            constraints_satisfied: [],
          },
          {
            id: "TKT-002",
            ref: "auth.login.oauth",
            description: "Implement OAuth",
            status: "pending",
            constraints_satisfied: [],
          },
        ],
      };

      const { tree, context } = createHoverContext(source, "file:///test.bp", tickets);

      const target = findHoverTarget(
        tree!,
        { line: 0, character: 0 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("Document Progress");
      expect(content!.value).toContain("1/2 requirements complete");
      expect(content!.value).toContain("50%");
    });

    test("handles description with code blocks", () => {
      const source = `@description
  Example configuration:
  
  \`\`\`
  AUTH_SECRET=xxx
  \`\`\`

@module auth
  Auth module.`;
      const { tree, context } = createHoverContext(source);

      const target = findHoverTarget(
        tree!,
        { line: 1, character: 5 },
        context.symbolIndex,
        context.fileUri
      );
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("description");
      expect(target!.descriptionText).toContain("Example configuration");
      expect(target!.descriptionText).toContain("AUTH_SECRET");
    });

    test("description hover with no requirements shows no progress", () => {
      const source = `@description
  Empty project description.

@module empty
  Empty module with no requirements.`;
      const { tree, context } = createHoverContext(source);

      const target = findHoverTarget(
        tree!,
        { line: 0, character: 5 },
        context.symbolIndex,
        context.fileUri
      );
      const content = buildHoverContent(target!, context);

      expect(content!.value).toContain("### @description");
      // Should not contain progress section when there are no requirements
      expect(content!.value).not.toContain("Document Progress");
    });
  });
});
