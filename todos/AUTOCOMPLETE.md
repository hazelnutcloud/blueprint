# Blueprint LSP Autocompletion Implementation Plan

This document outlines the granular, actionable tasks required to add autocompletion features to the Blueprint LSP server.

## Overview

The Blueprint LSP currently supports hover, go-to-definition, find-references, document symbols, workspace symbols, and code actions. This plan adds comprehensive autocompletion support including:

- Keyword completion (`@module`, `@feature`, `@requirement`, `@constraint`, `@depends-on`, `@description`)
- Reference completion (for `@depends-on` clauses)
- Path completion with dot-notation navigation
- Context-aware suggestions based on cursor position

---

## Phase 1: Foundation Setup

### 1.1 Create Completion Provider Module

- [x] Create new file `packages/blueprint-lsp-server/src/completion.ts`
- [x] Define `CompletionProvider` interface/class structure
- [x] Add necessary imports from `vscode-languageserver`
- [x] Export main completion handler function

### 1.2 Register Completion Capability

- [x] Update `index.ts` to declare `completionProvider` in server capabilities
- [x] Configure trigger characters: `@` (keywords), `.` (path navigation)
- [x] Set `resolveProvider: true` for lazy resolution of completion details
- [x] Register `onCompletion` handler
- [x] Register `onCompletionResolve` handler

### 1.3 Define Completion Types and Constants

- [x] Create `BLOCK_KEYWORDS` constant with all Blueprint keywords:
  - `@module`, `@feature`, `@requirement`, `@constraint`, `@depends-on`, `@description`
- [x] Define keyword metadata (valid contexts, snippets, descriptions)
- [x] Create `CompletionContext` type to track cursor context
- [x] Define `CompletionScope` type: `top-level`, `module`, `feature`, `requirement` (union type, TypeScript best practice over enum)

---

## Phase 2: Context Detection

### 2.1 Cursor Position Analysis

- [x] Create `getCursorContext(document, position, tree)` function
- [x] Implement `findContainingBlock(tree, position)` to find parent scope
- [x] Determine if cursor is at line start, after keyword, or mid-expression
- [x] Detect if cursor is inside a comment or code block (skip completion)

### 2.2 Scope Detection

- [x] Implement `getCurrentScope(tree, position)` function
- [x] Walk parent nodes to determine nesting level
- [x] Return scope type: top-level, inside module, inside feature, inside requirement
- [x] Track the fully-qualified path to current scope (e.g., `auth.login`)

### 2.3 Trigger Context Detection

- [x] Detect `@` trigger at start of line/block for keyword completion
- [x] Detect `.` trigger after identifier for path completion
- [x] Detect `@depends-on` context for reference completion
- [x] Handle text preceding cursor for filtering suggestions

---

## Phase 3: Keyword Completion

### 3.1 Basic Keyword Suggestions

- [x] Implement `getKeywordCompletions(scope, prefix)` function
- [x] Filter keywords based on current scope validity:
  - Top-level: `@description` (if not present), `@module`
  - Module: `@feature`, `@requirement`, `@constraint`, `@depends-on`, description text
  - Feature: `@requirement`, `@constraint`, `@depends-on`, description text
  - Requirement: `@constraint`, `@depends-on`, description text
- [x] Apply prefix filtering for partial matches

### 3.2 Keyword Snippets

- [x] Create snippet templates for each keyword:
  - `@module` -> `@module ${1:name}\n\t$0`
  - `@feature` -> `@feature ${1:name}\n\t$0`
  - `@requirement` -> `@requirement ${1:name}\n\t$0`
  - `@constraint` -> `@constraint ${1:name} $0`
  - `@depends-on` -> `@depends-on ${1:reference}$0`
  - `@description` -> `@description\n$0`
- [x] Set `insertTextFormat: InsertTextFormat.Snippet`

### 3.3 Keyword Documentation

- [x] Add `documentation` field with MarkupContent for each keyword
- [x] Include usage examples in documentation
- [x] Describe valid contexts and constraints

---

## Phase 4: Reference Completion

### 4.1 Reference Context Detection

- [x] Detect cursor is after `@depends-on` keyword
- [x] Parse existing references in the same `@depends-on` clause
- [x] Determine if adding first reference or comma-separated addition
- [x] Extract partial reference text for filtering

### 4.2 Symbol Gathering

- [x] Query `CrossFileSymbolIndex` for all available symbols
- [x] Filter out symbols that would create circular dependencies
- [x] Filter out self-references (cannot depend on yourself)
- [x] Filter by kind: only modules, features, requirements can be referenced

### 4.3 Reference Filtering and Sorting

- [x] Apply prefix matching from partial reference text
- [x] Score results using existing `matchesQuery` logic from `workspace-symbol.ts`
- [x] Sort by: exact match > prefix match > substring match > fuzzy match
- [x] Boost local symbols (same file) in ranking
- [x] Limit results to reasonable count (e.g., 50)

### 4.4 Reference Completion Items

- [x] Create `CompletionItem` for each matching symbol
- [x] Set `kind` to appropriate `CompletionItemKind` (Module/Class/Function)
- [x] Set `detail` to symbol kind and file location
- [x] Set `documentation` to symbol description if available
- [x] Set `filterText` and `sortText` for proper ordering

---

## Phase 5: Path Completion (Dot Navigation)

### 5.1 Path Context Parsing

- [x] Detect `.` trigger after an identifier
- [x] Parse the path prefix before the dot (e.g., `auth.login.` -> `["auth", "login"]`)
- [x] Validate prefix resolves to a valid symbol
- [x] Handle invalid prefix gracefully (no suggestions)

### 5.2 Child Symbol Resolution

- [x] Implement `getChildSymbols(parentPath)` function (as `getPathCompletions`)
- [x] Query `CrossFileSymbolIndex` for symbols under parent path
- [x] Filter to direct children only (one level deeper)
- [x] Return features for module path, requirements for feature path

### 5.3 Path Completion Items

- [x] Create `CompletionItem` for each child symbol
- [x] Use short name (not full path) as label
- [x] Include full path in `detail` for disambiguation
- [x] Set appropriate icon based on symbol kind

---

## Phase 6: Advanced Features

### 6.1 Constraint Name Completion

- [x] Detect cursor is after `@constraint` keyword
- [x] Suggest common constraint names from workspace
- [x] Collect unique constraint names from `CrossFileSymbolIndex`
- [x] Rank by frequency of use

### 6.2 Description Block Completion

- [x] After `@description`, suggest common description starters
- [x] Provide templates for requirement descriptions
- [x] No aggressive completion inside description text

### 6.3 Code Block Completion

- [x] After triple backticks, suggest language identifiers
- [x] Common languages: `typescript`, `javascript`, `json`, `sql`, `graphql`, `http`
- [x] Do not provide completion inside code block content

### 6.4 Identifier Suggestions

- [x] When typing a new identifier name, suggest based on context
- [x] For requirements in a feature, suggest action-based names
- [x] Optional: learn from existing naming patterns

---

## Phase 7: Completion Resolve

### 7.1 Lazy Documentation Loading

- [x] Implement `onCompletionResolve` handler
- [x] Load full documentation only when item is focused
- [x] Fetch symbol details from AST for rich documentation

### 7.2 Rich Documentation Content

- [x] Include symbol description text
- [x] Show dependency count and list
- [x] Show constraint count and list
- [x] Include file location with clickable link
- [x] Format as Markdown for proper rendering

---

## Phase 8: Testing

### 8.1 Unit Tests for Context Detection

- [x] Create `packages/blueprint-lsp-server/src/completion.test.ts`
- [x] Test `getCursorContext` at various positions
- [x] Test `getCurrentScope` with nested structures
- [x] Test trigger character detection

### 8.2 Unit Tests for Keyword Completion

- [x] Test keyword filtering by scope
- [x] Test snippet generation
- [x] Test prefix filtering

### 8.3 Unit Tests for Reference Completion

- [x] Test reference gathering from symbol index
- [x] Test circular dependency filtering
- [x] Test scoring and sorting

### 8.4 Unit Tests for Path Completion

- [x] Test path prefix parsing
- [x] Test child symbol resolution
- [x] Test invalid path handling

### 8.5 Integration Tests

- [x] Test full completion flow with mock LSP connection
- [x] Test with multi-file workspace
- [x] Test with large symbol index

---

## Phase 9: Documentation and Polish

### 9.1 Code Documentation

- [x] Add JSDoc comments to all public functions
- [x] Document the completion provider architecture
- [x] Add inline comments for complex logic

### 9.2 Update Package Documentation

- [x] Update README with completion feature description
- [x] Document trigger characters and behavior
- [x] Add examples of completion scenarios

### 9.3 Performance Optimization

- [x] Profile completion performance with large workspaces
- [x] Add caching for frequently accessed data
- [x] Implement debouncing if needed (evaluated: not needed - LSP clients handle debouncing via request cancellation; server-side debouncing would add latency without benefit)
- [x] Consider incremental updates to symbol index (implemented: addFile/removeFile now compute diffs and selectively invalidate only affected symbol kind caches)

### 9.4 Edge Cases and Error Handling

- [x] Handle empty/corrupted documents gracefully
- [x] Handle partial parse trees (syntax errors)
- [x] Test with cursor at document boundaries
- [x] Ensure no crashes on malformed input

---

## Implementation Order

Recommended order of implementation:

1. **Phase 1** - Foundation (required for anything to work)
2. **Phase 2** - Context Detection (required for intelligent completion)
3. **Phase 3** - Keyword Completion (most impactful, easiest win)
4. **Phase 4** - Reference Completion (core feature for `@depends-on`)
5. **Phase 5** - Path Completion (natural extension of reference completion)
6. **Phase 8.1-8.4** - Unit Tests (validate as you go)
7. **Phase 6** - Advanced Features (nice-to-have)
8. **Phase 7** - Completion Resolve (optimization)
9. **Phase 9** - Documentation and Polish (final step)

---

## Dependencies

### Existing Code to Reuse

| Source File           | What to Reuse                                            |
| --------------------- | -------------------------------------------------------- |
| `symbol-index.ts`     | `CrossFileSymbolIndex` for symbol queries                |
| `workspace-symbol.ts` | `matchesQuery`, `calculateScore` for fuzzy matching      |
| `code-actions.ts`     | `findSimilarSymbols`, `stringSimilarity` for suggestions |
| `hover.ts`            | `findHoverTarget` pattern for context detection          |
| `parser.ts`           | `findNodeAtPosition` for tree navigation                 |
| `semantic-tokens.ts`  | `BLOCK_KEYWORDS` constant                                |
| `ast.ts`              | AST type definitions                                     |

### New Dependencies

- No new npm packages required
- Uses existing `vscode-languageserver` completion types

---

## Success Criteria

- [ ] Typing `@` at valid positions shows keyword completions
- [ ] Keywords are filtered by current scope (no invalid suggestions)
- [ ] Typing `@depends-on ` shows available references
- [ ] Typing `module.` shows features within that module
- [ ] Completions include documentation and snippets
- [ ] Performance is acceptable (<100ms response time)
- [ ] All tests pass
- [ ] No regressions in existing LSP features
