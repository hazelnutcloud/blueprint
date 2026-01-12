import type { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity, type Connection, type Diagnostic } from "vscode-languageserver/node";
import { parseDocument, type Tree, type Node } from "./parser";
import {
  transformToAST,
  buildSymbolTable,
  type DocumentNode,
  type DuplicateIdentifier,
} from "./ast";

/**
 * Represents the parsed state of a Blueprint document.
 */
export interface DocumentState {
  /** The URI of the document */
  uri: string;
  /** The document version (increments on each change) */
  version: number;
  /** The parsed tree-sitter syntax tree */
  tree: Tree | null;
  /** Whether the document has parse errors */
  hasErrors: boolean;
  /** Diagnostics for this document */
  diagnostics: Diagnostic[];
}

/**
 * Manages the state of all open Blueprint documents.
 */
export class DocumentManager {
  private states: Map<string, DocumentState> = new Map();
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Called when a document is opened. Parses the document and stores its state.
   */
  onDocumentOpen(document: TextDocument): DocumentState {
    const state = this.parseAndCreateState(document);
    this.states.set(document.uri, state);
    this.publishDiagnostics(state);
    this.connection.console.log(`Document opened: ${document.uri}`);
    return state;
  }

  /**
   * Called when a document changes. Re-parses and updates the state.
   */
  onDocumentChange(document: TextDocument): DocumentState {
    const state = this.parseAndCreateState(document);
    this.states.set(document.uri, state);
    this.publishDiagnostics(state);
    this.connection.console.log(`Document changed: ${document.uri} (version ${document.version})`);
    return state;
  }

  /**
   * Called when a document is closed. Cleans up the state.
   */
  onDocumentClose(uri: string): void {
    const state = this.states.get(uri);
    if (state?.tree) {
      state.tree.delete();
    }
    this.states.delete(uri);
    // Clear diagnostics for closed document
    this.connection.sendDiagnostics({ uri, diagnostics: [] });
    this.connection.console.log(`Document closed: ${uri}`);
  }

  /**
   * Called when a document is saved. Triggers full validation.
   */
  onDocumentSave(document: TextDocument): DocumentState {
    // On save, we do a full re-parse and validation
    const state = this.parseAndCreateState(document);
    this.states.set(document.uri, state);
    this.publishDiagnostics(state);
    this.connection.console.log(`Document saved: ${document.uri}`);
    return state;
  }

  /**
   * Get the state for a document, or undefined if not tracked.
   */
  getState(uri: string): DocumentState | undefined {
    return this.states.get(uri);
  }

  /**
   * Get the syntax tree for a document, or null if not available.
   */
  getTree(uri: string): Tree | null {
    return this.states.get(uri)?.tree ?? null;
  }

  /**
   * Clean up all document states and free their resources.
   * Call this when the LSP server is shutting down.
   */
  cleanup(): void {
    this.states.forEach((state) => {
      if (state.tree) {
        state.tree.delete();
      }
    });
    this.states.clear();
  }

  /**
   * Parse a document and create its state.
   */
  private parseAndCreateState(document: TextDocument): DocumentState {
    const text = document.getText();
    const tree = parseDocument(text);

    // Check for parse errors in the tree
    const hasErrors = tree ? this.treeHasErrors(tree.rootNode) : true;
    const diagnostics = tree ? this.collectDiagnostics(tree) : [];

    return {
      uri: document.uri,
      version: document.version,
      tree,
      hasErrors,
      diagnostics,
    };
  }

  /**
   * Check if a tree-sitter node or its descendants have errors.
   */
  private treeHasErrors(node: Node): boolean {
    if (node.hasError) {
      return true;
    }
    for (const child of node.children) {
      if (this.treeHasErrors(child)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Collect diagnostics from parse errors and semantic validation.
   */
  private collectDiagnostics(tree: Tree): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    this.collectErrorNodes(tree.rootNode, diagnostics);
    this.validateDescriptionPlacement(tree.rootNode, diagnostics);

    // Transform to AST and check for duplicate identifiers
    const ast = transformToAST(tree);
    this.validateDuplicateIdentifiers(ast, diagnostics);

    return diagnostics;
  }

  /**
   * Validate that there are no duplicate identifiers within the same scope.
   *
   * Per SPEC.md Section 5.8:
   * - Error | Duplicate identifier in scope
   */
  private validateDuplicateIdentifiers(ast: DocumentNode, diagnostics: Diagnostic[]): void {
    const { duplicates } = buildSymbolTable(ast);

    for (const dup of duplicates) {
      const loc = dup.duplicate.location;
      const kindLabel = this.getDuplicateKindLabel(dup.kind);
      const originalLoc = dup.original.location;

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: loc.startLine, character: loc.startColumn },
          end: { line: loc.endLine, character: loc.endColumn },
        },
        message: `Duplicate ${kindLabel} identifier '${this.getIdentifierFromPath(dup.path)}'. First defined at line ${originalLoc.startLine + 1}.`,
        source: "blueprint",
      });
    }
  }

  /**
   * Get a human-readable label for a duplicate kind.
   */
  private getDuplicateKindLabel(kind: DuplicateIdentifier["kind"]): string {
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

  /**
   * Extract the identifier from a fully-qualified path.
   * E.g., "auth.login.basic-auth" -> "basic-auth"
   */
  private getIdentifierFromPath(path: string): string {
    const parts = path.split(".");
    return parts[parts.length - 1] || path;
  }

  /**
   * Validate that @description blocks appear before any @module declarations
   * and that there is at most one @description block.
   *
   * Per SPEC.md Section 3.2.1:
   * - @description may only appear once per .bp file
   * - @description must appear before any @module declaration
   *
   * Note: When the grammar encounters invalid ordering, it may wrap elements
   * in ERROR nodes. We need to look inside ERROR nodes to find the actual
   * description_block and module_block elements for validation.
   */
  private validateDescriptionPlacement(root: Node, diagnostics: Diagnostic[]): void {
    // Track all description and module blocks with their positions
    // We use the index in the root.children array to determine order
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

      // Report error on all but the first description block
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
  }

  /**
   * Recursively collect error nodes from the syntax tree.
   */
  private collectErrorNodes(node: Node, diagnostics: Diagnostic[]): void {
    // Check for ERROR nodes (parse errors) and MISSING nodes
    if (node.type === "ERROR" || node.isMissing) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: node.startPosition.row, character: node.startPosition.column },
          end: { line: node.endPosition.row, character: node.endPosition.column },
        },
        message: node.isMissing ? this.getMissingNodeMessage(node) : this.getErrorNodeMessage(node),
        source: "blueprint",
      });
    }

    // Recurse into children
    for (const child of node.children) {
      this.collectErrorNodes(child, diagnostics);
    }
  }

  /**
   * Generate a meaningful error message for a MISSING node.
   */
  private getMissingNodeMessage(node: Node): string {
    const nodeType = node.type;

    // Handle specific missing node types
    switch (nodeType) {
      case "identifier":
        return this.getMissingIdentifierMessage(node);
      case "```":
        return "Missing closing ``` for code block";
      case "*/":
        return "Missing closing */ for multi-line comment";
      default:
        return `Missing ${nodeType}`;
    }
  }

  /**
   * Generate a message for a missing identifier based on its parent context.
   */
  private getMissingIdentifierMessage(node: Node): string {
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

  /**
   * Generate a meaningful error message for an ERROR node.
   */
  private getErrorNodeMessage(node: Node): string {
    const errorText = node.text.trim();
    const parent = node.parent;

    // Check for common error patterns

    // 1. Identifier starting with a digit
    if (/^\d/.test(errorText)) {
      return `Invalid identifier '${this.truncateText(errorText)}': identifiers cannot start with a digit`;
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
      const contextMessage = this.getContextualErrorMessage(node, parent, errorText);
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

  /**
   * Get an error message based on the parent context.
   */
  private getContextualErrorMessage(node: Node, parent: Node, errorText: string): string | null {
    switch (parent.type) {
      case "depends_on":
        // Check for missing comma between references
        if (/^[a-zA-Z_]/.test(errorText) && !errorText.startsWith("@")) {
          return `Missing comma before reference '${this.truncateText(errorText)}'`;
        }
        return `Invalid reference in @depends-on: '${this.truncateText(errorText)}'`;

      case "reference":
        if (errorText === ".") {
          return "Missing identifier after '.' in reference";
        }
        if (errorText.startsWith(".")) {
          return "Reference cannot start with '.'";
        }
        return `Invalid reference: '${this.truncateText(errorText)}'`;

      case "code_block":
        if (errorText.includes("```")) {
          return "Nested code blocks are not allowed";
        }
        return null;

      case "module_block":
      case "feature_block":
      case "requirement_block":
      case "constraint":
        // Error in a block - could be many things
        if (errorText.startsWith("@")) {
          const keyword = errorText.split(/\s/)[0];
          return `Unexpected ${keyword} in ${parent.type.replace("_block", "").replace("_", " ")}`;
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Truncate text for display in error messages.
   */
  private truncateText(text: string, maxLength: number = 30): string {
    const singleLine = text.replace(/\n/g, " ").trim();
    if (singleLine.length <= maxLength) {
      return singleLine;
    }
    return singleLine.substring(0, maxLength - 3) + "...";
  }

  /**
   * Publish diagnostics to the client.
   */
  private publishDiagnostics(state: DocumentState): void {
    this.connection.sendDiagnostics({
      uri: state.uri,
      diagnostics: state.diagnostics,
    });
  }
}
