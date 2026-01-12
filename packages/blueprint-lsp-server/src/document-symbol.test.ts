import { describe, test, expect, beforeAll } from "bun:test";
import { initializeParser, parseDocument } from "./parser";
import {
  buildDocumentSymbols,
  buildDocumentSymbolsFromAST,
  countSymbols,
  flattenSymbols,
} from "./document-symbol";
import { transformToAST } from "./ast";

// LSP SymbolKind values
const SymbolKind = {
  Module: 2,
  Class: 5,
  Function: 12,
  Constant: 14,
} as const;

describe("document-symbol", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("buildDocumentSymbols", () => {
    test("returns empty array for empty document", () => {
      const source = "";
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toEqual([]);
    });

    test("returns empty array for document with only description", () => {
      const source = `@description
  A system description.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toEqual([]);
    });

    test("returns module symbol for single module", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(1);

      const mod = symbols[0]!;
      expect(mod.name).toBe("auth");
      expect(mod.kind).toBe(SymbolKind.Module);
      expect(mod.detail).toBe("Authentication module.");
    });

    test("includes feature as child of module", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(1);

      const mod = symbols[0]!;
      expect(mod.name).toBe("auth");
      expect(mod.children).toHaveLength(1);

      const feature = mod.children![0]!;
      expect(feature.name).toBe("login");
      expect(feature.kind).toBe(SymbolKind.Class);
      expect(feature.detail).toBe("User login functionality.");
    });

    test("includes requirement as child of feature", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.

    @requirement basic-auth
      Basic authentication using email and password.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(1);

      const mod = symbols[0]!;
      const feature = mod.children![0]!;
      expect(feature.children).toHaveLength(1);

      const req = feature.children![0]!;
      expect(req.name).toBe("basic-auth");
      expect(req.kind).toBe(SymbolKind.Function);
      expect(req.detail).toBe("Basic authentication using email and password.");
    });

    test("includes constraint as child of requirement", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.

    @requirement basic-auth
      Basic authentication.

      @constraint bcrypt-cost
        Use bcrypt with cost factor >= 12.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const mod = symbols[0]!;
      const feature = mod.children![0]!;
      const req = feature.children![0]!;

      expect(req.children).toHaveLength(1);

      const constraint = req.children![0]!;
      expect(constraint.name).toBe("bcrypt-cost");
      expect(constraint.kind).toBe(SymbolKind.Constant);
      expect(constraint.detail).toBe("Use bcrypt with cost factor >= 12.");
    });

    test("includes module-level requirement", () => {
      const source = `@module auth
  Authentication module.

  @requirement global-auth
    A module-level requirement.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(1);

      const mod = symbols[0]!;
      expect(mod.children).toHaveLength(1);

      const req = mod.children![0]!;
      expect(req.name).toBe("global-auth");
      expect(req.kind).toBe(SymbolKind.Function);
    });

    test("includes module-level constraint", () => {
      const source = `@module auth
  Authentication module.

  @constraint security-audit
    All auth code must be security audited.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(1);

      const mod = symbols[0]!;
      expect(mod.children).toHaveLength(1);

      const constraint = mod.children![0]!;
      expect(constraint.name).toBe("security-audit");
      expect(constraint.kind).toBe(SymbolKind.Constant);
    });

    test("includes feature-level constraint", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login functionality.

    @constraint rate-limit
      Rate limit login attempts.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const mod = symbols[0]!;
      const feature = mod.children![0]!;

      expect(feature.children).toHaveLength(1);

      const constraint = feature.children![0]!;
      expect(constraint.name).toBe("rate-limit");
      expect(constraint.kind).toBe(SymbolKind.Constant);
    });

    test("handles multiple modules", () => {
      const source = `@module auth
  Authentication module.

@module storage
  Storage module.

@module api
  API module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(3);
      expect(symbols[0]!.name).toBe("auth");
      expect(symbols[1]!.name).toBe("storage");
      expect(symbols[2]!.name).toBe("api");
    });

    test("handles multiple features in a module", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login.

  @feature logout
    User logout.

  @feature password-reset
    Password reset.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      expect(symbols).toHaveLength(1);

      const mod = symbols[0]!;
      expect(mod.children).toHaveLength(3);
      expect(mod.children![0]!.name).toBe("login");
      expect(mod.children![1]!.name).toBe("logout");
      expect(mod.children![2]!.name).toBe("password-reset");
    });

    test("handles multiple requirements in a feature", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login.

    @requirement email-login
      Login with email.

    @requirement oauth-login
      Login with OAuth.

    @requirement sso-login
      Login with SSO.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const mod = symbols[0]!;
      const feature = mod.children![0]!;

      expect(feature.children).toHaveLength(3);
      expect(feature.children![0]!.name).toBe("email-login");
      expect(feature.children![1]!.name).toBe("oauth-login");
      expect(feature.children![2]!.name).toBe("sso-login");
    });

    test("handles multiple constraints in a requirement", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login.

    @requirement basic-auth
      Basic authentication.

      @constraint bcrypt-cost
        Use bcrypt with cost >= 12.

      @constraint rate-limit
        Rate limit attempts.

      @constraint audit-log
        Log all attempts.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const mod = symbols[0]!;
      const feature = mod.children![0]!;
      const req = feature.children![0]!;

      expect(req.children).toHaveLength(3);
      expect(req.children![0]!.name).toBe("bcrypt-cost");
      expect(req.children![1]!.name).toBe("rate-limit");
      expect(req.children![2]!.name).toBe("audit-log");
    });

    test("handles unnamed elements gracefully", () => {
      // This tests error recovery when identifier is missing
      const source = `@module
  A module without a name.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      // The parser may handle this differently, but we should not crash
      expect(Array.isArray(symbols)).toBe(true);
    });

    test("truncates long descriptions in detail field", () => {
      const longDescription =
        "This is a very long description that exceeds eighty characters and should be truncated with ellipsis.";
      const source = `@module auth
  ${longDescription}`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const mod = symbols[0]!;
      expect(mod.detail).toBeDefined();
      expect(mod.detail!.length).toBeLessThanOrEqual(80);
      expect(mod.detail!.endsWith("...")).toBe(true);
    });

    test("uses first line only for multi-line descriptions", () => {
      const source = `@module auth
  First line of description.
  Second line of description.
  Third line of description.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const mod = symbols[0]!;
      expect(mod.detail).toBe("First line of description.");
    });
  });

  describe("buildDocumentSymbolsFromAST", () => {
    test("builds symbols from AST directly", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const symbols = buildDocumentSymbolsFromAST(ast);

      expect(symbols).toHaveLength(1);
      const mod = symbols[0]!;
      expect(mod.name).toBe("auth");
      expect(mod.children).toHaveLength(1);
      expect(mod.children![0]!.name).toBe("login");
    });
  });

  describe("countSymbols", () => {
    test("counts all symbols in tree", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login.

    @requirement basic-auth
      Basic auth.

      @constraint bcrypt
        Use bcrypt.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const count = countSymbols(symbols);
      // 1 module + 1 feature + 1 requirement + 1 constraint = 4
      expect(count).toBe(4);
    });

    test("counts zero for empty array", () => {
      expect(countSymbols([])).toBe(0);
    });

    test("counts complex hierarchy", () => {
      const source = `@module auth
  Auth.

  @feature login
    Login.

    @requirement basic
      Basic.

    @requirement oauth
      OAuth.

  @feature logout
    Logout.

@module storage
  Storage.

  @feature files
    Files.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const count = countSymbols(symbols);
      // auth(1) + login(1) + basic(1) + oauth(1) + logout(1) + storage(1) + files(1) = 7
      expect(count).toBe(7);
    });
  });

  describe("flattenSymbols", () => {
    test("flattens nested symbols to list", () => {
      const source = `@module auth
  Auth.

  @feature login
    Login.

    @requirement basic
      Basic.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const flat = flattenSymbols(symbols);

      expect(flat).toHaveLength(3);
      expect(flat[0]!.name).toBe("auth");
      expect(flat[1]!.name).toBe("login");
      expect(flat[2]!.name).toBe("basic");
    });

    test("returns empty array for empty input", () => {
      expect(flattenSymbols([])).toEqual([]);
    });
  });

  describe("symbol ranges", () => {
    test("range covers entire block", () => {
      const source = `@module auth
  Authentication module.

  @feature login
    User login.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const moduleSymbol = symbols[0]!;

      // Module should start at line 0 and cover the whole block
      expect(moduleSymbol.range.start.line).toBe(0);
      expect(moduleSymbol.range.start.character).toBe(0);
      // Module should end at or after line 4 (last line of content)
      expect(moduleSymbol.range.end.line).toBeGreaterThanOrEqual(4);
    });

    test("selectionRange covers first line", () => {
      const source = `@module auth
  Authentication module.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const moduleSymbol = symbols[0]!;

      // Selection range should be on first line
      expect(moduleSymbol.selectionRange.start.line).toBe(0);
      expect(moduleSymbol.selectionRange.end.line).toBe(0);
    });
  });

  describe("complex document", () => {
    test("handles SPEC.md example structure", () => {
      const source = `@description
  CloudVault Authentication System

@module authentication
  Handles user identity verification.

  @feature login
    @depends-on storage.user-accounts

    User login mechanisms.

    @requirement credentials-login
      Login with email and password.

      @constraint bcrypt-verification
        Use bcrypt with cost >= 12.

      @constraint rate-limiting
        5 attempts per 15 minutes.

    @requirement oauth-login
      @depends-on authentication.login.credentials-login

      Login with OAuth providers.

  @feature session
    @depends-on authentication.login

    Session management.

    @requirement create-token
      Generate session tokens.

      @constraint rs256-signing
        Use RS256 for signing.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);

      // Should have 1 module
      expect(symbols).toHaveLength(1);
      const mod = symbols[0]!;
      expect(mod.name).toBe("authentication");
      expect(mod.kind).toBe(SymbolKind.Module);

      // Module should have 2 features
      expect(mod.children).toHaveLength(2);

      // Login feature
      const login = mod.children![0]!;
      expect(login.name).toBe("login");
      expect(login.kind).toBe(SymbolKind.Class);
      expect(login.children).toHaveLength(2); // 2 requirements

      // credentials-login requirement
      const credentialsLogin = login.children![0]!;
      expect(credentialsLogin.name).toBe("credentials-login");
      expect(credentialsLogin.kind).toBe(SymbolKind.Function);
      expect(credentialsLogin.children).toHaveLength(2); // 2 constraints

      // Constraints
      expect(credentialsLogin.children![0]!.name).toBe("bcrypt-verification");
      expect(credentialsLogin.children![0]!.kind).toBe(SymbolKind.Constant);
      expect(credentialsLogin.children![1]!.name).toBe("rate-limiting");

      // oauth-login requirement
      const oauthLogin = login.children![1]!;
      expect(oauthLogin.name).toBe("oauth-login");
      expect(oauthLogin.children).toBeUndefined(); // No constraints

      // Session feature
      const session = mod.children![1]!;
      expect(session.name).toBe("session");
      expect(session.children).toHaveLength(1); // 1 requirement

      // create-token requirement
      const createToken = session.children![0]!;
      expect(createToken.name).toBe("create-token");
      expect(createToken.children).toHaveLength(1); // 1 constraint
      expect(createToken.children![0]!.name).toBe("rs256-signing");
    });

    test("total symbol count for complex document", () => {
      const source = `@module authentication
  Auth.

  @feature login
    Login.

    @requirement credentials-login
      Credentials.

      @constraint bcrypt
        Bcrypt.

      @constraint rate-limit
        Rate limit.

    @requirement oauth-login
      OAuth.

  @feature session
    Session.

    @requirement create-token
      Token.

      @constraint signing
        Signing.`;
      const tree = parseDocument(source);
      expect(tree).not.toBeNull();

      const symbols = buildDocumentSymbols(tree!);
      const count = countSymbols(symbols);

      // 1 module + 2 features + 3 requirements + 3 constraints = 9
      expect(count).toBe(9);
    });
  });
});
