import { Parser, Tree, Language, Node } from "web-tree-sitter";
import * as path from "node:path";
import * as fs from "node:fs";

let parser: Parser | null = null;
let isInitializing = false;
let initPromise: Promise<Parser> | null = null;

// Re-export types for use in other modules
export type { Tree, Node };

/**
 * Initialize the tree-sitter parser with the Blueprint grammar.
 * This is idempotent - multiple calls will return the same parser instance.
 */
export async function initializeParser(): Promise<Parser> {
  // Return existing parser if already initialized
  if (parser) {
    return parser;
  }

  // If already initializing, wait for that to complete
  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;
  initPromise = doInitialize();

  try {
    parser = await initPromise;
    return parser;
  } finally {
    isInitializing = false;
  }
}

async function doInitialize(): Promise<Parser> {
  // Initialize the tree-sitter WASM module
  await Parser.init();

  const newParser = new Parser();

  // Find the WASM file - check multiple possible locations
  const wasmPaths = [
    // When running from the server package directly
    path.resolve(__dirname, "../../tree-sitter-blueprint/tree-sitter-blueprint.wasm"),
    // When running from dist/bundled location
    path.resolve(__dirname, "../tree-sitter-blueprint.wasm"),
    // Monorepo sibling package
    path.resolve(__dirname, "../../../tree-sitter-blueprint/tree-sitter-blueprint.wasm"),
  ];

  let wasmPath: string | null = null;
  for (const p of wasmPaths) {
    if (fs.existsSync(p)) {
      wasmPath = p;
      break;
    }
  }

  if (!wasmPath) {
    throw new Error(
      `Could not find tree-sitter-blueprint.wasm. Searched in:\n${wasmPaths.join("\n")}`
    );
  }

  // Load the Blueprint language grammar
  const language = await Language.load(wasmPath);
  newParser.setLanguage(language);

  return newParser;
}

/**
 * Parse a Blueprint document and return the syntax tree.
 */
export function parseDocument(text: string): Tree | null {
  if (!parser) {
    return null;
  }
  return parser.parse(text);
}

/**
 * Get the current parser instance, or null if not initialized.
 */
export function getParser(): Parser | null {
  return parser;
}
