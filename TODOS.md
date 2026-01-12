# Blueprint LSP Implementation Plan

## Overview

This document outlines the implementation plan for the Blueprint DSL Language Server Protocol (LSP) implementation. The LSP will provide IDE integration for `.bp` requirement files including syntax highlighting, diagnostics, hover information, navigation, and integration with ticket artifacts.

**Tech Stack:**

- Language/Runtime: TypeScript/Node
- Package Manager: Bun
- Parser: tree-sitter
- LSP Framework: vscode-languageserver + vscode-languageclient
- Schema Validation: valibot (for JSON files like .tickets.json)
- Testing: Bun
- Bundling: zshy

---

## Phase 1: Project Setup & Infrastructure

### 1.1 Project Initialization

- [x] Initialize monorepo structure with packages for `server`, `client`, and `tree-sitter-blueprint`
- [x] Configure `package.json` with workspaces for monorepo management
- [x] Set up TypeScript configuration (`tsconfig.json`) for each package
- [x] Configure Bun as the package manager and test runner
- [x] Set up zshy bundler configuration for production builds (Configured `packages/blueprint-lsp-server/package.json` with zshy entrypoint map and bin field for CLI executable, added `build`, `build:dry-run`, and `clean` scripts. Updated `tsconfig.json` to support emit for zshy builds. Added shebang to `src/index.ts`. zshy auto-generates `main`, `module`, `types`, `exports`, `bin`, and `files` fields. Produces dual ESM/CJS output in `dist/` directory with `blueprint-lsp-server` CLI command.)
- [x] Create `.gitignore` with appropriate exclusions

### 1.2 Development Environment

- [x] Configure ESLint and Prettier for code quality (Added ESLint 9 with flat config (`eslint.config.js`) using typescript-eslint, eslint-plugin-prettier, and eslint-config-prettier. Created `.prettierrc` with standard formatting rules and `.prettierignore`. Added `lint`, `lint:fix`, `format`, and `format:check` scripts to root `package.json`. Tree-sitter grammar folder is excluded from linting since it uses special DSL functions.)
- [x] Set up VS Code workspace settings for development (Added `.vscode/settings.json` with editor settings aligned to .prettierrc, format-on-save with Prettier, ESLint auto-fix on save, TypeScript workspace SDK configuration, file associations for `.bp` files, search exclusions for generated files, and Bun as package manager. Added `.vscode/extensions.json` with recommended extensions: Prettier, ESLint, TypeScript, Bun, tree-sitter, and JS debugger.)
- [x] Create launch configurations for debugging the LSP server and client (Added `.vscode/launch.json` with configurations for: "Launch Extension" using extensionHost, "Attach to LSP Server" on port 6009, "Debug LSP Server (Standalone)" with Bun, "Debug Current Test File", "Debug All LSP Server Tests", and compound "Extension + Server" configuration. Also added `.vscode/tasks.json` with build, watch, and test tasks.)
- [x] Set up hot-reload for development iteration (Added npm scripts to `packages/blueprint-lsp-server/package.json`: `dev` uses `bun --watch`, `dev:debug` adds inspector, `test:watch` for continuous testing, `typecheck:watch` for continuous type checking. Updated `.vscode/tasks.json` with `watch-server`, `watch-server-debug`, `watch-tests`, and compound `dev` task that runs both server and typecheck watchers in parallel.)

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
- [x] Handle fenced code blocks (`...`)
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
- [x] Implement file watcher for `.bp` file changes (Added `**/*.bp` glob pattern to `DidChangeWatchedFilesNotification` registration in `onInitialized`. Handler in `onDidChangeWatchedFiles` processes Created/Changed/Deleted events: Created adds to `WorkspaceManager` and indexes file, Changed re-indexes if file not open in editor, Deleted removes from `WorkspaceManager` and `CrossFileSymbolIndex`.)
- [x] Handle workspace folder additions/removals (Implemented in `WorkspaceManager.handleWorkspaceFoldersChange()`)

---

## Phase 4: Ticket Artifact Integration

### 4.1 Ticket File Discovery

- [x] Implement ticket file path resolution (`requirements/foo.bp` → `.blueprint/tickets/foo.tickets.json`) (Completed: Added `tickets.ts` module with `resolveTicketFilePath()`, `resolveTicketFileUri()`, `ticketFileExists()`, `resolveBpFileBaseName()`, `getTicketFileName()`, `isTicketFilePath()`, and `isBlueprintFilePath()` functions. Supports configurable tickets path via parameter. 27 tests added in `tickets.test.ts`.)
- [x] Handle configurable tickets path from settings (Completed: All ticket path functions accept an optional `ticketsPath` parameter that defaults to `.blueprint/tickets` per SPEC.md Section 5.9.)
- [x] Set up file watcher for `.tickets.json` changes (Completed: Added `DidChangeWatchedFilesNotification` registration in `onInitialized` for `**/.blueprint/tickets/*.tickets.json` glob pattern. Added `connection.onDidChangeWatchedFiles` handler that processes `Created`, `Changed`, and `Deleted` events, reading file content and updating `TicketDocumentManager` state accordingly.)

### 4.2 Ticket Schema Validation

- [x] Define TypeScript interfaces for ticket schema (Completed: Using valibot schemas in `tickets.ts` with types inferred via `v.InferOutput<>`. Full SPEC.md Section 4 compliance):
  - [x] `TicketFileSchema` / `TicketFile` (version, source, tickets array)
  - [x] `TicketSchema` / `Ticket` (id, ref, description, status, constraints_satisfied, implementation)
  - [x] `TicketImplementationSchema` / `TicketImplementation` (files, tests)
  - [x] `TicketStatusSchema` / `TicketStatus` (pending, in-progress, complete, obsolete)
- [x] Implement JSON schema validation for ticket files (Completed: Using valibot's `v.safeParse()` with custom error formatting. Added `validateTicketFile()`, `parseTicketFileContent()`, and `parseTicketFile()` functions. Includes duplicate ticket ID detection. 40 new tests in `tickets.test.ts`.)
- [x] Report schema validation errors as diagnostics (Completed: Added `TicketDocumentManager` class in `ticket-documents.ts` that validates `.tickets.json` files and publishes diagnostics. Integrated with LSP server document lifecycle events in `index.ts`. Reports errors for invalid JSON, schema violations, and duplicate ticket IDs. Version mismatches are reported as warnings. 24 tests added in `ticket-documents.test.ts`.)

### 4.3 Requirement-Ticket Correlation

- [x] Build mapping from requirement refs to tickets (Completed: Added `requirement-ticket-map.ts` module with `buildRequirementTicketMap()` and `buildRequirementTicketMapFromSymbols()` functions. 40 tests added in `requirement-ticket-map.test.ts`.)
- [x] Handle one-to-many requirement-to-ticket relationships (Completed: `groupTicketsByRef()` groups tickets by their ref, `RequirementTicketInfo` stores array of tickets per requirement.)
- [x] Aggregate constraint satisfaction across tickets sharing same ref (Completed: `computeConstraintStatuses()` aggregates `constraints_satisfied` from all tickets, tracks which ticket IDs satisfy each constraint.)
- [x] Compute requirement completion status (Completed: `computeRequirementStatus()` computes aggregated status, `getCompletionSummary()` provides module/feature-level progress stats, `filterByPathPrefix()` enables scoped queries.)

---

## Phase 5: Dependency Resolution

### 5.1 Reference Resolution

- [x] Parse dot-notation references (`module.feature.requirement`) (Completed: `ReferenceNode` in `ast.ts` stores `parts` array and `path` string. `transformReference()` extracts parts from tree-sitter nodes.)
- [x] Resolve references to target nodes (same file) (Completed: `CrossFileSymbolIndex.resolveReference()` in `symbol-index.ts` resolves references to `IndexedSymbol` objects.)
- [x] Resolve cross-file references (Completed: `CrossFileSymbolIndex` maintains global symbol registry across all indexed files, enabling cross-file resolution.)
- [x] Handle partial references (module-only, module.feature) (Completed: `resolveReference()` supports both exact and partial matching via prefix search in `globalSymbols`.)

### 5.2 Dependency Graph

- [x] Build directed dependency graph from `@depends-on` declarations (Completed: Added `DependencyGraph` class in `dependency-graph.ts` with `build()` static method that constructs graph from `CrossFileSymbolIndex`. 27 tests in `dependency-graph.test.ts`.)
- [x] Implement topological sort for dependency ordering (Completed: `topologicalSort()` uses Kahn's algorithm to produce ordering where dependencies come before dependents.)
- [x] Detect circular dependencies using cycle detection algorithm (Completed: `detectCycles()` uses DFS-based cycle detection, returns `CircularDependency[]` with cycle paths and edges.)
- [x] Compute transitive dependencies (Completed: `getTransitiveDependencies()` and `getTransitiveDependents()` methods compute transitive closures.)

### 5.3 Blocking Status Computation

- [x] Determine if a requirement is blocked by incomplete dependencies (Completed: Added `blocking-status.ts` module with `computeBlockingInfo()` that checks direct and transitive dependencies against ticket status. Returns `BlockingInfo` with status (`not-blocked`, `blocked`, `in-cycle`) and lists of `BlockerInfo` objects. 27 tests added in `blocking-status.test.ts`.)
- [x] Propagate blocking status through hierarchy (Completed: `propagateBlockingToHierarchy()` aggregates blocking status from requirements up to features and modules. In-cycle status takes precedence over blocked.)
- [x] Cache and invalidate blocking status on changes (Completed: Added `BlockingStatusCache` type with `createBlockingStatusCache()`, `invalidateBlockingStatusCache()`, `updateBlockingStatusCache()`, and `shouldInvalidateCache()` functions for cache management.)

---

## Phase 6: Diagnostics

### 6.1 Syntax Errors

- [x] Report tree-sitter parse errors as diagnostics (Completed: `DocumentManager.collectErrorNodes()` in `documents.ts` recursively scans tree-sitter parse trees for ERROR and MISSING nodes.)
- [x] Provide meaningful error messages for common syntax mistakes (Completed: Added context-aware error messages in `documents.ts` via `getMissingNodeMessage()`, `getErrorNodeMessage()`, and `getContextualErrorMessage()` methods. Handles orphaned elements at wrong scope, invalid identifiers starting with digits, missing identifiers after keywords, and reference-related errors. 8 new tests added in `documents.test.ts`.)
- [x] Include source location (line, column, range) (Completed: Error diagnostics include full range from `node.startPosition` to `node.endPosition`.)

### 6.2 Semantic Errors

- [x] Detect circular dependencies (Error) (Completed: Added `workspace-diagnostics.ts` module with `computeCircularDependencyDiagnostics()` function that uses `DependencyGraph.build()` to detect cycles and generates diagnostics at each `@depends-on` location in the cycle. Diagnostics include the full cycle path in the error message. Integrated with LSP server in `index.ts` via `publishWorkspaceDiagnostics()` which is called after symbol index updates. 20 tests added in `workspace-diagnostics.test.ts`.)
- [x] Detect references to non-existent requirements (Error) (Completed: Added `computeUnresolvedReferenceDiagnostics()` in `workspace-diagnostics.ts` that uses `CrossFileSymbolIndex.getUnresolvedReferences()` to find all unresolved `@depends-on` references and generates diagnostics with the unresolved path in the error message. Tests added in `workspace-diagnostics.test.ts`.)
- [x] Detect duplicate identifiers in scope (Error) (Completed: `buildSymbolTable()` in `ast.ts` returns duplicates, `validateDuplicateIdentifiers()` in `documents.ts` creates diagnostics. Tests in `ast.test.ts` and `documents.test.ts`.)
- [x] Detect multiple `@description` blocks in one file (Error)
- [x] Detect `@description` after `@module` (Error)

### 6.3 Warnings

- [x] Warn when requirement has no ticket (Completed: Added `computeNoTicketDiagnostics()` in `workspace-diagnostics.ts` that compares requirements from `CrossFileSymbolIndex` against tickets. Integrated with `computeWorkspaceDiagnostics()` which now accepts optional tickets array. Updated `publishWorkspaceDiagnostics()` in `index.ts` to pass tickets from `TicketDocumentManager.getAllTickets()`. Added `getAllTicketFiles()` and `getAllTickets()` methods to `TicketDocumentManager`. 11 new tests in `workspace-diagnostics.test.ts`.)
- [x] Warn when ticket references removed requirement (Completed: Added `computeOrphanedTicketDiagnostics()` in `workspace-diagnostics.ts` that checks ticket refs against valid requirement paths from `CrossFileSymbolIndex`. Diagnostics are reported on `.tickets.json` files with code `orphaned-ticket`. Integrated with `publishWorkspaceDiagnostics()` in `index.ts` to merge with ticket document diagnostics. 10 new tests in `workspace-diagnostics.test.ts`.)
- [x] Warn on constraint identifier mismatch between `.bp` and ticket (Completed: Added `computeConstraintMismatchDiagnostics()` in `workspace-diagnostics.ts` that checks if ticket `constraints_satisfied` arrays contain constraint identifiers not defined in the corresponding requirement's `@constraint` list. Diagnostics are reported on `.tickets.json` files with code `constraint-mismatch`. Integrated with `publishWorkspaceDiagnostics()` in `index.ts` using `mergeDiagnosticResults()` to combine with orphaned ticket diagnostics. 12 new tests in `workspace-diagnostics.test.ts`.)

### 6.4 Informational

- [x] Info diagnostic when requirement is blocked by pending dependencies

### 6.5 Diagnostic Publishing

- [x] Implement debounced diagnostic publishing (Completed: Added `scheduleWorkspaceDiagnostics()` function with 150ms debounce delay in `index.ts`. Uses `setTimeout`/`clearTimeout` pattern to batch rapid changes. Timer is cancelled on shutdown to prevent callbacks after cleanup.)
- [x] Clear diagnostics when document is closed (Already implemented: `DocumentManager.onDocumentClose()` in `documents.ts:65` and `TicketDocumentManager.onDocumentClose()` in `ticket-documents.ts:65` both call `connection.sendDiagnostics({ uri, diagnostics: [] })` to clear diagnostics when documents are closed.)
- [x] Update diagnostics on ticket file changes (Completed: Added `scheduleWorkspaceDiagnostics()` calls to all ticket file lifecycle handlers in `index.ts`: `onDidOpen`, `onDidChangeContent`, `onDidSave` for open documents, and `onDidChangeWatchedFiles` for file system changes. This ensures workspace diagnostics like no-ticket warnings and blocked requirement info are updated when ticket status changes.)

---

## Phase 7: Semantic Tokens (Syntax Highlighting)

### 7.1 Token Type Registration

- [x] Register semantic token types (Completed: Added `semantic-tokens.ts` module with `semanticTokensLegend` defining token types and modifiers. Integrated with LSP server in `index.ts` via `semanticTokensProvider` capability. 18 tests added in `semantic-tokens.test.ts`.):
  - [x] `keyword` (for @description, @module, @feature, @requirement, @depends-on, @constraint)
  - [x] `variable` (for identifiers)
  - [x] `type` (for references)
  - [x] `comment` (for comments)
- [x] Register semantic token modifiers (declaration, definition)

### 7.2 Token Generation

- [x] Implement `textDocument/semanticTokens/full` handler (Completed: Added `connection.languages.semanticTokens.on()` handler in `index.ts` that calls `buildSemanticTokens()` from `semantic-tokens.ts`.)
- [x] Walk AST and emit tokens for each element (Completed: `walkTree()` and `processNode()` functions recursively traverse the tree-sitter parse tree.)
- [x] Handle token encoding (delta line, delta column, length, type, modifiers) (Completed: Uses `SemanticTokensBuilder` from vscode-languageserver with proper sorting of tokens before building.)

### 7.3 Progress-Based Highlighting

- [x] Emit tokens with status-based modifiers for requirements (Completed: Added status-based token modifiers `noTicket`, `blocked`, `inProgress`, `complete`, `obsolete` to `semanticTokensLegend`. Updated `buildSemanticTokens()` to accept optional `statusMap` parameter. Added `buildRequirementStatusMap()` to combine ticket status and blocking status. Status modifiers are applied to both `@requirement` keywords and requirement identifier tokens. 13 new tests added in `semantic-tokens.test.ts`.):
  - [x] No ticket → noTicket modifier (dim styling)
  - [x] pending → no modifier (default styling)
  - [x] blocked → blocked modifier (error styling)
  - [x] in-progress → inProgress modifier (warning styling)
  - [x] complete → complete modifier (success styling)
  - [x] obsolete → obsolete modifier (strikethrough styling)

---

## Phase 8: Hover Information

### 8.1 Hover Handler

- [x] Implement `textDocument/hover` handler (Completed: Added `hover.ts` module with `findHoverTarget()` and `buildHover()` functions. Integrated with LSP server in `index.ts` via `connection.onHover()` handler. Added `hoverProvider: true` to server capabilities.)
- [x] Determine hovered element from position (Completed: `findNodeAtPosition()` uses tree-sitter to find the deepest node at cursor position. `findHoverTarget()` walks up the tree to identify module, feature, requirement, constraint, reference, or keyword targets.)

### 8.2 Requirement Hover

- [x] Display ticket ID(s) associated with requirement (Completed: `buildRequirementHover()` shows all tickets associated with a requirement, including ticket ID and description.)
- [x] Display aggregated status across all tickets (Completed: Shows aggregated status computed by `RequirementTicketMap` - complete, in-progress, pending, no-ticket, or obsolete.)
- [x] Display constraint satisfaction (X/Y satisfied with checkmarks) (Completed: Shows "X/Y satisfied" with checkmark or empty circle icons for each constraint. Uses `computeConstraintStatuses()` from requirement-ticket-map.)
- [x] Display computed dependency status (resolved by LSP) (Completed: Shows blocking info computed by `computeBlockingInfo()` - displays direct and transitive blockers with their statuses, or cycle information if in a circular dependency.)
- [x] Display implementation files from tickets (Completed: Shows implementation files and test files from ticket data.)

### 8.3 Feature/Module Hover

- [x] Compute aggregate progress (X/Y requirements complete) (Completed: `buildFeatureHover()` and `buildModuleHover()` use `getCompletionSummary()` and `filterByPathPrefix()` to compute progress.)
- [x] Display progress bar visualization (Completed: `buildProgressBar()` creates a text-based progress bar with filled/empty blocks.)
- [x] List requirements with their individual statuses (Completed: Feature hover lists direct child requirements with status icons. Module hover shows status breakdown and features list.)
- [x] Show blocked requirements with blocking reason (Completed: Requirements in feature list show "blocked" or "in cycle" suffix when applicable.)

### 8.4 Reference Hover

- [x] Show preview of referenced element's description (Completed: `buildReferenceHover()` shows the resolved symbol's kind and path, with status/progress info for requirements and features/modules.)
- [x] Display reference target's status (Completed: Shows ticket status for requirements, progress for features/modules, or "Unresolved reference" warning if not found.)

Note: 29 tests added in `hover.test.ts` covering all hover functionality including requirement, feature, module, constraint, reference, and keyword hovers, as well as blocking status and multiple tickets per requirement.

---

## Phase 9: Navigation Features

### 9.1 Go-to-Definition

- [x] Implement `textDocument/definition` handler (Completed: Added `definition.ts` module with `findDefinitionTarget()` and `buildDefinition()` functions. Integrated with LSP server in `index.ts` via `connection.onDefinition()` handler. Added `definitionProvider: true` to server capabilities. 17 tests added in `definition.test.ts`.)
- [x] Requirement identifier → ticket in `.tickets.json` (Completed: `buildRequirementDefinition()` navigates to ticket position in JSON file when tickets exist, falls back to symbol definition otherwise. Supports multiple tickets returning `Location[]`.)
- [x] `@depends-on` reference → referenced requirement (Completed: `buildReferenceDefinition()` resolves cross-file references via `CrossFileSymbolIndex` and returns location of the referenced symbol.)
- [x] Constraint identifier → constraint definition (Completed: `buildSymbolDefinition()` returns the constraint's source location.)
- [x] File path in hover → source file (Completed: Added `formatFileLink()` helper in `hover.ts` that converts relative file paths to clickable Markdown links with `file://` URIs. Updated `buildRequirementHover()` to render implementation files and test files as clickable links when workspace folders are available. Added `getWorkspaceFolderUris()` method to `WorkspaceManager`. Hover context now includes `workspaceFolderUris` for path resolution. 11 new tests in `hover.test.ts`, 4 new tests in `workspace.test.ts`.)

### 9.2 Find References

- [x] Implement `textDocument/references` handler (Completed: Added `references.ts` module with `findReferencesTarget()` and `buildReferences()` functions. Uses `DependencyGraph.edges` to find all `@depends-on` declarations that reference a symbol. Integrated with LSP server in `index.ts` via `connection.onReferences()` handler. Added `referencesProvider: true` to server capabilities. 21 tests added in `references.test.ts`.)
- [x] Find all `@depends-on` declarations referencing an element (Completed: `findReferencingEdges()` searches dependency graph edges for exact matches and parent references that implicitly include children.)
- [x] Find tickets tracking a requirement (Completed: Extended `ReferencesContext` to include optional `ticketMap` and `ticketFiles` fields. Added `findTicketReferences()` function in `references.ts` that finds all tickets tracking a requirement and returns their locations in `.tickets.json` files. Updated `buildReferences()` to include ticket locations for requirement targets. Updated `index.ts` to pass ticket context to references handler. 7 new tests added in `references.test.ts` covering single ticket, multiple tickets, combined @depends-on and ticket references, includeDeclaration behavior, and backward compatibility.)
- [x] Find source files implementing a requirement (via ticket data) (Completed: Added `findImplementationFileReferences()` function in `references.ts` that reads `implementation.files` and `implementation.tests` arrays from tickets and converts relative paths to absolute file URIs using workspace folder. Added `workspaceFolderUris` to `ReferencesContext`. Updated `buildReferences()` to include implementation file locations for requirement targets. Updated `index.ts` to pass workspace folder URIs to references handler. 7 new tests added in `references.test.ts` covering single/multiple tickets, deduplication, missing workspace folders, missing implementation field, and combined reference types.)

### 9.3 Document Symbols

- [x] Implement `textDocument/documentSymbol` handler (Completed: Added `document-symbol.ts` module with `buildDocumentSymbols()` function. Integrated with LSP server in `index.ts` via `connection.onDocumentSymbol()` handler. Added `documentSymbolProvider: true` to server capabilities. 26 tests added in `document-symbol.test.ts`.)
- [x] Return hierarchical symbol tree (modules → features → requirements) (Completed: `buildModuleSymbol()`, `buildFeatureSymbol()`, `buildRequirementSymbol()` functions build nested `DocumentSymbol` hierarchy.)
- [x] Include constraints as children of requirements (Completed: `buildConstraintSymbol()` creates `DocumentSymbol` for constraints, included as children at module, feature, and requirement levels.)

### 9.4 Workspace Symbols

- [x] Implement `workspace/symbol` handler (Completed: Added `workspace-symbol.ts` module with `buildWorkspaceSymbols()` function. Integrated with LSP server in `index.ts` via `connection.onWorkspaceSymbol()` handler. Added `workspaceSymbolProvider: true` to server capabilities. 26 tests added in `workspace-symbol.test.ts`.)
- [x] Enable searching across all `.bp` files in workspace (Completed: Uses `CrossFileSymbolIndex` to search across all indexed files. Supports prefix matching, substring matching, and fuzzy matching. Results are sorted by relevance with configurable max results.)

---

## Phase 10: Code Actions & Quick Fixes

### 10.1 Quick Fix Suggestions

- [x] Suggest creating ticket for requirement without ticket (Completed: Added `code-actions.ts` module with `buildCodeActions()` function. Handles "no-ticket" diagnostics by generating code actions that create tickets in existing or new `.tickets.json` files. Includes ticket ID generation, workspace folder resolution, and both edit types (add to existing file, create new file). Registered `codeActionProvider` capability and `onCodeAction` handler in `index.ts`. 31 tests added in `code-actions.test.ts`.)
- [x] Suggest fixing typos in references (did-you-mean) (Completed: Added `levenshteinDistance()`, `stringSimilarity()`, `findSimilarSymbols()`, and `extractUnresolvedReferenceFromMessage()` functions in `code-actions.ts`. Handler for "unresolved-reference" diagnostics generates code actions with title "Did you mean 'X'?" that replace the typo with the correct reference. Uses Levenshtein distance with multiple similarity strategies (full path, per-part, suffix, and last-part matching). 34 new tests added in `code-actions.test.ts` covering Levenshtein distance, string similarity, message extraction, similar symbol finding, and code action generation.)
- [x] Suggest removing obsolete ticket references (Completed: Extended `code-actions.ts` with `extractOrphanedTicketInfo()` to parse "orphaned-ticket" diagnostic messages and `createRemoveTicketEdit()` to generate edits that remove tickets from `.tickets.json` files. Handles comma removal for proper JSON formatting. Added handling for "orphaned-ticket" diagnostics in `buildCodeActions()`. 18 new tests added in `code-actions.test.ts`.)

### 10.2 Code Actions

- [x] "Show all dependencies" action (Completed: Added `findSymbolAtPosition()`, `buildDependencyCodeActions()`, and `getDependencyLocations()` functions in `code-actions.ts`. When cursor is on a module, feature, or requirement that has dependencies, a source code action "Show N dependencies of 'path'" appears. The action includes a command with locations array for the client to display. Updated `CodeActionsContext` to include `dependencyGraph` and `tree`. Updated `index.ts` to build dependency graph and pass parse tree to code actions handler. 13 new tests added in `code-actions.test.ts`.)
- [x] "Show all dependents" action (Completed: Implemented alongside "Show all dependencies" in the same commit. When a symbol has dependents, a source code action "Show N dependents of 'path'" appears with locations of symbols that depend on the current one. Uses `blueprint.showLocations` command for client-side handling.)

---

## Phase 11: VS Code Extension (Client)

### 11.1 Extension Setup

- [x] Create VS Code extension package structure (Created `packages/blueprint-lsp-client/` with proper VS Code extension layout including `src/`, `syntaxes/`, and configuration files.)
- [x] Define `package.json` with extension manifest (Configured with `engines.vscode`, `activationEvents`, `main` entry point, `contributes.languages`, `contributes.grammars`, `contributes.configuration` for `blueprint.ticketsPath` and `blueprint.trace.server` settings, and dependencies on `vscode-languageclient`.)
- [x] Configure extension activation events (`.bp` files) (Set `activationEvents: ["onLanguage:blueprint"]` and registered `.bp` file extension with `blueprint` language ID.)
- [x] Set up language configuration for Blueprint (Created `language-configuration.json` with comment toggling, bracket pairs, auto-closing, surrounding pairs, folding markers, word pattern, and indentation rules.)

### 11.2 Language Client

- [x] Initialize `LanguageClient` with server options (Created `src/extension.ts` with `LanguageClient` initialization using `TransportKind.ipc`.)
- [x] Configure server module path and debug options (Configured server module path to `../blueprint-lsp-server/dist/index.cjs` with debug options for `--inspect=6009`.)
- [x] Set document selector for `.bp` files (Set document selector to `{ scheme: "file", language: "blueprint" }`.)
- [x] Handle client lifecycle (start, stop, restart) (Implemented `activate()` and `deactivate()` functions with proper client start/stop handling.)

### 11.3 Language Configuration

- [x] Define bracket pairs and auto-closing (Configured in `language-configuration.json` with `()`, `[]`, `{}` pairs and auto-closing for quotes and block comments.)
- [x] Configure comment toggling (`//` and `/* */`) (Set `lineComment: "//"` and `blockComment: ["/*", "*/"]` in `language-configuration.json`.)
- [x] Set up word pattern for identifiers (Set `wordPattern: "[a-zA-Z_][a-zA-Z0-9_-]*"` matching SPEC.md identifier rules.)
- [x] Configure indentation rules (Set `increaseIndentPattern` and `decreaseIndentPattern` for Blueprint keywords.)

### 11.4 TextMate Grammar (Fallback)

- [x] Create `.tmLanguage.json` for basic syntax highlighting (Created `syntaxes/blueprint.tmLanguage.json` with TextMate grammar.)
- [x] Define scopes for keywords, identifiers, comments (Defined scopes: `keyword.control.*` for hierarchy keywords, `keyword.other.*` for annotations, `entity.name.type.*` for identifiers, `comment.*` for comments, `string.*` for strings, and `markup.fenced_code.*` for code blocks.)
- [x] Register grammar with VS Code (Registered in `package.json` contributes.grammars with `scopeName: "source.blueprint"`)

### 11.5 Extension Settings

- [x] Implement `blueprint.ticketsPath` setting (Added configuration retrieval in LSP server via `connection.workspace.getConfiguration("blueprint")`. Stores `ticketsPath` in module-level `configuredTicketsPath` variable with default from `DEFAULT_TICKETS_PATH`. Added `onDidChangeConfiguration` handler to update setting dynamically. Pass `ticketsPath` through `CodeActionsContext` to `resolveTicketFileUri()` for ticket file creation. Configuration is fetched on `onInitialized` and whenever settings change. Note: File watcher glob patterns are registered once at initialization, so changing `ticketsPath` at runtime requires extension reload for full file watching support.)
- [x] Implement highlighting color customization settings (Added `blueprint.highlighting.complete`, `blueprint.highlighting.inProgress`, `blueprint.highlighting.blocked`, `blueprint.highlighting.noTicket`, and `blueprint.highlighting.obsolete` configuration settings in `packages/blueprint-lsp-client/package.json` with default colors per SPEC.md Section 5.9. Registered custom semantic token modifiers (`noTicket`, `blocked`, `inProgress`, `complete`, `obsolete`) via `semanticTokenModifiers` contribution. Added `semanticTokenScopes` to map modifiers to TextMate scopes for fallback highlighting. Set `configurationDefaults` for `editor.semanticTokenColorCustomizations` with default color rules for each status. Added `updateSemanticTokenColors()` function in `extension.ts` that reads user's color settings and applies them to semantic token customizations. Configuration changes are listened to via `onDidChangeConfiguration` for dynamic updates.)
- [x] Implement `blueprint.gotoModifier` setting (Added `blueprint.gotoModifier` configuration setting in `packages/blueprint-lsp-client/package.json` with enum values `"alt"` and `"ctrlCmd"` per SPEC.md Section 5.9. Default is `"alt"` meaning Alt+Click triggers go-to-definition. Added `configurationDefaults` for `[blueprint]` language to set `editor.multiCursorModifier` to `"ctrlCmd"` by default, which makes Ctrl/Cmd+Click add multiple cursors while Alt+Click does go-to-definition. Added `updateGotoModifier()` function in `extension.ts` that syncs the Blueprint-specific setting to VS Code's language-specific `editor.multiCursorModifier` setting. Configuration changes are listened to via `onDidChangeConfiguration` for dynamic updates. Note: VS Code's `multiCursorModifier` is the inverse of `gotoModifier` - it specifies which key adds cursors, and go-to-definition automatically uses the other key.)
- [x] Implement `blueprint.showProgressInGutter` setting (Completed: Added `blueprint.showProgressInGutter` boolean configuration setting in `packages/blueprint-lsp-client/package.json` with default `true`. Created SVG gutter icons in `packages/blueprint-lsp-client/icons/` for each requirement status: `complete.svg` (green checkmark), `in-progress.svg` (amber spinner), `blocked.svg` (red X), `no-ticket.svg` (gray dashed circle), `obsolete.svg` (gray minus), `pending.svg` (gray circle). Added custom LSP request `blueprint/requirementStatuses` in server `index.ts` that returns requirement positions and statuses for a document. Implemented `createGutterDecorationTypes()`, `updateGutterDecorations()`, `scheduleGutterUpdate()`, and `clearAllGutterDecorations()` functions in `extension.ts`. Gutter decorations update on document changes, visible editor changes, and file saves. Setting can be toggled dynamically via `updateGutterIconsEnabled()` which creates/disposes decoration types as needed.)
- [x] Implement `blueprint.hoverDelay` setting (Completed: Added `blueprint.hoverDelay` configuration setting in `packages/blueprint-lsp-client/package.json` with type `number`, default `300`, minimum `0`, maximum `10000`, and `language-overridable` scope. Added `editor.hover.delay: 300` to `configurationDefaults` for `[blueprint]` language. Added `updateHoverDelay()` function in `extension.ts` that syncs the Blueprint-specific setting to VS Code's language-specific `editor.hover.delay` setting. Configuration changes are listened to via `onDidChangeConfiguration` for dynamic updates.)

### 11.6 Progress Decorations

- [x] Create decoration types for each status (Completed: Added `createBackgroundDecorationTypes()` function that creates `TextEditorDecorationType` with background colors for each requirement status per SPEC.md Section 5.4. Default colors use low opacity (0.15) for subtle highlighting. Added `disposeBackgroundDecorationTypes()` and `clearAllBackgroundDecorations()` for cleanup.)
- [x] Apply decorations based on semantic tokens (Completed: Refactored `updateGutterDecorations()` to `updateDecorations()` which now applies both gutter icons and background decorations. Background decorations use `isWholeLine: true` to highlight the entire requirement line.)
- [x] Update decorations on document/ticket changes (Completed: Updated event handlers for `onDidChangeVisibleTextEditors`, `onDidChangeTextDocument`, and `onDidSaveTextDocument` to trigger decoration updates when either gutter or background decorations are enabled. Added `blueprint.showProgressHighlighting` configuration setting to enable/disable the feature.)

### 11.7 Gutter Icons

- [ ] Create icons for completion status (checkmark, progress, blocked)
- [ ] Apply gutter decorations based on requirement status
- [ ] Make gutter icons configurable

---

## Phase 12: Testing

### 12.1 Unit Tests

- [x] Test tree-sitter grammar with corpus files
- [x] Test AST transformation
- [x] Test dependency graph construction (27 tests in `dependency-graph.test.ts`)
- [x] Test cycle detection algorithm (Covered in `dependency-graph.test.ts` and `workspace-diagnostics.test.ts`)
- [x] Test ticket file parsing and validation (40 tests in `tickets.test.ts`)
- [x] Test requirement-ticket correlation (40 tests in `requirement-ticket-map.test.ts`)
- [x] Test semantic token generation (32 tests in `semantic-tokens.test.ts` covering token types, modifiers, progress-based highlighting, and `buildRequirementStatusMap()`)
- [x] Test hover information (29 tests in `hover.test.ts` covering node finding, hover targets, requirement/feature/module/constraint/reference/keyword hovers, blocking status display, and multiple tickets per requirement)
- [x] Test go-to-definition (17 tests in `definition.test.ts` covering node finding, definition targets for module/feature/requirement/constraint/reference/keyword, cross-file navigation, ticket file navigation, and fallback behavior)
- [x] Test find-references (21 tests in `references.test.ts` covering node finding, references targets for module/feature/requirement/constraint/reference/keyword, cross-file references, multiple references, includeDeclaration option, and parent reference matching)
- [x] Test document symbols (26 tests in `document-symbol.test.ts` covering empty documents, single/multiple modules, features, requirements, constraints at all levels, module-level requirements, symbol ranges, hierarchy building, and complex SPEC.md example structure)
- [x] Test workspace symbols (26 tests in `workspace-symbol.test.ts` covering empty index, single/multi-file index, query matching with prefix/substring/fuzzy, case-insensitive search, result sorting by relevance, result limiting, symbol kind mapping, container names, and edge cases)

### 12.2 Integration Tests

- [x] Test LSP initialization handshake (9 tests in `tests/integration/lsp-server.test.ts` covering server capabilities, workspace folder support, semantic token legend, text document sync with didOpen/didChange/didClose, hover for modules and requirements, and graceful shutdown. Tests spawn LSP server as subprocess and communicate via stdio using LSP protocol.)
- [x] Test document synchronization (Covered in `tests/integration/lsp-server.test.ts` - tests didOpen, didChange, didClose notifications and verifies server correctly processes document updates via documentSymbol requests)
- [x] Test diagnostic publishing (6 tests in `tests/integration/lsp-server.test.ts` covering syntax error diagnostics, unresolved reference diagnostics, no-ticket warnings, circular dependency errors, diagnostics clearing on document close, and diagnostics updating on content changes. Tests verify correct severity levels, diagnostic codes, and message content.)
- [x] Test hover information content (Covered in `tests/integration/lsp-server.test.ts` - tests hover for @module keyword and requirement identifiers, verifies hover contains expected content)
- [x] Test go-to-definition navigation (8 tests in `tests/integration/lsp-server.test.ts` covering: @depends-on reference navigation within same file, requirement identifier definition without ticket, constraint identifier definition, keyword returns null, unresolved reference returns null, cross-file reference navigation between storage.bp and auth.bp, feature identifier definition, and module identifier definition. Tests verify correct URI and range.start.line for all navigation targets.)
- [x] Test find-references results (8 tests in `tests/integration/lsp-server.test.ts` covering: @depends-on references to requirements, includeDeclaration flag behavior, cross-file references between multiple .bp files, references to features, references to modules, null for symbols with no references, null for keyword positions, and references from within @depends-on position.)
- [x] Test cross-file reference resolution (Covered in find-references tests: "finds cross-file references" test opens two files and verifies references from storage.bp symbol are found in payments.bp file.)

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

## Code Review: Phase 8 Hover Implementation (Commit 53001cb)

### SPEC Compliance Issues

- [ ] **Hover format does not match SPEC.md Section 5.5 exactly** - The SPEC.md Section 5.5 shows a specific box-style hover format with horizontal separators (`├──────────────────────────────────────────────────────────────────┤`), but the implementation uses standard Markdown headers and bullet lists. While the content is equivalent, the visual presentation differs. Consider whether the SPEC should be updated to reflect Markdown format, or if the implementation should attempt to match the boxed format more closely.

- [ ] **Module-level requirements path construction issue** - In `hover.ts:260-263` (`buildRequirementTarget`), when a requirement has no parent feature (module-level requirement), the path is constructed as `${moduleName}.${nameNode.text}`. However, per SPEC.md Section 3.3.3, "A requirement must be declared within a feature" - module-level requirements should not exist. The grammar and AST allow this, creating an inconsistency. Either:
  1. Update SPEC.md to explicitly allow module-level requirements, OR
  2. Add diagnostic errors for module-level requirements and remove this path handling

- [x] **Hover for @description block not implemented** - The `findHoverTarget` function (`hover.ts:108-158`) handles modules, features, requirements, constraints, references, and keywords, but does not handle hovering over `@description` blocks. SPEC.md Section 3.2.1 defines `@description` as a document-level keyword. Should show document-level context when hovering over description. (Fixed: Added `buildDescriptionTarget()` and `buildDescriptionHover()` functions in `hover.ts`. Description hover shows the description text content and overall document progress. 6 tests added in `hover.test.ts`.)

- [ ] **Missing file location in requirement hover** - SPEC.md Section 5.5 hover example shows ticket info with a "Files:" section listing implementation files like `src/auth/login.ts`. The implementation does include this (`hover.ts:470-476`), but the SPEC shows file paths without bullets in a clean format. Minor formatting difference.

### Implementation Issues

- [x] **Potential memory leak with tree cleanup** - In `index.ts:425-430` (semantic tokens handler), when parsing a document that isn't in the document manager, the code creates a tree with `parseDocument()` and calls `tree.delete()` after building tokens. However, if `buildSemanticTokens()` throws an exception, the tree won't be deleted. Should wrap in try/finally. (Fixed: Wrapped both `buildSemanticTokens()` and `buildDocumentSymbols()` calls in try/finally blocks to ensure `tree.delete()` is always called.)

- [x] **Inefficient re-computation of dependency graph and ticket map on each hover** - (Completed: Added `ComputedDataCache` class in `computed-data-cache.ts` that caches `DependencyGraph` and `RequirementTicketMap`. Cache is invalidated when symbol index changes (via `invalidateDependencyGraph()`) or tickets change (via `invalidateTicketMap()`). All document lifecycle handlers and file watcher handlers in `index.ts` now call appropriate invalidation methods. Hover, definition, references, and code actions handlers now use cached values. 16 tests added in `computed-data-cache.test.ts`.)

- [x] **No null check for ticketMap.get() result in reference hover** - (False positive: The `buildReferenceHover` function at line 824 has an early guard `if (!target.path) return null;` that ensures `target.path` is defined before it's used with `ticketMap.get()`. The optional `path` field is properly narrowed by TypeScript after this check.)

- [x] **Inconsistent status formatting** - (Fixed: Refactored `getStatusIcon` and `formatStatus` in `hover.ts` to use a centralized `STATUS_DISPLAY` constant map that pairs icons and formatted text together. Added `StatusDisplayInfo` interface and `getStatusDisplay()` function that returns both icon and text, ensuring they always stay in sync. Both `getStatusIcon()` and `formatStatus()` now delegate to this single source of truth.)

### Test Coverage Gaps

- [x] **No test for circular dependency display in hover** - While `hover.ts:488-492` handles `blockingInfo.status === "in-cycle"` and displays cycle information, there's no test case in `hover.test.ts` that creates an actual circular dependency and verifies the hover output shows the cycle. (Completed: Added two tests in `hover.test.ts` - one for a 2-node cycle (A ↔ B) and one for a 3-node cycle (A → B → C → A). Tests verify that "Part of circular dependency" warning is shown and the cycle path is displayed.)

- [x] **No test for transitive blockers truncation** - `hover.ts:499-501` shows "... and N more" when there are more than 3 transitive blockers, but no test verifies this truncation behavior. (Completed: Added two tests in `hover.test.ts` - "truncates transitive blockers when more than 3" tests with 4 transitive blockers showing "... and 1 more", and "shows all transitive blockers when 3 or fewer" verifies no truncation occurs with exactly 3 blockers.)

- [x] **No test for feature list in module hover** - `hover.ts:564-573` shows a "Features:" list in module hover, but only when `target.node` is available and has features. No test verifies this feature list is displayed correctly. (Completed: Added two tests in `hover.test.ts` - "shows features list with per-feature progress" tests a module with two features showing per-feature completion counts, and "does not show features section when module has no features" verifies the Features section is omitted for modules with only module-level requirements.)

- [x] **No test for module-level requirements in hover** - The code handles requirements that may exist directly under modules (no parent feature), but no test covers this edge case. (Completed: Added 3 tests in `hover.test.ts` covering module-level requirements: "shows hover for module-level requirement (no parent feature)" tests 2-part path like `config.load-config` with ticket info and constraints, "shows hover for module-level requirement with complete status" tests complete status with satisfied constraints and implementation files, "shows no tickets message for module-level requirement without tickets" tests the no-ticket state.)

- [x] **No test for hover on @depends-on keyword itself** - Tests cover hovering on references within `@depends-on`, but not on the `@depends-on` keyword itself. Should verify it shows the generic keyword documentation. (Completed: Added tests for `@depends-on` and `@constraint` keyword hovers in `hover.test.ts`. Both tests verify the keyword hover shows the generic Blueprint DSL Keyword documentation including the specific keyword description.)

- [x] **No test for empty constraint description** - `hover.ts:610-615` shows constraint description if available, but no test verifies behavior when description is empty or missing. (Completed: Added 3 tests in `hover.test.ts` covering constraint description handling: "shows description when constraint has description" verifies description section appears with content, "does not show description section when constraint has no description text" verifies no description section for constraints without description, "does not show description section when constraint description is whitespace only" verifies whitespace-only descriptions are treated as empty.)

### Code Quality

- [x] **Fix unused variable errors detected by ESLint** - ESLint reports 41 unused variable/import errors across the codebase. These include unused imports (e.g., `Diagnostic`, `Command`, `TicketFile`, `mock`, `cleanupParser`), unused function parameters (e.g., `context`, `symbolIndex`, `fileUri`), and unused local variables (e.g., `closingIndent`, `hasTrailingComma`, `identifierNode`). Fix by either removing unused code or prefixing intentionally unused parameters with `_`. Run `bun run lint` to see the full list. (Completed: Fixed all 41 unused variable/import errors by removing unused imports and prefixing intentionally unused parameters with `_`. ESLint now reports 0 errors.)

- [x] **Unused import in hover.ts** - `ReferenceNode` is imported in the type imports (`hover.ts:9`) but the `HoverTarget` interface uses `reference?: ReferenceNode` which is never actually populated - `buildReferenceTarget` doesn't set it. Either remove the field or populate it. (Fixed: Removed the unused `reference?: ReferenceNode` field from the `HoverTarget` interface since it was never populated and was causing a TypeScript compile error.)

- [x] **TypeScript compilation errors in code-actions.ts and tickets.ts** - `code-actions.ts` had variable name mismatches where `symbolIndex` and `fileUri` were used instead of the underscore-prefixed `_symbolIndex` and `_fileUri` parameters in `findSymbolAtPosition` function calls to `buildSymbolPath`. `tickets.ts` was missing the `stat` import from `node:fs/promises` used in `ticketFileExists`. (Fixed: Updated `code-actions.ts` lines 907, 910, 913 to use underscore-prefixed parameter names. Added `stat` to the import statement in `tickets.ts`.)

- [x] **Magic number for transitive blocker limit** - `hover.ts:499` uses `3` as the limit for showing transitive blockers before truncating. This should be a named constant for clarity. (Fixed: Extracted to `MAX_TRANSITIVE_BLOCKERS_DISPLAYED` constant in `hover.ts` with JSDoc documentation explaining its purpose.)

- [x] **Inconsistent ticket file creation for hover context** - (Fixed: Refactored `buildRequirementTicketMapFromSymbols()` in `requirement-ticket-map.ts` to accept `TicketFile | Ticket[] | null` instead of just `TicketFile | null`. Added new `buildRequirementTicketMapFromTickets()` function that handles raw ticket arrays and uses `"(aggregated)"` as the source for orphaned tickets. Updated `computed-data-cache.ts` and `workspace-diagnostics.ts` to pass the tickets array directly instead of creating a mock `TicketFile` with an invalid empty `source` field.)

---

## Code Review: Phase 3.3 AST Implementation (Commit 8899d29)

### SPEC Compliance Issues

- [ ] **Clarify requirement placement in SPEC or code** - SPEC.md Section 3.3.3 states "A requirement must be declared within a feature", but the AST implementation (`ModuleNode.requirements`) and grammar allow requirements directly under modules without a feature. Either update SPEC.md to allow module-level requirements, or remove this capability from the grammar/AST and add a diagnostic error.

- [x] **Missing `CommentNode` AST type** - Per SPEC.md Section 3.1.2, comments are "preserved for documentation purposes", but the AST has no `CommentNode` type. Add a `CommentNode` interface and collect comments during AST transformation for potential documentation extraction. (Completed: Added `CommentNode` interface with `type`, `text`, `style`, and `location` fields. Added `collectComments()` helper function that recursively collects all comment nodes from the tree-sitter parse tree. Updated `DocumentNode` to include a `comments` array. Updated `transformToAST()` to populate the comments array. Added 7 tests in `ast.test.ts` covering single-line comments at document level and inside modules, multiple comments throughout document, empty comments array for documents without comments, source location preservation, comment ordering, and comments inside constraints. Note: Multi-line comments have known grammar issues in some contexts - single-line comments work reliably.)

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
