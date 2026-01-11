# Blueprint LSP Implementation Plan

## Overview

This document outlines the implementation plan for the Blueprint DSL Language Server Protocol (LSP) implementation. The LSP will provide IDE integration for `.bp` requirement files including syntax highlighting, diagnostics, hover information, navigation, and integration with ticket artifacts.

**Tech Stack:**
- Language/Runtime: TypeScript/Node
- Package Manager: Bun
- Parser: tree-sitter
- LSP Framework: vscode-languageserver + vscode-languageclient
- Testing: Bun
- Bundling: zshy

---

## Phase 1: Project Setup & Infrastructure

### 1.1 Project Initialization
- [x] Initialize monorepo structure with packages for `server`, `client`, and `tree-sitter-blueprint`
- [x] Configure `package.json` with workspaces for monorepo management
- [x] Set up TypeScript configuration (`tsconfig.json`) for each package
- [x] Configure Bun as the package manager and test runner
- [ ] Set up zshy bundler configuration for production builds
- [x] Create `.gitignore` with appropriate exclusions

### 1.2 Development Environment
- [ ] Configure ESLint and Prettier for code quality
- [ ] Set up VS Code workspace settings for development
- [ ] Create launch configurations for debugging the LSP server and client
- [ ] Set up hot-reload for development iteration

---

## Phase 2: Tree-sitter Grammar Definition

### 2.1 Grammar Specification
- [x] Create `tree-sitter-blueprint` package directory structure
- [x] Define `grammar.js` with lexical rules:
  - [x] UTF-8 character set handling
  - [x] Line ending normalization (LF/CRLF)
  - [x] Single-line comments (`// ...`)
  - [x] Multi-line comments (`/* ... */`)
  - [x] Identifier pattern: `[a-zA-Z_][a-zA-Z0-9_-]*`
  - [x] Whitespace and indentation handling

### 2.2 Document-Level Rules
- [x] Define `@description` keyword and block parsing
- [x] Implement description-text capture (free-form prose until next keyword)

### 2.3 Hierarchy Keywords
- [x] Define `@module` rule with identifier and description-text
- [x] Define `@feature` rule with identifier and description-text
- [x] Define `@requirement` rule with identifier and description-text
- [x] Implement proper nesting validation (features in modules, requirements in features)

### 2.4 Annotation Keywords
- [x] Define `@depends-on` rule with comma-separated reference list
- [x] Implement reference parsing (dot-notation: `module.feature.requirement`)
- [x] Define `@constraint` rule with identifier and description-text

### 2.5 Description Block Handling
- [x] Parse free-form prose text
- [x] Handle fenced code blocks (``` ... ```)
- [x] Preserve paragraph separation (blank lines)

### 2.6 Grammar Testing
- [x] Write corpus tests for valid syntax cases
- [x] Write corpus tests for edge cases (empty files, minimal documents)
- [x] Write corpus tests for error recovery scenarios
- [x] Generate and compile the tree-sitter parser

Note: The LSP server will use web-tree-sitter (WASM bindings) instead of native Node.js bindings. 
WASM is the standard approach for tree-sitter LSP servers (e.g., bash-language-server) because it's 
easier to distribute and works across all platforms without native compilation. The existing 
`tree-sitter build --wasm` script generates the required `.wasm` file.

---

## Phase 3: Core LSP Server Implementation

### 3.1 Server Initialization
- [x] Create LSP server entry point using `vscode-languageserver/node`
- [x] Implement `initialize` handler with capability negotiation
- [x] Implement `initialized` handler for post-initialization setup
- [x] Implement `shutdown` and `exit` handlers
- [x] Set up connection and document manager

### 3.2 Document Management
- [x] Implement `TextDocuments` manager for open `.bp` files
- [x] Handle `textDocument/didOpen` - parse and index document
- [x] Handle `textDocument/didChange` - re-parsing (full sync mode)
- [x] Handle `textDocument/didClose` - cleanup document state
- [x] Handle `textDocument/didSave` - trigger full validation

### 3.3 Document Parsing & AST
- [x] Integrate tree-sitter parser into server (via web-tree-sitter WASM)
- [x] Create AST node types mirroring Blueprint hierarchy:
  - [x] `DescriptionNode`
  - [x] `ModuleNode`
  - [x] `FeatureNode`
  - [x] `RequirementNode`
  - [x] `DependsOnNode`
  - [x] `ConstraintNode`
- [x] Implement tree-sitter to AST transformation
- [x] Build source location tracking for all nodes
- [x] Create document symbol table (identifier → node mapping)

### 3.4 Workspace Indexing
- [x] Implement workspace folder scanning for `.bp` files (Added `WorkspaceManager` class in `workspace.ts` with recursive directory scanning, hidden directory filtering, and workspace folder change handling. 26 tests added in `workspace.test.ts`.)
- [x] Build cross-file symbol index (Added `CrossFileSymbolIndex` class in `symbol-index.ts` with global symbol registry, cross-file reference resolution, dependency tracking, and conflict detection. Integrated with `WorkspaceManager` file discovery and document lifecycle events in `index.ts`. 37 tests added in `symbol-index.test.ts`.)
- [ ] Implement file watcher for `.bp` file changes
- [x] Handle workspace folder additions/removals (Implemented in `WorkspaceManager.handleWorkspaceFoldersChange()`)

---

## Phase 4: Ticket Artifact Integration

### 4.1 Ticket File Discovery
- [x] Implement ticket file path resolution (`requirements/foo.bp` → `.blueprint/tickets/foo.tickets.json`) (Completed: Added `tickets.ts` module with `resolveTicketFilePath()`, `resolveTicketFileUri()`, `ticketFileExists()`, `resolveBpFileBaseName()`, `getTicketFileName()`, `isTicketFilePath()`, and `isBlueprintFilePath()` functions. Supports configurable tickets path via parameter. 27 tests added in `tickets.test.ts`.)
- [x] Handle configurable tickets path from settings (Completed: All ticket path functions accept an optional `ticketsPath` parameter that defaults to `.blueprint/tickets` per SPEC.md Section 5.9.)
- [ ] Set up file watcher for `.tickets.json` changes

### 4.2 Ticket Schema Validation
- [ ] Define TypeScript interfaces for ticket schema:
  - [ ] `TicketFile` (version, source, tickets array)
  - [ ] `Ticket` (id, ref, description, status, constraints_satisfied, implementation)
  - [ ] `Implementation` (files, tests)
  - [ ] `TicketStatus` enum (pending, in-progress, complete, obsolete)
- [ ] Implement JSON schema validation for ticket files
- [ ] Report schema validation errors as diagnostics

### 4.3 Requirement-Ticket Correlation
- [ ] Build mapping from requirement refs to tickets
- [ ] Handle one-to-many requirement-to-ticket relationships
- [ ] Aggregate constraint satisfaction across tickets sharing same ref
- [ ] Compute requirement completion status

---

## Phase 5: Dependency Resolution

### 5.1 Reference Resolution
- [ ] Parse dot-notation references (`module.feature.requirement`)
- [ ] Resolve references to target nodes (same file)
- [ ] Resolve cross-file references
- [ ] Handle partial references (module-only, module.feature)

### 5.2 Dependency Graph
- [ ] Build directed dependency graph from `@depends-on` declarations
- [ ] Implement topological sort for dependency ordering
- [ ] Detect circular dependencies using cycle detection algorithm
- [ ] Compute transitive dependencies

### 5.3 Blocking Status Computation
- [ ] Determine if a requirement is blocked by incomplete dependencies
- [ ] Propagate blocking status through hierarchy
- [ ] Cache and invalidate blocking status on changes

---

## Phase 6: Diagnostics

### 6.1 Syntax Errors
- [ ] Report tree-sitter parse errors as diagnostics
- [ ] Provide meaningful error messages for common syntax mistakes
- [ ] Include source location (line, column, range)

### 6.2 Semantic Errors
- [ ] Detect circular dependencies (Error)
- [ ] Detect references to non-existent requirements (Error)
- [ ] Detect duplicate identifiers in scope (Error)
- [x] Detect multiple `@description` blocks in one file (Error)
- [x] Detect `@description` after `@module` (Error)

### 6.3 Warnings
- [ ] Warn when requirement has no ticket
- [ ] Warn when ticket references removed requirement
- [ ] Warn on constraint identifier mismatch between `.bp` and ticket

### 6.4 Informational
- [ ] Info diagnostic when requirement is blocked by pending dependencies

### 6.5 Diagnostic Publishing
- [ ] Implement debounced diagnostic publishing
- [ ] Clear diagnostics when document is closed
- [ ] Update diagnostics on ticket file changes

---

## Phase 7: Semantic Tokens (Syntax Highlighting)

### 7.1 Token Type Registration
- [ ] Register semantic token types:
  - [ ] `keyword` (for @description, @module, @feature, @requirement, @depends-on, @constraint)
  - [ ] `variable` (for identifiers)
  - [ ] `type` (for references)
  - [ ] `comment` (for comments)
- [ ] Register semantic token modifiers (declaration, definition, reference)

### 7.2 Token Generation
- [ ] Implement `textDocument/semanticTokens/full` handler
- [ ] Walk AST and emit tokens for each element
- [ ] Handle token encoding (delta line, delta column, length, type, modifiers)

### 7.3 Progress-Based Highlighting
- [ ] Emit tokens with status-based modifiers for requirements:
  - [ ] No ticket → dim styling
  - [ ] pending → default styling
  - [ ] blocked → error styling
  - [ ] in-progress → warning styling
  - [ ] complete → success styling
  - [ ] obsolete → strikethrough styling

---

## Phase 8: Hover Information

### 8.1 Hover Handler
- [ ] Implement `textDocument/hover` handler
- [ ] Determine hovered element from position

### 8.2 Requirement Hover
- [ ] Display ticket ID(s) associated with requirement
- [ ] Display aggregated status across all tickets
- [ ] Display constraint satisfaction (X/Y satisfied with checkmarks)
- [ ] Display computed dependency status (resolved by LSP)
- [ ] Display implementation files from tickets

### 8.3 Feature/Module Hover
- [ ] Compute aggregate progress (X/Y requirements complete)
- [ ] Display progress bar visualization
- [ ] List requirements with their individual statuses
- [ ] Show blocked requirements with blocking reason

### 8.4 Reference Hover
- [ ] Show preview of referenced element's description
- [ ] Display reference target's status

---

## Phase 9: Navigation Features

### 9.1 Go-to-Definition
- [ ] Implement `textDocument/definition` handler
- [ ] Requirement identifier → ticket in `.tickets.json`
- [ ] `@depends-on` reference → referenced requirement
- [ ] Constraint identifier → constraint definition
- [ ] File path in hover → source file

### 9.2 Find References
- [ ] Implement `textDocument/references` handler
- [ ] Find all `@depends-on` declarations referencing an element
- [ ] Find tickets tracking a requirement
- [ ] Find source files implementing a requirement (via ticket data)

### 9.3 Document Symbols
- [ ] Implement `textDocument/documentSymbol` handler
- [ ] Return hierarchical symbol tree (modules → features → requirements)
- [ ] Include constraints as children of requirements

### 9.4 Workspace Symbols
- [ ] Implement `workspace/symbol` handler
- [ ] Enable searching across all `.bp` files in workspace

---

## Phase 10: Code Actions & Quick Fixes

### 10.1 Quick Fix Suggestions
- [ ] Suggest creating ticket for requirement without ticket
- [ ] Suggest fixing typos in references (did-you-mean)
- [ ] Suggest removing obsolete ticket references

### 10.2 Code Actions
- [ ] "Go to ticket" action for requirements
- [ ] "Show all dependencies" action
- [ ] "Show all dependents" action

---

## Phase 11: VS Code Extension (Client)

### 11.1 Extension Setup
- [ ] Create VS Code extension package structure
- [ ] Define `package.json` with extension manifest
- [ ] Configure extension activation events (`.bp` files)
- [ ] Set up language configuration for Blueprint

### 11.2 Language Client
- [ ] Initialize `LanguageClient` with server options
- [ ] Configure server module path and debug options
- [ ] Set document selector for `.bp` files
- [ ] Handle client lifecycle (start, stop, restart)

### 11.3 Language Configuration
- [ ] Define bracket pairs and auto-closing
- [ ] Configure comment toggling (`//` and `/* */`)
- [ ] Set up word pattern for identifiers
- [ ] Configure indentation rules

### 11.4 TextMate Grammar (Fallback)
- [ ] Create `.tmLanguage.json` for basic syntax highlighting
- [ ] Define scopes for keywords, identifiers, comments
- [ ] Register grammar with VS Code

### 11.5 Extension Settings
- [ ] Implement `blueprint.ticketsPath` setting
- [ ] Implement highlighting color customization settings
- [ ] Implement `blueprint.gotoModifier` setting
- [ ] Implement `blueprint.showProgressInGutter` setting
- [ ] Implement `blueprint.hoverDelay` setting

### 11.6 Progress Decorations
- [ ] Create decoration types for each status
- [ ] Apply decorations based on semantic tokens
- [ ] Update decorations on document/ticket changes

### 11.7 Gutter Icons
- [ ] Create icons for completion status (checkmark, progress, blocked)
- [ ] Apply gutter decorations based on requirement status
- [ ] Make gutter icons configurable

---

## Phase 12: Testing

### 12.1 Unit Tests
- [x] Test tree-sitter grammar with corpus files
- [x] Test AST transformation
- [ ] Test dependency graph construction
- [ ] Test cycle detection algorithm
- [ ] Test ticket file parsing and validation
- [ ] Test requirement-ticket correlation
- [ ] Test semantic token generation

### 12.2 Integration Tests
- [ ] Test LSP initialization handshake
- [ ] Test document synchronization
- [ ] Test diagnostic publishing
- [ ] Test hover information content
- [ ] Test go-to-definition navigation
- [ ] Test find-references results
- [ ] Test cross-file reference resolution

### 12.3 End-to-End Tests
- [ ] Test full VS Code extension activation
- [ ] Test syntax highlighting appearance
- [ ] Test hover popup rendering
- [ ] Test navigation commands
- [ ] Test settings application

### 12.4 Performance Tests
- [ ] Benchmark parsing large `.bp` files
- [ ] Benchmark workspace indexing time
- [ ] Benchmark hover response latency
- [ ] Profile memory usage with many open files

---

## Phase 13: Documentation & Polish

### 13.1 User Documentation
- [ ] Write README with installation instructions
- [ ] Document all configuration options
- [ ] Create usage guide with screenshots
- [ ] Document keyboard shortcuts

### 13.2 Developer Documentation
- [ ] Document architecture and code organization
- [ ] Document AST node types and properties
- [ ] Document contribution guidelines
- [ ] Document release process

### 13.3 Polish
- [ ] Add extension icon and branding
- [ ] Write extension marketplace description
- [ ] Create demo GIF/video
- [ ] Review and improve error messages

---

## Phase 14: Packaging & Distribution

### 14.1 Build Pipeline
- [ ] Configure zshy bundler for server
- [ ] Configure zshy bundler for client extension
- [ ] Set up tree-sitter WASM compilation for browser compatibility
- [ ] Create production build scripts

### 14.2 VS Code Extension Packaging
- [ ] Create `.vscodeignore` for extension
- [ ] Package extension with `vsce package`
- [ ] Test extension installation from `.vsix`

### 14.3 Distribution
- [ ] Set up CI/CD pipeline for automated builds
- [ ] Configure automated testing in CI
- [ ] Publish to VS Code Marketplace
- [ ] Create GitHub releases with changelog

---

## Implementation Order Recommendation

1. **Start with Phase 1-2**: Get project structure and parser working
2. **Phase 3.1-3.3**: Basic LSP server with document management
3. **Phase 6.1**: Syntax error diagnostics (validates parser integration)
4. **Phase 7**: Semantic tokens for visible progress
5. **Phase 11.1-11.4**: Basic VS Code extension to test above features
6. **Phase 3.4 + 4**: Workspace indexing and ticket integration
7. **Phase 5**: Dependency resolution
8. **Phase 6.2-6.5**: Full diagnostics
9. **Phase 8-9**: Hover and navigation
10. **Phase 10-11.5-11.7**: Advanced features
11. **Phase 12-14**: Testing, documentation, packaging

---

## Notes

- The LSP is the source of truth for computed data (dependencies, blocking status, aggregate progress)
- Tickets are intentionally minimal; avoid storing derived data
- Cross-file operations require workspace-wide indexing
- Debounce expensive operations (parsing, diagnostics) for performance
- Consider WASM tree-sitter for browser-based editors in future

---

## Known Issues (Phase 3.2/3.3 Implementation)

### Blockers

- [x] **Fix `Node` type import in parser.ts** - ~~`Node` is not a named export from `web-tree-sitter`.~~ Verified: `Node` is correctly exported as a class from `web-tree-sitter`. No fix needed.
- [x] **Fix `Node` type import in documents.ts** - ~~Same issue.~~ Verified: Import works correctly. No fix needed.

### Code Quality

- [x] **Add parser cleanup in shutdown handler** - The parser and document manager resources are not cleaned up when the server shuts down. Add cleanup logic in `connection.onShutdown()`. (Completed: Added `cleanupParser()` in parser.ts and `cleanup()` in DocumentManager, called from `connection.onShutdown()`)
- [x] **Use `DiagnosticSeverity` constant** - In `documents.ts`, use `DiagnosticSeverity.Error` from `vscode-languageserver` instead of hardcoded `severity: 1`. (Fixed)
- [x] **Remove unused `document` parameter** - In `documents.ts:120`, the `document` parameter in `collectDiagnostics()` is not used. (Fixed)

### Error Handling

- [x] **Send client notification on parser failure** - If parser initialization fails, the server continues but all document operations are no-ops. Should notify the client about degraded functionality. (Fixed: Added `connection.window.showErrorMessage()` in `onInitialized` handler to notify client when parser fails.)
- [x] **Add warning in `parseDocument` when parser not initialized** - Currently returns `null` silently; consider logging a warning for debugging. (Fixed: Added `console.warn()` in `parseDocument()` when parser is not initialized.)

### Test Coverage

- [x] **Complete "detects parse errors" test** - Test at `documents.test.ts:83-91` has no assertions. Should verify `tree.rootNode.hasError` is `true` or that error nodes exist. (Completed: Added assertions verifying `tree.rootNode.hasError` is `true` and that an `ERROR` node exists in the parse tree children.)
- [ ] **Add edge case tests**:
  - [x] Empty document parsing (Added tests for empty string, whitespace-only, and newlines-only documents in `documents.test.ts`)
  - [x] Document with only comments (Added tests for single-line only, multi-line only, and mixed comments in `documents.test.ts`. Note: Tests revealed a grammar bug where multi-line comments are sometimes parsed as `description_block` - see Grammar Bugs section.)
  - [ ] Very large documents
  - [ ] Invalid UTF-8 sequences

### Performance (Future)

- [ ] **Consider incremental parsing** - Current implementation uses `TextDocumentSyncKind.Full` which re-parses the entire document on every change. Tree-sitter supports incremental parsing via `tree.edit()` which would improve performance for large files.

---

## Code Review: Phase 3.3 AST Implementation (Commit 8899d29)

### SPEC Compliance Issues

- [ ] **Clarify requirement placement in SPEC or code** - SPEC.md Section 3.3.3 states "A requirement must be declared within a feature", but the AST implementation (`ModuleNode.requirements`) and grammar allow requirements directly under modules without a feature. Either update SPEC.md to allow module-level requirements, or remove this capability from the grammar/AST and add a diagnostic error.

- [ ] **Missing `CommentNode` AST type** - Per SPEC.md Section 3.1.2, comments are "preserved for documentation purposes", but the AST has no `CommentNode` type. Add a `CommentNode` interface and collect comments during AST transformation for potential documentation extraction.

- [x] **No validation for @description placement** - SPEC.md Section 3.2.1 requires `@description` to appear before any `@module` declaration. The `transformToAST()` function does not validate this ordering. This validation should be added (likely in diagnostics phase, but the AST should expose enough information to detect this). (Fixed: Added `validateDescriptionPlacement()` in `documents.ts` that detects `@description` after `@module` and reports a specific diagnostic error. Tests added in `documents.test.ts`.)

- [x] **No detection of multiple @description blocks** - SPEC.md Section 5.8 specifies "Error | Multiple @description blocks in one file". The current `transformToAST()` simply overwrites `description` if multiple blocks exist. Should either collect all and report in diagnostics, or at minimum flag that multiple were found. (Fixed: Added detection in `validateDescriptionPlacement()` in `documents.ts`. Reports error on all `@description` blocks after the first one. Tests added in `documents.test.ts`.)

### Symbol Table Issues

- [x] **No duplicate identifier detection in buildSymbolTable()** - SPEC.md Section 5.8 requires "Error | Duplicate identifier in scope". The `buildSymbolTable()` function uses `Map.set()` which silently overwrites duplicates. Should detect and report duplicate keys for diagnostic purposes. Consider returning a list of duplicates alongside the symbol table. (Completed: Modified `buildSymbolTable()` to return a `SymbolTableResult` containing both the symbol table and a `duplicates` array of `DuplicateIdentifier` objects. Added `validateDuplicateIdentifiers()` in `documents.ts` to report duplicates as diagnostics. Added comprehensive tests in both `ast.test.ts` and `documents.test.ts`.)

### AST Design Issues

- [ ] **Missing parent references in AST nodes** - For navigation features (Phase 9) and path resolution, it would be useful for child nodes to have a reference to their parent. Currently `getRequirementPath()` must search the entire document. Consider adding optional `parent` field to nodes.

### Test Coverage Gaps

- [x] **Add test for multiple @description blocks** - Should verify behavior when a document contains multiple `@description` blocks. (Completed: Added test in `ast.test.ts` that verifies the grammar produces an ERROR node for multiple descriptions, and that `transformToAST` uses the last description block.)

- [x] **Add test for @description after @module** - Should verify the AST still parses (for error recovery) but diagnostics can detect the invalid ordering. (Completed: Added two tests in `ast.test.ts` - one verifying error recovery extracts the description block, another verifying the ERROR node pattern that diagnostics can use to detect misplaced @description.)

- [x] **Add test for duplicate identifiers** - Test that `buildSymbolTable()` handles duplicate module names, feature names, requirement names, and constraint names appropriately. (Completed: Added 9 tests in `ast.test.ts` covering duplicate modules, features, requirements, and constraints. Tests verify "last one wins" behavior when duplicates share the same fully-qualified path, and that items with different paths are preserved.)

- [x] **Add test for empty identifier** - Test behavior when identifier is missing (e.g., `@module` without a name). (Completed: Added 6 tests in `ast.test.ts` under "empty/missing identifier handling" describe block. Tests document the parser's aggressive recovery behavior: when an identifier is missing, the parser uses subsequent tokens as the name or demotes elements to parent scope. For `@constraint`, no error occurs as the next line's first word becomes the name.)

- [x] **Add test for deeply nested references** - Test references with more than 3 parts (even if invalid per spec, should handle gracefully). (Completed: Added two tests in `ast.test.ts` - one testing 4-part and 6-part references, another testing mixed-depth references in a single @depends-on. Verified grammar parses arbitrarily deep references without error and AST correctly captures all parts.)

### Minor Code Quality

- [ ] **Import `ReferenceNode` type in ast.test.ts** - The test file tests `ReferenceNode` properties but doesn't import the type. Add to imports for type safety.

- [ ] **Add JSDoc for `SymbolTable` interface fields** - The `SymbolTable` interface lacks documentation for what each map contains. Add JSDoc comments explaining the key format and value type for each map.

---

## Grammar Bugs

### Multi-line Comment Parsing

- [x] **Multi-line comments parsed as `description_block`** - Fixed. The issue was that the `comment` rule used separate `token()` wrappers for single-line and multi-line comments inside a `choice()`. The fix wrapped the entire `choice()` in a single `token()`, which gives proper precedence to the comment rule. The regex `[^*]*\*+([^/*][^*]*\*+)*/` was correct all along. Added additional corpus tests for block comment edge cases (single-line block, JSDoc style, asterisks inside).
