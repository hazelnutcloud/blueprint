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

- [ ] Create `BLOCK_KEYWORDS` constant with all Blueprint keywords:
  - `@module`, `@feature`, `@requirement`, `@constraint`, `@depends-on`, `@description`
- [ ] Define keyword metadata (valid contexts, snippets, descriptions)
- [ ] Create `CompletionContext` type to track cursor context
- [ ] Define `CompletionScope` enum: `TopLevel`, `Module`, `Feature`, `Requirement`

---

## Phase 2: Context Detection

### 2.1 Cursor Position Analysis

- [ ] Create `getCursorContext(document, position, tree)` function
- [ ] Implement `findContainingBlock(tree, position)` to find parent scope
- [ ] Determine if cursor is at line start, after keyword, or mid-expression
- [ ] Detect if cursor is inside a comment or code block (skip completion)

### 2.2 Scope Detection

- [ ] Implement `getCurrentScope(tree, position)` function
- [ ] Walk parent nodes to determine nesting level
- [ ] Return scope type: top-level, inside module, inside feature, inside requirement
- [ ] Track the fully-qualified path to current scope (e.g., `auth.login`)

### 2.3 Trigger Context Detection

- [ ] Detect `@` trigger at start of line/block for keyword completion
- [ ] Detect `.` trigger after identifier for path completion
- [ ] Detect `@depends-on` context for reference completion
- [ ] Handle text preceding cursor for filtering suggestions

---

## Phase 3: Keyword Completion

### 3.1 Basic Keyword Suggestions

- [ ] Implement `getKeywordCompletions(scope, prefix)` function
- [ ] Filter keywords based on current scope validity:
  - Top-level: `@description` (if not present), `@module`
  - Module: `@feature`, `@requirement`, `@constraint`, `@depends-on`, description text
  - Feature: `@requirement`, `@constraint`, `@depends-on`, description text
  - Requirement: `@constraint`, `@depends-on`, description text
- [ ] Apply prefix filtering for partial matches

### 3.2 Keyword Snippets

- [ ] Create snippet templates for each keyword:
  - `@module` -> `@module ${1:name}\n\t$0`
  - `@feature` -> `@feature ${1:name}\n\t$0`
  - `@requirement` -> `@requirement ${1:name}\n\t$0`
  - `@constraint` -> `@constraint ${1:name} $0`
  - `@depends-on` -> `@depends-on ${1:reference}$0`
  - `@description` -> `@description\n$0`
- [ ] Set `insertTextFormat: InsertTextFormat.Snippet`

### 3.3 Keyword Documentation

- [ ] Add `documentation` field with MarkupContent for each keyword
- [ ] Include usage examples in documentation
- [ ] Describe valid contexts and constraints

---

## Phase 4: Reference Completion

### 4.1 Reference Context Detection

- [ ] Detect cursor is after `@depends-on` keyword
- [ ] Parse existing references in the same `@depends-on` clause
- [ ] Determine if adding first reference or comma-separated addition
- [ ] Extract partial reference text for filtering

### 4.2 Symbol Gathering

- [ ] Query `CrossFileSymbolIndex` for all available symbols
- [ ] Filter out symbols that would create circular dependencies
- [ ] Filter out self-references (cannot depend on yourself)
- [ ] Filter by kind: only modules, features, requirements can be referenced

### 4.3 Reference Filtering and Sorting

- [ ] Apply prefix matching from partial reference text
- [ ] Score results using existing `matchesQuery` logic from `workspace-symbol.ts`
- [ ] Sort by: exact match > prefix match > substring match > fuzzy match
- [ ] Boost local symbols (same file) in ranking
- [ ] Limit results to reasonable count (e.g., 50)

### 4.4 Reference Completion Items

- [ ] Create `CompletionItem` for each matching symbol
- [ ] Set `kind` to appropriate `CompletionItemKind` (Module/Class/Function)
- [ ] Set `detail` to symbol kind and file location
- [ ] Set `documentation` to symbol description if available
- [ ] Set `filterText` and `sortText` for proper ordering

---

## Phase 5: Path Completion (Dot Navigation)

### 5.1 Path Context Parsing

- [ ] Detect `.` trigger after an identifier
- [ ] Parse the path prefix before the dot (e.g., `auth.login.` -> `["auth", "login"]`)
- [ ] Validate prefix resolves to a valid symbol
- [ ] Handle invalid prefix gracefully (no suggestions)

### 5.2 Child Symbol Resolution

- [ ] Implement `getChildSymbols(parentPath)` function
- [ ] Query `CrossFileSymbolIndex` for symbols under parent path
- [ ] Filter to direct children only (one level deeper)
- [ ] Return features for module path, requirements for feature path

### 5.3 Path Completion Items

- [ ] Create `CompletionItem` for each child symbol
- [ ] Use short name (not full path) as label
- [ ] Include full path in `detail` for disambiguation
- [ ] Set appropriate icon based on symbol kind

---

## Phase 6: Advanced Features

### 6.1 Constraint Name Completion

- [ ] Detect cursor is after `@constraint` keyword
- [ ] Suggest common constraint names from workspace
- [ ] Collect unique constraint names from `CrossFileSymbolIndex`
- [ ] Rank by frequency of use

### 6.2 Description Block Completion

- [ ] After `@description`, suggest common description starters
- [ ] Provide templates for requirement descriptions
- [ ] No aggressive completion inside description text

### 6.3 Code Block Completion

- [ ] After triple backticks, suggest language identifiers
- [ ] Common languages: `typescript`, `javascript`, `json`, `sql`, `graphql`, `http`
- [ ] Do not provide completion inside code block content

### 6.4 Identifier Suggestions

- [ ] When typing a new identifier name, suggest based on context
- [ ] For requirements in a feature, suggest action-based names
- [ ] Optional: learn from existing naming patterns

---

## Phase 7: Completion Resolve

### 7.1 Lazy Documentation Loading

- [ ] Implement `onCompletionResolve` handler
- [ ] Load full documentation only when item is focused
- [ ] Fetch symbol details from AST for rich documentation

### 7.2 Rich Documentation Content

- [ ] Include symbol description text
- [ ] Show dependency count and list
- [ ] Show constraint count and list
- [ ] Include file location with clickable link
- [ ] Format as Markdown for proper rendering

---

## Phase 8: Testing

### 8.1 Unit Tests for Context Detection

- [ ] Create `packages/blueprint-lsp-server/src/completion.test.ts`
- [ ] Test `getCursorContext` at various positions
- [ ] Test `getCurrentScope` with nested structures
- [ ] Test trigger character detection

### 8.2 Unit Tests for Keyword Completion

- [ ] Test keyword filtering by scope
- [ ] Test snippet generation
- [ ] Test prefix filtering

### 8.3 Unit Tests for Reference Completion

- [ ] Test reference gathering from symbol index
- [ ] Test circular dependency filtering
- [ ] Test scoring and sorting

### 8.4 Unit Tests for Path Completion

- [ ] Test path prefix parsing
- [ ] Test child symbol resolution
- [ ] Test invalid path handling

### 8.5 Integration Tests

- [ ] Test full completion flow with mock LSP connection
- [ ] Test with multi-file workspace
- [ ] Test with large symbol index

---

## Phase 9: Documentation and Polish

### 9.1 Code Documentation

- [ ] Add JSDoc comments to all public functions
- [ ] Document the completion provider architecture
- [ ] Add inline comments for complex logic

### 9.2 Update Package Documentation

- [ ] Update README with completion feature description
- [ ] Document trigger characters and behavior
- [ ] Add examples of completion scenarios

### 9.3 Performance Optimization

- [ ] Profile completion performance with large workspaces
- [ ] Add caching for frequently accessed data
- [ ] Implement debouncing if needed
- [ ] Consider incremental updates to symbol index

### 9.4 Edge Cases and Error Handling

- [ ] Handle empty/corrupted documents gracefully
- [ ] Handle partial parse trees (syntax errors)
- [ ] Test with cursor at document boundaries
- [ ] Ensure no crashes on malformed input

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
