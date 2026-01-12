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

    test("transforms depends-on with deeply nested reference (more than 3 parts)", () => {
      // Per SPEC Section 3.4.1, references are defined with up to 3 parts:
      // module, module.feature, or module.feature.requirement
      // However, the grammar allows arbitrary depth. This test verifies that
      // deeply nested references (4+ parts) are parsed gracefully without errors,
      // even though they may not be semantically valid per the spec.
      const code = `
@module payments

@feature checkout

@requirement process-refund
  @depends-on a.b.c.d
  @depends-on one.two.three.four.five.six
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      // The grammar should parse this without error
      expect(tree!.rootNode.hasError).toBe(false);

      const ast = transformToAST(tree!);

      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      expect(req.dependencies).toHaveLength(2);

      // 4-part reference
      const ref1 = req.dependencies[0]!.references[0]!;
      expect(ref1.path).toBe("a.b.c.d");
      expect(ref1.parts).toEqual(["a", "b", "c", "d"]);
      expect(ref1.parts).toHaveLength(4);

      // 6-part reference
      const ref2 = req.dependencies[1]!.references[0]!;
      expect(ref2.path).toBe("one.two.three.four.five.six");
      expect(ref2.parts).toEqual(["one", "two", "three", "four", "five", "six"]);
      expect(ref2.parts).toHaveLength(6);
    });

    test("transforms depends-on with mixed depth references", () => {
      // Test that a single @depends-on with multiple comma-separated references
      // of varying depths (including deeply nested) works correctly
      const code = `
@module test

@feature example

@requirement mixed-refs
  @depends-on single, two.parts, three.part.ref, deep.nested.ref.path
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(false);

      const ast = transformToAST(tree!);
      const req = ast.modules[0]!.features[0]!.requirements[0]!;
      expect(req.dependencies).toHaveLength(1);

      const refs = req.dependencies[0]!.references;
      expect(refs).toHaveLength(4);

      // 1-part reference
      expect(refs[0]!.parts).toEqual(["single"]);
      expect(refs[0]!.path).toBe("single");

      // 2-part reference
      expect(refs[1]!.parts).toEqual(["two", "parts"]);
      expect(refs[1]!.path).toBe("two.parts");

      // 3-part reference (valid per spec)
      expect(refs[2]!.parts).toEqual(["three", "part", "ref"]);
      expect(refs[2]!.path).toBe("three.part.ref");

      // 4-part reference (beyond spec, but parsed gracefully)
      expect(refs[3]!.parts).toEqual(["deep", "nested", "ref", "path"]);
      expect(refs[3]!.path).toBe("deep.nested.ref.path");
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
    describe("duplicate identifier handling", () => {
      test("duplicate module names - last one wins and duplicate is reported", () => {
        const code = `
@module authentication
  First auth module.

@module authentication
  Second auth module (duplicate).
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        // Map.set() overwrites, so only one entry exists
        expect(symbolTable.modules.size).toBe(1);
        expect(symbolTable.modules.has("authentication")).toBe(true);
        // The last module wins (second one)
        expect(symbolTable.modules.get("authentication")!.description).toContain(
          "Second auth module"
        );

        // Duplicate should be reported
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]!.kind).toBe("module");
        expect(duplicates[0]!.path).toBe("authentication");
        expect((duplicates[0]!.original as any).description).toContain("First auth module");
        expect((duplicates[0]!.duplicate as any).description).toContain("Second auth module");
      });

      test("duplicate feature names within same module - last one wins and duplicate is reported", () => {
        const code = `
@module authentication

@feature login
  First login feature.

@feature login
  Second login feature (duplicate).
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        expect(symbolTable.features.size).toBe(1);
        expect(symbolTable.features.has("authentication.login")).toBe(true);
        expect(symbolTable.features.get("authentication.login")!.description).toContain(
          "Second login feature"
        );

        // Duplicate should be reported
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]!.kind).toBe("feature");
        expect(duplicates[0]!.path).toBe("authentication.login");
      });

      test("same feature name in different modules - both preserved, no duplicates", () => {
        const code = `
@module authentication

@feature login
  Auth login.

@module payments

@feature login
  Payments login.
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        // Different fully-qualified paths, so both are kept
        expect(symbolTable.features.size).toBe(2);
        expect(symbolTable.features.has("authentication.login")).toBe(true);
        expect(symbolTable.features.has("payments.login")).toBe(true);
        expect(symbolTable.features.get("authentication.login")!.description).toContain(
          "Auth login"
        );
        expect(symbolTable.features.get("payments.login")!.description).toContain("Payments login");

        // No duplicates because paths are different
        expect(duplicates).toHaveLength(0);
      });

      test("duplicate requirement names within same feature - last one wins and duplicate is reported", () => {
        const code = `
@module authentication

@feature login

@requirement basic-auth
  First basic-auth.

@requirement basic-auth
  Second basic-auth (duplicate).
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        expect(symbolTable.requirements.size).toBe(1);
        expect(symbolTable.requirements.has("authentication.login.basic-auth")).toBe(true);
        expect(
          symbolTable.requirements.get("authentication.login.basic-auth")!.description
        ).toContain("Second basic-auth");

        // Duplicate should be reported
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]!.kind).toBe("requirement");
        expect(duplicates[0]!.path).toBe("authentication.login.basic-auth");
      });

      test("same requirement name in different features - both preserved, no duplicates", () => {
        const code = `
@module authentication

@feature login

@requirement validate
  Login validation.

@feature logout

@requirement validate
  Logout validation.
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        expect(symbolTable.requirements.size).toBe(2);
        expect(symbolTable.requirements.has("authentication.login.validate")).toBe(true);
        expect(symbolTable.requirements.has("authentication.logout.validate")).toBe(true);

        // No duplicates because paths are different
        expect(duplicates).toHaveLength(0);
      });

      test("duplicate constraint names within same requirement - last one wins and duplicate is reported", () => {
        const code = `
@module authentication

@feature login

@requirement basic-auth
  Basic auth.

  @constraint security
    First security constraint.

  @constraint security
    Second security constraint (duplicate).
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        // Only one constraint with this path
        expect(symbolTable.constraints.has("authentication.login.basic-auth.security")).toBe(true);

        // Count how many constraints have "security" in their path
        let securityCount = 0;
        for (const key of symbolTable.constraints.keys()) {
          if (key.endsWith(".security")) {
            securityCount++;
          }
        }
        expect(securityCount).toBe(1);

        // Last one wins
        expect(
          symbolTable.constraints.get("authentication.login.basic-auth.security")!.description
        ).toContain("Second security constraint");

        // Duplicate should be reported
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]!.kind).toBe("constraint");
        expect(duplicates[0]!.path).toBe("authentication.login.basic-auth.security");
      });

      test("same constraint name in different requirements - both preserved, no duplicates", () => {
        const code = `
@module authentication

@feature login

@requirement basic-auth
  Basic auth.

  @constraint rate-limit
    Rate limit for basic auth.

@requirement oauth
  OAuth auth.

  @constraint rate-limit
    Rate limit for OAuth.
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        expect(symbolTable.constraints.has("authentication.login.basic-auth.rate-limit")).toBe(
          true
        );
        expect(symbolTable.constraints.has("authentication.login.oauth.rate-limit")).toBe(true);
        expect(
          symbolTable.constraints.get("authentication.login.basic-auth.rate-limit")!.description
        ).toContain("basic auth");
        expect(
          symbolTable.constraints.get("authentication.login.oauth.rate-limit")!.description
        ).toContain("OAuth");

        // No duplicates because paths are different
        expect(duplicates).toHaveLength(0);
      });

      test("duplicate module-level requirements - last one wins and duplicate is reported", () => {
        const code = `
@module authentication

@requirement global-check
  First global check.

@requirement global-check
  Second global check (duplicate).
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        expect(symbolTable.requirements.size).toBe(1);
        expect(symbolTable.requirements.has("authentication.global-check")).toBe(true);
        expect(symbolTable.requirements.get("authentication.global-check")!.description).toContain(
          "Second global check"
        );

        // Duplicate should be reported
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]!.kind).toBe("requirement");
        expect(duplicates[0]!.path).toBe("authentication.global-check");
      });

      test("duplicate module-level constraints - last one wins and duplicate is reported", () => {
        const code = `
@module authentication
  Auth module.

  @constraint global-security
    First global security.

  @constraint global-security
    Second global security (duplicate).
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { symbolTable, duplicates } = buildSymbolTable(ast);

        expect(symbolTable.constraints.has("authentication.global-security")).toBe(true);
        expect(
          symbolTable.constraints.get("authentication.global-security")!.description
        ).toContain("Second global security");

        // Duplicate should be reported
        expect(duplicates).toHaveLength(1);
        expect(duplicates[0]!.kind).toBe("constraint");
        expect(duplicates[0]!.path).toBe("authentication.global-security");
      });

      test("multiple duplicates in complex document", () => {
        const code = `
@module auth
  First auth.

@module auth
  Second auth.

@feature login
  First login.

@feature login
  Second login.

@requirement basic
  First basic.

@requirement basic
  Second basic.
`;
        const tree = parseDocument(code);
        const ast = transformToAST(tree!);
        const { duplicates } = buildSymbolTable(ast);

        // Should report 3 duplicates: module, feature, requirement
        expect(duplicates).toHaveLength(3);
        expect(duplicates.map((d) => d.kind)).toEqual(["module", "feature", "requirement"]);
      });
    });

    test("builds symbol table for modules", () => {
      const code = `
@module authentication
@module payments
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const { symbolTable } = buildSymbolTable(ast);

      expect(symbolTable.modules.has("authentication")).toBe(true);
      expect(symbolTable.modules.has("payments")).toBe(true);
      expect(symbolTable.modules.size).toBe(2);
    });

    test("builds symbol table for features", () => {
      const code = `
@module authentication

@feature login
@feature logout
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const { symbolTable } = buildSymbolTable(ast);

      expect(symbolTable.features.has("authentication.login")).toBe(true);
      expect(symbolTable.features.has("authentication.logout")).toBe(true);
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
      const { symbolTable } = buildSymbolTable(ast);

      expect(symbolTable.requirements.has("authentication.login.basic-auth")).toBe(true);
      expect(symbolTable.requirements.has("authentication.login.oauth")).toBe(true);
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
      const { symbolTable } = buildSymbolTable(ast);

      expect(symbolTable.constraints.has("authentication.login.basic-auth.bcrypt")).toBe(true);
      expect(symbolTable.constraints.has("authentication.login.basic-auth.rate-limit")).toBe(true);
    });

    test("handles module-level requirements", () => {
      const code = `
@module authentication

@requirement global-auth-check
  A global requirement.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const { symbolTable } = buildSymbolTable(ast);

      expect(symbolTable.requirements.has("authentication.global-auth-check")).toBe(true);
    });

    test("returns empty duplicates array when no duplicates exist", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.

  @constraint bcrypt
    Use bcrypt.
`;
      const tree = parseDocument(code);
      const ast = transformToAST(tree!);
      const { duplicates } = buildSymbolTable(ast);

      expect(duplicates).toHaveLength(0);
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

  describe("error recovery", () => {
    test("handles multiple @description blocks (uses last one)", () => {
      const code = `
@description
  First description.

@description
  Second description.

@module test
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      // The parse tree should have an error (grammar only allows one @description)
      expect(tree!.rootNode.hasError).toBe(true);

      // transformToAST should still work, using the last description block
      const ast = transformToAST(tree!);

      expect(ast.description).not.toBeNull();
      // The current behavior is to use the last description block encountered
      expect(ast.description!.text).toContain("Second description");
      expect(ast.modules).toHaveLength(1);
      expect(ast.modules[0]!.name).toBe("test");
    });

    test("handles @description after @module (invalid ordering)", () => {
      const code = `
@module authentication
  Handles user authentication.

@description
  This description appears after the module, which is invalid.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      // The parse tree should have an error because @description must come before @module
      expect(tree!.rootNode.hasError).toBe(true);

      // Verify an ERROR node exists in the parse tree
      const hasErrorNode = tree!.rootNode.children.some((child) => child.type === "ERROR");
      expect(hasErrorNode).toBe(true);

      // transformToAST should still work for error recovery
      const ast = transformToAST(tree!);
      expect(ast.type).toBe("document");

      // The description block should still be extracted (error recovery)
      // Note: The grammar wraps the module in an ERROR node, but the description_block
      // is parsed as a top-level node. The AST transformation finds description_block nodes.
      expect(ast.description).not.toBeNull();
      expect(ast.description!.text).toContain("This description appears after");

      // The module should still be recoverable from within the ERROR node
      // Current behavior: modules inside ERROR nodes are not extracted
      // This is acceptable for error recovery - diagnostics will flag the issue
    });

    test("detects @description placement for diagnostics", () => {
      const code = `
@module first
  First module.

@description
  Misplaced description.

@module second
  Second module.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      // Parse tree has error due to invalid @description placement
      expect(tree!.rootNode.hasError).toBe(true);

      // For diagnostic purposes, we can detect this by checking if:
      // 1. There's a description_block in the tree
      // 2. There's an ERROR node before it (indicating a module was wrapped in error)
      const children = tree!.rootNode.children;
      const descriptionIndex = children.findIndex((child) => child.type === "description_block");
      const errorIndex = children.findIndex((child) => child.type === "ERROR");

      // When @description comes after @module, the module gets wrapped in ERROR
      // and description_block appears as a sibling
      expect(descriptionIndex).toBeGreaterThan(-1);
      expect(errorIndex).toBeGreaterThan(-1);

      // The ERROR node appears before the description_block in the tree
      // This pattern can be used by diagnostics to detect misplaced @description
      expect(errorIndex).toBeLessThan(descriptionIndex);
    });

    describe("empty/missing identifier handling", () => {
      test("@module without identifier - parser uses next token as name", () => {
        // When @module has no identifier, the parser aggressively recovers by
        // wrapping the next keyword (@feature) in an ERROR node and using
        // its identifier as the module name
        const code = `
@module

@feature login
  Login feature.
`;
        const tree = parseDocument(code);
        expect(tree).not.toBeNull();

        // The parse tree has an error due to missing identifier
        expect(tree!.rootNode.hasError).toBe(true);

        const ast = transformToAST(tree!);
        expect(ast.type).toBe("document");

        // Parser recovery: @feature gets wrapped in ERROR, "login" becomes module name
        expect(ast.modules).toHaveLength(1);
        expect(ast.modules[0]!.name).toBe("login");
        // The feature_block is inside an ERROR node, so no features are extracted
        expect(ast.modules[0]!.features).toHaveLength(0);
      });

      test("@feature without identifier - requirement becomes module-level", () => {
        const code = `
@module auth
  Authentication module.

@feature

@requirement basic-auth
  Basic auth.
`;
        const tree = parseDocument(code);
        expect(tree).not.toBeNull();

        // Parse error expected
        expect(tree!.rootNode.hasError).toBe(true);

        const ast = transformToAST(tree!);
        expect(ast.type).toBe("document");

        // The module should still be extracted
        expect(ast.modules).toHaveLength(1);
        expect(ast.modules[0]!.name).toBe("auth");

        // Parser recovery: @feature keyword becomes an ERROR node,
        // and requirement_block becomes a sibling at module level
        expect(ast.modules[0]!.features).toHaveLength(0);
        expect(ast.modules[0]!.requirements).toHaveLength(1);
        expect(ast.modules[0]!.requirements[0]!.name).toBe("basic-auth");
      });

      test("@requirement without identifier - parser uses next token as name", () => {
        const code = `
@module auth

@feature login
  Login feature.

@requirement

  @constraint bcrypt
    Use bcrypt.
`;
        const tree = parseDocument(code);
        expect(tree).not.toBeNull();

        expect(tree!.rootNode.hasError).toBe(true);

        const ast = transformToAST(tree!);
        expect(ast.type).toBe("document");
        expect(ast.modules).toHaveLength(1);
        expect(ast.modules[0]!.features).toHaveLength(1);
        expect(ast.modules[0]!.features[0]!.name).toBe("login");

        // Parser recovery: @constraint gets wrapped in ERROR, "bcrypt" becomes requirement name
        expect(ast.modules[0]!.features[0]!.requirements).toHaveLength(1);
        expect(ast.modules[0]!.features[0]!.requirements[0]!.name).toBe("bcrypt");
        // The constraint is inside an ERROR node, so no constraints are extracted
        expect(ast.modules[0]!.features[0]!.requirements[0]!.constraints).toHaveLength(0);
      });

      test("@constraint without identifier - parser uses next line text as name", () => {
        // Unlike other keywords, @constraint without identifier does NOT produce
        // an error because the parser treats the next line's first word as the name
        const code = `
@module auth

@feature login

@requirement basic-auth
  Basic authentication.

  @constraint
    This constraint has no name.
`;
        const tree = parseDocument(code);
        expect(tree).not.toBeNull();

        // No parse error! The parser uses "This" as the constraint name
        expect(tree!.rootNode.hasError).toBe(false);

        const ast = transformToAST(tree!);
        expect(ast.type).toBe("document");
        expect(ast.modules).toHaveLength(1);

        const req = ast.modules[0]!.features[0]!.requirements[0];
        expect(req).toBeDefined();
        expect(req!.name).toBe("basic-auth");

        // The parser uses "This" from the next line as the constraint name
        expect(req!.constraints).toHaveLength(1);
        expect(req!.constraints[0]!.name).toBe("This");
        expect(req!.constraints[0]!.description).toContain("constraint has no name");
      });

      test("symbol table handles module-level requirements after feature error", () => {
        // When @feature has no identifier, the subsequent requirement
        // becomes a module-level requirement instead
        const code = `
@module auth

@feature

@requirement test-req
  A requirement that becomes module-level.
`;
        const tree = parseDocument(code);
        expect(tree!.rootNode.hasError).toBe(true);

        const ast = transformToAST(tree!);
        const { symbolTable } = buildSymbolTable(ast);

        // The module should be in the symbol table
        expect(symbolTable.modules.has("auth")).toBe(true);

        // Parser recovery: @feature becomes ERROR, requirement is at module level
        expect(ast.modules[0]!.features).toHaveLength(0);
        expect(ast.modules[0]!.requirements).toHaveLength(1);
        expect(ast.modules[0]!.requirements[0]!.name).toBe("test-req");

        // The requirement should be in the symbol table at module level
        expect(symbolTable.requirements.has("auth.test-req")).toBe(true);
      });

      test("subsequent valid elements are still parsed after missing identifier", () => {
        const code = `
@module

@module valid-module
  This is a valid module after an invalid one.

@feature valid-feature
  This is a valid feature.
`;
        const tree = parseDocument(code);
        expect(tree).not.toBeNull();

        // There should be an error from the first module
        expect(tree!.rootNode.hasError).toBe(true);

        const ast = transformToAST(tree!);

        // Due to parser recovery, the first @module uses "valid-module" as its name
        // (the second @module keyword gets wrapped in ERROR)
        // Then "valid-feature" becomes part of the first module
        expect(ast.modules.length).toBeGreaterThanOrEqual(1);

        // Check that valid-feature is parsed somewhere in the AST
        const allFeatures = ast.modules.flatMap((m) => m.features);
        const validFeature = allFeatures.find((f) => f.name === "valid-feature");
        expect(validFeature).toBeDefined();
      });
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
      const { symbolTable } = buildSymbolTable(ast);
      expect(symbolTable.modules.has("authentication")).toBe(true);
      expect(symbolTable.features.has("authentication.login")).toBe(true);
      expect(symbolTable.features.has("authentication.session")).toBe(true);
      expect(symbolTable.requirements.has("authentication.login.credentials-login")).toBe(true);
      expect(symbolTable.requirements.has("authentication.login.oauth-login")).toBe(true);
      expect(symbolTable.requirements.has("authentication.session.create-token")).toBe(true);
      expect(
        symbolTable.constraints.has("authentication.login.credentials-login.bcrypt-verification")
      ).toBe(true);
    });
  });
});
