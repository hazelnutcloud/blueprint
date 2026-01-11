import type { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity, type Connection, type Diagnostic } from "vscode-languageserver/node";
import { parseDocument, type Tree, type Node } from "./parser";

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
    return diagnostics;
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
  private validateDescriptionPlacement(
    root: Node,
    diagnostics: Diagnostic[]
  ): void {
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
          message: "Multiple @description blocks in one file. Only one @description is allowed per file.",
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
  private collectErrorNodes(
    node: Node,
    diagnostics: Diagnostic[]
  ): void {
    // Check for ERROR nodes (parse errors) and MISSING nodes
    if (node.type === "ERROR" || node.isMissing) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: node.startPosition.row, character: node.startPosition.column },
          end: { line: node.endPosition.row, character: node.endPosition.column },
        },
        message: node.isMissing
          ? `Missing ${node.type}`
          : `Syntax error: unexpected input`,
        source: "blueprint",
      });
    }

    // Recurse into children
    for (const child of node.children) {
      this.collectErrorNodes(child, diagnostics);
    }
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
