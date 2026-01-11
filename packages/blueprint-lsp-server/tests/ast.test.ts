import { test, expect, beforeAll, describe } from "bun:test";
import { initializeParser, parseDocument } from "../src/parser";
import {
  transformToAST,
  buildSymbolTable,
  getAllRequirements,
  getAllConstraints,
  getRequirementPath,
} from "../src/ast";

describe("AST Transformation", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("transformToAST", () => {
    test("transforms empty document", () => {
      const tree = parseDocument("");
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      expect(ast.type).toBe("document");
      expect(ast.description).toBeNull();
      expect(ast.modules).toEqual([]);
    });

    test("transforms document with description", () => {
      const code = `
@description
  This is a test system.
  It has multiple lines.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      expect(ast.description).not.toBeNull();
      expect(ast.description!.type).toBe("description");
      expect(ast.description!.text).toContain("This is a test system");
    });

    test("transforms simple module", () => {
      const code = `
@module authentication
  Handles user authentication.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      expect(ast.modules).toHaveLength(1);
      expect(ast.modules[0]!.type).toBe("module");
      expect(ast.modules[0]!.name).toBe("authentication");
      expect(ast.modules[0]!.description).toContain("Handles user authentication");
    });

    test("transforms module with feature", () => {
      const code = `
@module authentication

@feature login
  User login functionality.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      expect(ast.modules).toHaveLength(1);
      expect(ast.modules[0]!.features).toHaveLength(1);
      expect(ast.modules[0]!.features[0]!.name).toBe("login");
      expect(ast.modules[0]!.features[0]!.description).toContain("User login functionality");
    });

    test("transforms feature with requirement", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth
  Users can log in with email and password.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      expect(ast.modules[0]!.features[0]!.requirements).toHaveLength(1);
      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      expect(req.name).toBe("basic-auth");
      expect(req.description).toContain("Users can log in");
    });

    test("transforms requirement with constraint", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth
  Users can log in with email and password.

  @constraint bcrypt-hashing
    Passwords must use bcrypt with cost >= 12.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      expect(req.constraints).toHaveLength(1);
      expect(req.constraints[0]!.name).toBe("bcrypt-hashing");
      expect(req.constraints[0]!.description).toContain("bcrypt");
    });

    test("transforms multiple constraints", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth
  Users can log in.

  @constraint bcrypt
    Use bcrypt.

  @constraint rate-limit
    Rate limit attempts.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      expect(req.constraints).toHaveLength(2);
      expect(req.constraints[0]!.name).toBe("bcrypt");
      expect(req.constraints[1]!.name).toBe("rate-limit");
    });

    test("transforms depends-on with single reference", () => {
      const code = `
@module payments
  @depends-on authentication
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      expect(ast.modules[0]!.dependencies).toHaveLength(1);
      const dep = ast.modules[0]!.dependencies[0]!;
      expect(dep.type).toBe("depends_on");
      expect(dep.references).toHaveLength(1);
      expect(dep.references[0]!.path).toBe("authentication");
      expect(dep.references[0]!.parts).toEqual(["authentication"]);
    });

    test("transforms depends-on with multiple references", () => {
      const code = `
@module payments

@feature checkout
  @depends-on payments.cart, inventory.stock
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      const feature = ast.modules[0]!.features[0]!;
      expect(feature.dependencies).toHaveLength(1);
      const dep = feature.dependencies[0]!;
      expect(dep.references).toHaveLength(2);
      expect(dep.references[0]!.path).toBe("payments.cart");
      expect(dep.references[0]!.parts).toEqual(["payments", "cart"]);
      expect(dep.references[1]!.path).toBe("inventory.stock");
    });

    test("transforms depends-on with three-part reference", () => {
      const code = `
@module payments

@feature checkout

@requirement process-refund
  @depends-on payments.checkout.capture-payment
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      expect(req.dependencies).toHaveLength(1);
      expect(req.dependencies[0]!.references[0]!.path).toBe("payments.checkout.capture-payment");
      expect(req.dependencies[0]!.references[0]!.parts).toEqual([
        "payments",
        "checkout",
        "capture-payment",
      ]);
    });

    test("transforms multiple modules", () => {
      const code = `
@module authentication
  Auth module.

@module payments
  Payments module.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      expect(ast.modules).toHaveLength(2);
      expect(ast.modules[0]!.name).toBe("authentication");
      expect(ast.modules[1]!.name).toBe("payments");
    });

    test("preserves source locations", () => {
      const code = `@module authentication
  Handles auth.`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      const mod = ast.modules[0]!;
      expect(mod.location.startLine).toBe(0);
      expect(mod.location.startColumn).toBe(0);
    });
  });

  describe("buildSymbolTable", () => {
    test("builds symbol table for modules", () => {
      const code = `
@module authentication
@module payments
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const symbols = buildSymbolTable(ast);

      expect(symbols.modules.has("authentication")).toBe(true);
      expect(symbols.modules.has("payments")).toBe(true);
      expect(symbols.modules.size).toBe(2);
    });

    test("builds symbol table for features", () => {
      const code = `
@module authentication

@feature login
@feature logout
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const symbols = buildSymbolTable(ast);

      expect(symbols.features.has("authentication.login")).toBe(true);
      expect(symbols.features.has("authentication.logout")).toBe(true);
    });

    test("builds symbol table for requirements", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth
@requirement oauth
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const symbols = buildSymbolTable(ast);

      expect(symbols.requirements.has("authentication.login.basic-auth")).toBe(true);
      expect(symbols.requirements.has("authentication.login.oauth")).toBe(true);
    });

    test("builds symbol table for constraints", () => {
      const code = `
@module authentication

@feature login

@requirement basic-auth

  @constraint bcrypt
    Use bcrypt.

  @constraint rate-limit
    Rate limit.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const symbols = buildSymbolTable(ast);

      expect(symbols.constraints.has("authentication.login.basic-auth.bcrypt")).toBe(true);
      expect(symbols.constraints.has("authentication.login.basic-auth.rate-limit")).toBe(true);
    });

    test("handles module-level requirements", () => {
      const code = `
@module authentication

@requirement global-auth-check
  A global requirement.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const symbols = buildSymbolTable(ast);

      expect(symbols.requirements.has("authentication.global-auth-check")).toBe(true);
    });
  });

  describe("getAllRequirements", () => {
    test("returns all requirements from all locations", () => {
      const code = `
@module auth

@requirement module-level
  Module level req.

@feature login

@requirement feat-level
  Feature level req.

@module payments

@feature checkout

@requirement checkout-req
  Another req.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const reqs = getAllRequirements(ast);

      expect(reqs).toHaveLength(3);
      const names = reqs.map((r) => r.name);
      expect(names).toContain("module-level");
      expect(names).toContain("feat-level");
      expect(names).toContain("checkout-req");
    });

    test("returns empty array for document with no requirements", () => {
      const code = `
@module auth

@feature login
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const reqs = getAllRequirements(ast);

      expect(reqs).toHaveLength(0);
    });
  });

  describe("getAllConstraints", () => {
    test("returns all constraints from all locations", () => {
      const code = `
@module auth
  @constraint module-constraint
    Module level.

@feature login
  @constraint feature-constraint
    Feature level.

  @requirement basic
    @constraint req-constraint
      Requirement level.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const constraints = getAllConstraints(ast);

      expect(constraints).toHaveLength(3);
      const names = constraints.map((c) => c.name);
      expect(names).toContain("module-constraint");
      expect(names).toContain("feature-constraint");
      expect(names).toContain("req-constraint");
    });
  });

  describe("getRequirementPath", () => {
    test("returns path for module-level requirement", () => {
      const code = `
@module auth

@requirement global-check
  Global.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const req = ast.modules[0]!.requirements[0]!;
      const path = getRequirementPath(ast, req);

      expect(path).toBe("auth.global-check");
    });

    test("returns path for feature-level requirement", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      const path = getRequirementPath(ast, req);

      expect(path).toBe("auth.login.basic-auth");
    });

    test("returns null for unknown requirement", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);

      // Create a fake requirement not in the document
      const fakeReq = {
        type: "requirement" as const,
        name: "fake",
        description: "",
        dependencies: [],
        constraints: [],
        location: ast.modules[0]!.location,
      };
      const path = getRequirementPath(ast, fakeReq);

      expect(path).toBeNull();
    });
  });

  describe("complex document", () => {
    test("transforms complete Blueprint document", () => {
      const code = `
@description
  CloudVault Authentication System.

@module authentication
  Handles user identity verification.

  @depends-on storage.user-accounts

@feature login
  Provides login mechanisms.

  @requirement credentials-login
    Users authenticate with email and password.

    @constraint bcrypt-verification
      Use bcrypt with cost >= 12.

    @constraint rate-limiting
      Limit to 5 attempts per 15 minutes.

  @requirement oauth-login
    @depends-on authentication.login.credentials-login

    Users authenticate via OAuth providers.

    @constraint csrf-protection
      Validate OAuth state parameter.

@feature session

  @requirement create-token
    Generate secure session tokens.

    @constraint rs256-signing
      Use RS256 with rotating keys.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);

      // Document level
      expect(ast.description).not.toBeNull();
      expect(ast.description!.text).toContain("CloudVault");

      // Module
      expect(ast.modules).toHaveLength(1);
      const authModule = ast.modules[0]!;
      expect(authModule.name).toBe("authentication");
      expect(authModule.dependencies).toHaveLength(1);
      expect(authModule.dependencies[0]!.references[0]!.path).toBe("storage.user-accounts");

      // Features
      expect(authModule.features).toHaveLength(2);
      const loginFeature = authModule.features[0]!;
      expect(loginFeature.name).toBe("login");

      // Requirements
      expect(loginFeature.requirements).toHaveLength(2);
      const credentialsReq = loginFeature.requirements[0]!;
      expect(credentialsReq.name).toBe("credentials-login");
      expect(credentialsReq.constraints).toHaveLength(2);

      const oauthReq = loginFeature.requirements[1]!;
      expect(oauthReq.name).toBe("oauth-login");
      expect(oauthReq.dependencies).toHaveLength(1);
      expect(oauthReq.dependencies[0]!.references[0]!.path).toBe(
        "authentication.login.credentials-login"
      );

      // Symbol table
      const symbols = buildSymbolTable(ast);
      expect(symbols.modules.has("authentication")).toBe(true);
      expect(symbols.features.has("authentication.login")).toBe(true);
      expect(symbols.features.has("authentication.session")).toBe(true);
      expect(symbols.requirements.has("authentication.login.credentials-login")).toBe(true);
      expect(symbols.requirements.has("authentication.login.oauth-login")).toBe(true);
      expect(symbols.requirements.has("authentication.session.create-token")).toBe(true);
      expect(
        symbols.constraints.has("authentication.login.credentials-login.bcrypt-verification")
      ).toBe(true);
    });
  });
});
