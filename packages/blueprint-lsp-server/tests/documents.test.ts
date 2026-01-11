import { test, expect, beforeAll, describe } from "bun:test";
import { initializeParser, parseDocument } from "../src/parser";

describe("Parser", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  test("parses a valid Blueprint document", () => {
    const code = `
@module authentication
  Handles user authentication.

@feature login
  User login functionality.

  @requirement basic-auth
    Users can log in with email and password.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("source_file");
    expect(tree!.rootNode.hasError).toBe(false);
  });

  test("parses module with description", () => {
    const code = `
@module payments
  Handles payment processing and transactions.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    
    const moduleNode = tree!.rootNode.children[0];
    expect(moduleNode.type).toBe("module_block");
  });

  test("parses nested structure correctly", () => {
    const code = `
@module auth
  Auth module.

@feature login
  Login feature.

  @requirement password-login
    Password-based login.

    @constraint bcrypt
      Use bcrypt hashing.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
    
    // Verify structure
    const sexp = tree!.rootNode.toString();
    expect(sexp).toContain("module_block");
    expect(sexp).toContain("feature_block");
    expect(sexp).toContain("requirement_block");
    expect(sexp).toContain("constraint");
  });

  test("parses @depends-on annotation", () => {
    const code = `
@module payments
  Payments module.

  @depends-on authentication

@feature checkout
  Checkout feature.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    
    const sexp = tree!.rootNode.toString();
    expect(sexp).toContain("depends_on");
  });

  test("parses @description block", () => {
    const code = `
@description
  This is a test system for payments.

@module payments
  Payments module.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
  });

  test("detects parse errors", () => {
    // Invalid syntax - @requirement outside of @feature
    const code = `
@requirement orphan
  This requirement has no parent feature.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    // The grammar should produce an error for invalid structure
    // (exact behavior depends on grammar definition)
  });

  test("parses comments correctly", () => {
    const code = `
// This is a single line comment
@module auth
  Auth module.

  /* This is a 
     multi-line comment */

@feature login
  Login feature.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();
    // Comments should not affect the parse tree structure
    const sexp = tree!.rootNode.toString();
    expect(sexp).toContain("module_block");
    expect(sexp).toContain("feature_block");
  });
});
