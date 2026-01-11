import { describe, test, expect, beforeAll } from "bun:test";
import { initializeParser, parseDocument, cleanupParser } from "./parser";
import {
  findNodeAtPosition,
  findDefinitionTarget,
  buildDefinition,
  type DefinitionContext,
} from "./definition";
import { CrossFileSymbolIndex } from "./symbol-index";
import { transformToAST } from "./ast";
import { buildRequirementTicketMapFromSymbols } from "./requirement-ticket-map";
import type { Ticket, TicketFile } from "./tickets";

describe("definition", () => {
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

  describe("findDefinitionTarget", () => {
    test("finds module target", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on "auth" identifier
      const target = findDefinitionTarget(
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
      const target = findDefinitionTarget(
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
      const target = findDefinitionTarget(
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
  Authentication module.

  @feature login
    User login functionality.

    @requirement basic-auth
      Users can log in with email and password.

      @constraint bcrypt-cost
        Use bcrypt with cost factor >= 12.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on "bcrypt-cost" identifier
      const target = findDefinitionTarget(
        tree!,
        { line: 9, character: 20 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("constraint");
      expect(target!.path).toBe("auth.login.basic-auth.bcrypt-cost");
    });

    test("finds reference target in @depends-on", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.

    @requirement basic-auth
      Users can log in with email and password.

  @feature session
    @depends-on auth.login.basic-auth

    Session management.

    @requirement create-token
      Create session tokens.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on the reference "auth.login.basic-auth"
      const target = findDefinitionTarget(
        tree!,
        { line: 10, character: 20 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("reference");
      expect(target!.referencePath).toBe("auth.login.basic-auth");
      expect(target!.symbol).toBeDefined();
    });

    test("finds unresolved reference target", () => {
      const source = `@module auth
  @depends-on nonexistent.module

  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();
      const ast = transformToAST(tree!);
      symbolIndex.addFile("file:///test.bp", ast);

      // Position on the reference "nonexistent.module"
      const target = findDefinitionTarget(
        tree!,
        { line: 1, character: 15 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("reference");
      expect(target!.referencePath).toBe("nonexistent.module");
      expect(target!.symbol).toBeUndefined();
    });

    test("returns keyword target for @module keyword", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbolIndex = new CrossFileSymbolIndex();

      // Position on "@module" keyword
      const target = findDefinitionTarget(
        tree!,
        { line: 0, character: 3 },
        symbolIndex,
        "file:///test.bp"
      );

      expect(target).not.toBeNull();
      expect(target!.kind).toBe("keyword");
    });
  });

  describe("buildDefinition", () => {
    function createContext(
      symbolIndex: CrossFileSymbolIndex,
      tickets: Ticket[] = [],
      ticketFileContent: string = "{}"
    ): DefinitionContext {
      const requirementSymbols = symbolIndex.getSymbolsByKind("requirement");
      const ticketFile: TicketFile | null = tickets.length > 0
        ? { version: "1.0", source: "test.bp", tickets }
        : null;
      const { map: ticketMap } = buildRequirementTicketMapFromSymbols(
        requirementSymbols,
        ticketFile
      );

      const ticketFiles = new Map<string, { uri: string; content: string; tickets: Ticket[] }>();
      if (tickets.length > 0) {
        ticketFiles.set("file:///test.tickets.json", {
          uri: "file:///test.tickets.json",
          content: ticketFileContent,
          tickets,
        });
      }

      return {
        symbolIndex,
        ticketMap,
        ticketFiles,
        fileUri: "file:///test.bp",
      };
    }

    test("returns null for keyword target", () => {
      const symbolIndex = new CrossFileSymbolIndex();
      const context = createContext(symbolIndex);

      const result = buildDefinition({ kind: "keyword" }, context);
      expect(result).toBeNull();
    });

    test("returns location for module definition", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      const target = findDefinitionTarget(
        tree!,
        { line: 0, character: 8 },
        symbolIndex,
        "file:///test.bp"
      );
      const context = createContext(symbolIndex);

      const result = buildDefinition(target!, context);
      expect(result).not.toBeNull();
      expect(result).not.toBeInstanceOf(Array);
      
      const location = result as { uri: string; range: { start: { line: number } } };
      expect(location.uri).toBe("file:///test.bp");
      expect(location.range.start.line).toBe(0);
    });

    test("returns location for reference definition (cross-file)", () => {
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

      // Find the reference target in auth.bp
      const target = findDefinitionTarget(
        treeB!,
        { line: 1, character: 15 },
        symbolIndex,
        "file:///auth.bp"
      );
      
      expect(target).not.toBeNull();
      expect(target!.kind).toBe("reference");
      expect(target!.referencePath).toBe("storage.user-accounts");

      const context = createContext(symbolIndex);
      context.fileUri = "file:///auth.bp";

      const result = buildDefinition(target!, context);
      expect(result).not.toBeNull();
      
      const location = result as { uri: string; range: { start: { line: number } } };
      // Should navigate to storage.bp where the feature is defined
      expect(location.uri).toBe("file:///storage.bp");
    });

    test("returns null for unresolved reference", () => {
      const source = `@module auth
  @depends-on nonexistent.module

  Authentication module.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      const target = findDefinitionTarget(
        tree!,
        { line: 1, character: 15 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);
      const result = buildDefinition(target!, context);
      expect(result).toBeNull();
    });

    test("returns ticket location for requirement with tickets", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      const target = findDefinitionTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const tickets: Ticket[] = [
        {
          id: "TKT-001",
          ref: "auth.login.basic-auth",
          description: "Implement basic auth",
          status: "in-progress",
          constraints_satisfied: [],
        },
      ];

      const ticketContent = JSON.stringify({
        version: "1.0",
        source: "test.bp",
        tickets,
      }, null, 2);

      const context = createContext(symbolIndex, tickets, ticketContent);

      const result = buildDefinition(target!, context);
      expect(result).not.toBeNull();
      
      const location = result as { uri: string; range: { start: { line: number } } };
      // Should navigate to the ticket file
      expect(location.uri).toBe("file:///test.tickets.json");
    });

    test("returns multiple locations for requirement with multiple tickets", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      const target = findDefinitionTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      const tickets: Ticket[] = [
        {
          id: "TKT-001",
          ref: "auth.login.basic-auth",
          description: "Implement core auth",
          status: "complete",
          constraints_satisfied: [],
        },
        {
          id: "TKT-002",
          ref: "auth.login.basic-auth",
          description: "Add rate limiting",
          status: "in-progress",
          constraints_satisfied: [],
        },
      ];

      const ticketContent = JSON.stringify({
        version: "1.0",
        source: "test.bp",
        tickets,
      }, null, 2);

      const context = createContext(symbolIndex, tickets, ticketContent);

      const result = buildDefinition(target!, context);
      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(true);
      
      const locations = result as Array<{ uri: string }>;
      expect(locations.length).toBe(2);
      expect(locations[0]!.uri).toBe("file:///test.tickets.json");
      expect(locations[1]!.uri).toBe("file:///test.tickets.json");
    });

    test("falls back to symbol definition for requirement without tickets", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      const target = findDefinitionTarget(
        tree!,
        { line: 2, character: 18 },
        symbolIndex,
        "file:///test.bp"
      );

      // No tickets
      const context = createContext(symbolIndex);

      const result = buildDefinition(target!, context);
      expect(result).not.toBeNull();
      
      const location = result as { uri: string; range: { start: { line: number } } };
      // Should navigate to the requirement definition in the .bp file
      expect(location.uri).toBe("file:///test.bp");
      expect(location.range.start.line).toBe(2);
    });

    test("returns location for constraint definition", () => {
      const source = `@module auth
  @feature login
    @requirement basic-auth
      Users can log in.

      @constraint bcrypt-cost
        Use bcrypt with cost >= 12.`;
      const tree = parseDocument(source);
      const ast = transformToAST(tree!);

      const symbolIndex = new CrossFileSymbolIndex();
      symbolIndex.addFile("file:///test.bp", ast);

      const target = findDefinitionTarget(
        tree!,
        { line: 5, character: 20 },
        symbolIndex,
        "file:///test.bp"
      );

      const context = createContext(symbolIndex);

      const result = buildDefinition(target!, context);
      expect(result).not.toBeNull();
      
      const location = result as { uri: string; range: { start: { line: number } } };
      expect(location.uri).toBe("file:///test.bp");
      expect(location.range.start.line).toBe(5);
    });
  });
});
