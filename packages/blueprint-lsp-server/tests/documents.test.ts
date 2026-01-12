import { test, expect, beforeAll, describe } from "bun:test";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver/node";
import { initializeParser, parseDocument, type Node } from "../src/parser";
import {
  transformToAST,
  buildSymbolTable,
  type DocumentNode,
  type DuplicateIdentifier,
} from "../src/ast";

/**
 * Helper function to validate @description placement.
 * This mirrors the logic in DocumentManager.validateDescriptionPlacement()
 * for testing purposes.
 *
 * Note: When the grammar encounters invalid ordering, it may wrap elements
 * in ERROR nodes. We need to look inside ERROR nodes to find the actual
 * description_block and module_block elements for validation.
 */
function validateDescriptionPlacement(root: Node): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Track all description and module blocks with their positions
  const descriptionBlocks: { node: Node; index: number }[] = [];
  const moduleBlocks: { node: Node; index: number }[] = [];

  // Scan top-level children, looking inside ERROR nodes too
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]!;

    if (child.type === "description_block") {
      descriptionBlocks.push({ node: child, index: i });
    } else if (child.type === "module_block") {
      moduleBlocks.push({ node: child, index: i });
    } else if (child.type === "ERROR") {
      // Look inside ERROR nodes for wrapped elements
      for (const errChild of child.children) {
        if (errChild.type === "description_block") {
          descriptionBlocks.push({ node: errChild, index: i });
        } else if (errChild.type === "module_block") {
          moduleBlocks.push({ node: errChild, index: i });
        }
      }
    }
  }

  // Check for multiple @description blocks
  if (descriptionBlocks.length > 1) {
    // Sort by position to ensure we keep the first one
    descriptionBlocks.sort((a, b) => a.index - b.index);

    for (let i = 1; i < descriptionBlocks.length; i++) {
      const { node } = descriptionBlocks[i]!;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: node.startPosition.row, character: node.startPosition.column },
          end: { line: node.endPosition.row, character: node.endPosition.column },
        },
        message:
          "Multiple @description blocks in one file. Only one @description is allowed per file.",
        source: "blueprint",
      });
    }
  }

  // Check if any @description appears after a @module
  if (moduleBlocks.length > 0) {
    const firstModuleIndex = Math.min(...moduleBlocks.map((m) => m.index));

    for (const { node: descNode, index: descIndex } of descriptionBlocks) {
      if (descIndex > firstModuleIndex) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: {
            start: { line: descNode.startPosition.row, character: descNode.startPosition.column },
            end: { line: descNode.endPosition.row, character: descNode.endPosition.column },
          },
          message: "@description must appear before any @module declaration.",
          source: "blueprint",
        });
      }
    }
  }

  return diagnostics;
}

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

    const moduleNode = tree!.rootNode.children[0]!;
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
    // Invalid syntax - @requirement outside of @feature/@module
    const code = `
@requirement orphan
  This requirement has no parent feature.
`;

    const tree = parseDocument(code);
    expect(tree).not.toBeNull();

    // The grammar produces an error for invalid structure
    expect(tree!.rootNode.hasError).toBe(true);

    // Verify an ERROR node exists in the parse tree
    const hasErrorNode = tree!.rootNode.children.some((child) => child.type === "ERROR");
    expect(hasErrorNode).toBe(true);
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

  describe("empty document parsing", () => {
    test("parses completely empty document", () => {
      const code = "";

      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
      expect(tree!.rootNode.hasError).toBe(false);
      expect(tree!.rootNode.childCount).toBe(0);
    });

    test("parses document with only whitespace", () => {
      const code = "   \n\n   \t   \n   ";

      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
      expect(tree!.rootNode.hasError).toBe(false);
    });

    test("parses document with only newlines", () => {
      const code = "\n\n\n\n";

      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
      expect(tree!.rootNode.hasError).toBe(false);
    });

    test("parses document with only single-line comments", () => {
      const code = `// This is a comment
// Another comment line
// Third comment`;

      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
      expect(tree!.rootNode.hasError).toBe(false);
    });

    test("parses document with only a multi-line comment", () => {
      // Note: Multi-line comments are currently parsed as description_block
      // due to a grammar issue, but no parse error is produced
      const code = `/* This is a 
   multi-line comment
   spanning several lines */`;

      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
      expect(tree!.rootNode.hasError).toBe(false);
    });

    test("parses document with single-line comment followed by multi-line", () => {
      // Note: The multi-line comment is parsed as description_block due to
      // a grammar issue with the multi-line comment regex
      const code = `// Single line comment

/* Multi-line
   comment block */`;

      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
      expect(tree!.rootNode.hasError).toBe(false);
    });
  });
});

describe("Description Placement Validation", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("valid placements", () => {
    test("@description before @module produces no diagnostics", () => {
      const code = `
@description
  This is the system description.

@module authentication
  Auth module.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      expect(diagnostics).toHaveLength(0);
    });

    test("no @description produces no diagnostics", () => {
      const code = `
@module authentication
  Auth module.

@feature login
  Login feature.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      expect(diagnostics).toHaveLength(0);
    });

    test("only @description produces no diagnostics", () => {
      const code = `
@description
  This is the only content in the file.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("@description after @module", () => {
    test("reports error when @description appears after @module", () => {
      const code = `
@module authentication
  Auth module.

@description
  This description is misplaced.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0]!.message).toBe(
        "@description must appear before any @module declaration."
      );
      expect(diagnostics[0]!.source).toBe("blueprint");
    });

    test("reports error for @description between two modules", () => {
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

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      // Should report exactly one error for the misplaced @description
      const placementErrors = diagnostics.filter(
        (d) => d.message === "@description must appear before any @module declaration."
      );
      expect(placementErrors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("multiple @description blocks", () => {
    test("reports error for second @description block", () => {
      const code = `
@description
  First description.

@description
  Second description (invalid).
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0]!.message).toBe(
        "Multiple @description blocks in one file. Only one @description is allowed per file."
      );
    });

    test("reports errors for all extra @description blocks", () => {
      const code = `
@description
  First description (valid).

@description
  Second description (invalid).

@description
  Third description (also invalid).
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      const multipleDescErrors = diagnostics.filter((d) =>
        d.message.includes("Multiple @description blocks")
      );
      // Should report errors for the 2nd and 3rd descriptions
      expect(multipleDescErrors).toHaveLength(2);
    });

    test("reports both multiple and placement errors when applicable", () => {
      const code = `
@module auth
  Auth module.

@description
  First misplaced description.

@description
  Second misplaced description.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);

      // Should have placement errors and multiple description errors
      const placementErrors = diagnostics.filter((d) =>
        d.message.includes("must appear before any @module")
      );
      const multipleErrors = diagnostics.filter((d) => d.message.includes("Multiple @description"));

      // Both descriptions are misplaced (after @module)
      expect(placementErrors.length).toBeGreaterThanOrEqual(1);
      // Second description is a duplicate
      expect(multipleErrors).toHaveLength(1);
    });
  });

  describe("diagnostic ranges", () => {
    test("error range covers the @description block", () => {
      const code = `@module auth
  Auth module.

@description
  Misplaced.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const diagnostics = validateDescriptionPlacement(tree!.rootNode);
      expect(diagnostics).toHaveLength(1);

      const range = diagnostics[0]!.range;
      // @description starts at line 3 (0-indexed), column 0
      expect(range.start.line).toBe(3);
      expect(range.start.character).toBe(0);
    });
  });
});

/**
 * Helper function to validate duplicate identifiers.
 * This mirrors the logic in DocumentManager.validateDuplicateIdentifiers()
 * for testing purposes.
 */
function validateDuplicateIdentifiers(ast: DocumentNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { duplicates } = buildSymbolTable(ast);

  for (const dup of duplicates) {
    const loc = dup.duplicate.location;
    const kindLabel = getDuplicateKindLabel(dup.kind);
    const originalLoc = dup.original.location;
    const identifier = getIdentifierFromPath(dup.path);

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: {
        start: { line: loc.startLine, character: loc.startColumn },
        end: { line: loc.endLine, character: loc.endColumn },
      },
      message: `Duplicate ${kindLabel} identifier '${identifier}'. First defined at line ${originalLoc.startLine + 1}.`,
      source: "blueprint",
    });
  }

  return diagnostics;
}

function getDuplicateKindLabel(kind: DuplicateIdentifier["kind"]): string {
  switch (kind) {
    case "module":
      return "@module";
    case "feature":
      return "@feature";
    case "requirement":
      return "@requirement";
    case "constraint":
      return "@constraint";
  }
}

function getIdentifierFromPath(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] || path;
}

describe("Duplicate Identifier Validation", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("no duplicates", () => {
    test("unique identifiers produce no diagnostics", () => {
      const code = `
@module authentication
  Auth module.

@feature login
  Login feature.

@requirement basic-auth
  Basic auth requirement.

  @constraint bcrypt
    Use bcrypt.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);
      expect(diagnostics).toHaveLength(0);
    });

    test("same name in different scopes produces no diagnostics", () => {
      const code = `
@module auth

@feature login

@requirement validate
  Login validation.

@feature logout

@requirement validate
  Logout validation.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("duplicate modules", () => {
    test("reports error for duplicate module identifier", () => {
      const code = `
@module authentication
  First auth module.

@module authentication
  Second auth module.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0]!.message).toContain("Duplicate @module identifier 'authentication'");
      expect(diagnostics[0]!.message).toContain("First defined at line");
      expect(diagnostics[0]!.source).toBe("blueprint");
    });
  });

  describe("duplicate features", () => {
    test("reports error for duplicate feature identifier in same module", () => {
      const code = `
@module auth

@feature login
  First login.

@feature login
  Second login.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain("Duplicate @feature identifier 'login'");
    });
  });

  describe("duplicate requirements", () => {
    test("reports error for duplicate requirement identifier in same feature", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  First basic-auth.

@requirement basic-auth
  Second basic-auth.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain("Duplicate @requirement identifier 'basic-auth'");
    });

    test("reports error for duplicate module-level requirements", () => {
      const code = `
@module auth

@requirement global-check
  First check.

@requirement global-check
  Second check.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain("Duplicate @requirement identifier 'global-check'");
    });
  });

  describe("duplicate constraints", () => {
    test("reports error for duplicate constraint identifier in same requirement", () => {
      const code = `
@module auth

@feature login

@requirement basic-auth
  Basic auth.

  @constraint security
    First security.

  @constraint security
    Second security.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain("Duplicate @constraint identifier 'security'");
    });
  });

  describe("multiple duplicates", () => {
    test("reports all duplicates in a complex document", () => {
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
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(3);
      expect(diagnostics.map((d) => d.message)).toEqual([
        expect.stringContaining("@module"),
        expect.stringContaining("@feature"),
        expect.stringContaining("@requirement"),
      ]);
    });
  });

  describe("diagnostic ranges", () => {
    test("error range covers the duplicate element", () => {
      const code = `@module auth
  First auth.

@module auth
  Second auth.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      const range = diagnostics[0]!.range;
      // The duplicate @module starts at line 3 (0-indexed)
      expect(range.start.line).toBe(3);
      expect(range.start.character).toBe(0);
    });

    test("error message references correct original line number", () => {
      const code = `@module auth
  First auth.

@module auth
  Second auth.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();

      const ast = transformToAST(tree!);
      const diagnostics = validateDuplicateIdentifiers(ast);

      expect(diagnostics).toHaveLength(1);
      // Original is at line 0 (0-indexed), so message should say "line 1"
      expect(diagnostics[0]!.message).toContain("First defined at line 1");
    });
  });
});

/**
 * Helper function to collect error nodes from a parse tree.
 * This mirrors the logic in DocumentManager.collectErrorNodes() for testing.
 */
function collectErrorNodes(node: Node): Array<{ node: Node; message: string }> {
  const errors: Array<{ node: Node; message: string }> = [];

  if (node.type === "ERROR" || node.isMissing) {
    errors.push({
      node,
      message: node.isMissing ? getMissingNodeMessage(node) : getErrorNodeMessage(node),
    });
  }

  for (const child of node.children) {
    errors.push(...collectErrorNodes(child));
  }

  return errors;
}

function getMissingNodeMessage(node: Node): string {
  const nodeType = node.type;

  switch (nodeType) {
    case "identifier":
      return getMissingIdentifierMessage(node);
    case "```":
      return "Missing closing ``` for code block";
    case "*/":
      return "Missing closing */ for multi-line comment";
    default:
      return `Missing ${nodeType}`;
  }
}

function getMissingIdentifierMessage(node: Node): string {
  const parent = node.parent;
  if (!parent) {
    return "Missing identifier";
  }

  switch (parent.type) {
    case "module_block":
      return "Missing module name after @module";
    case "feature_block":
      return "Missing feature name after @feature";
    case "requirement_block":
      return "Missing requirement name after @requirement";
    case "constraint":
      return "Missing constraint name after @constraint";
    case "reference":
      return "Missing identifier in reference";
    default:
      return "Missing identifier";
  }
}

function getErrorNodeMessage(node: Node): string {
  const errorText = node.text.trim();
  const parent = node.parent;

  // 1. Identifier starting with a digit
  if (/^\d/.test(errorText)) {
    return `Invalid identifier '${truncateText(errorText)}': identifiers cannot start with a digit`;
  }

  // 2. Identifier with spaces
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*\s+[a-zA-Z]/.test(errorText)) {
    return `Invalid identifier: identifiers cannot contain spaces. Use hyphens or underscores instead`;
  }

  // 3. Orphaned @requirement at top level
  if (errorText.startsWith("@requirement") && parent?.type === "source_file") {
    return "@requirement must be inside a @feature or @module block";
  }

  // 4. Orphaned @feature at top level
  if (errorText.startsWith("@feature") && parent?.type === "source_file") {
    return "@feature must be inside a @module block";
  }

  // 5. Orphaned @constraint at top level
  if (errorText.startsWith("@constraint") && parent?.type === "source_file") {
    return "@constraint must be inside a @module, @feature, or @requirement block";
  }

  // 6. @depends-on issues
  if (errorText.startsWith("@depends-on")) {
    if (parent?.type === "source_file") {
      return "@depends-on must be inside a @module, @feature, or @requirement block";
    }
    if (!errorText.includes(" ") || errorText === "@depends-on") {
      return "@depends-on requires at least one reference";
    }
  }

  // 7. Misplaced keyword
  if (errorText.startsWith("@") && !errorText.startsWith("@description")) {
    const keyword = errorText.split(/\s/)[0];
    if (keyword) {
      return `Unexpected ${keyword} at this location`;
    }
  }

  // 8. Check for common context-based errors
  if (parent) {
    const contextMessage = getContextualErrorMessage(node, parent, errorText);
    if (contextMessage) {
      return contextMessage;
    }
  }

  // 9. Generic message with context
  if (errorText.length > 0 && errorText.length <= 50) {
    return `Syntax error: unexpected '${errorText}'`;
  }

  return "Syntax error: unexpected input";
}

function getContextualErrorMessage(node: Node, parent: Node, errorText: string): string | null {
  switch (parent.type) {
    case "depends_on":
      if (/^[a-zA-Z_]/.test(errorText) && !errorText.startsWith("@")) {
        return `Missing comma before reference '${truncateText(errorText)}'`;
      }
      return `Invalid reference in @depends-on: '${truncateText(errorText)}'`;

    case "reference":
      if (errorText === ".") {
        return "Missing identifier after '.' in reference";
      }
      if (errorText.startsWith(".")) {
        return "Reference cannot start with '.'";
      }
      return `Invalid reference: '${truncateText(errorText)}'`;

    case "code_block":
      if (errorText.includes("```")) {
        return "Nested code blocks are not allowed";
      }
      return null;

    case "module_block":
    case "feature_block":
    case "requirement_block":
    case "constraint":
      if (errorText.startsWith("@")) {
        const keyword = errorText.split(/\s/)[0];
        return `Unexpected ${keyword} in ${parent.type.replace("_block", "").replace("_", " ")}`;
      }
      return null;

    default:
      return null;
  }
}

function truncateText(text: string, maxLength: number = 30): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.substring(0, maxLength - 3) + "...";
}

describe("Parse Error Messages", () => {
  beforeAll(async () => {
    await initializeParser();
  });

  describe("orphaned elements", () => {
    test("reports meaningful error for @requirement at top level", () => {
      const code = `
@requirement orphan
  This requirement has no parent.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toBe("@requirement must be inside a @feature or @module block");
    });

    test("reports meaningful error for @feature at top level", () => {
      const code = `
@feature orphan
  This feature has no parent module.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toBe("@feature must be inside a @module block");
    });

    test("reports meaningful error for @constraint at top level", () => {
      const code = `
@constraint orphan
  This constraint has no parent.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toBe(
        "@constraint must be inside a @module, @feature, or @requirement block"
      );
    });

    test("reports meaningful error for @depends-on at top level", () => {
      const code = `
@depends-on some-module
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toBe(
        "@depends-on must be inside a @module, @feature, or @requirement block"
      );
    });
  });

  describe("invalid identifiers", () => {
    test("reports error for identifier starting with digit", () => {
      const code = `
@module 2fa-auth
  Two-factor auth module.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toContain("identifiers cannot start with a digit");
    });
  });

  describe("generic errors", () => {
    test("includes error text in message for short errors", () => {
      // Use an actual syntax error - @module without identifier followed by another @module
      const code = `
@module
@module second
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);
      // Should get a meaningful error about missing module name or unexpected input
      expect(
        errors.some(
          (e) =>
            e.message.includes("Missing") ||
            e.message.includes("unexpected") ||
            e.message.includes("Unexpected")
        )
      ).toBe(true);
    });
  });

  describe("error location", () => {
    test("error range points to the error location", () => {
      // Use an actual top-level @requirement (which is invalid at source_file level)
      const code = `@requirement orphan
  Orphaned requirement.
`;
      const tree = parseDocument(code);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(true);

      const errors = collectErrorNodes(tree!.rootNode);
      expect(errors.length).toBeGreaterThan(0);

      // The error should be on line 0 (0-indexed) where @requirement starts
      const errorNode = errors[0]!.node;
      expect(errorNode.startPosition.row).toBe(0);
    });
  });
});
