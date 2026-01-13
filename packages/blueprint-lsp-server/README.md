# blueprint-lsp-server

Language Server Protocol (LSP) server for the Blueprint DSL. Provides IDE features including hover, go-to-definition, find-references, diagnostics, code actions, and autocompletion.

## Installation

```bash
bun install
```

## Running

```bash
bun run index.ts
```

## Features

### Autocompletion

The LSP server provides comprehensive autocompletion support for Blueprint files.

#### Trigger Characters

| Character | Context          | Description                                                     |
| --------- | ---------------- | --------------------------------------------------------------- |
| `@`       | Line start       | Triggers keyword completion (`@module`, `@feature`, etc.)       |
| `.`       | After identifier | Triggers path navigation (e.g., `auth.` shows features in auth) |

#### Completion Types

**Keyword Completion**

Typing `@` at valid positions shows context-aware keyword suggestions:

```blueprint
@  // Shows: @module, @description (at top-level)

@module auth
  @  // Shows: @feature, @requirement, @constraint, @depends-on
```

Keywords are filtered by scope - you won't see `@module` inside a feature block.

**Reference Completion**

After `@depends-on`, the server suggests referenceable symbols:

```blueprint
@depends-on au  // Shows: auth, auth.login, auth.session, etc.
```

Features:

- Fuzzy matching (typing "vl" matches "validate")
- Circular dependency filtering (won't suggest dependencies that create cycles)
- Self-reference filtering (can't depend on yourself)
- Local symbols boosted in ranking

**Path Navigation**

Typing `.` after an identifier shows direct children:

```blueprint
@depends-on auth.  // Shows: login, session, logout (features in auth)
@depends-on auth.login.  // Shows: validate-credentials, create-session
```

**Constraint Name Completion**

After `@constraint`, suggests common constraint names from the workspace:

```blueprint
@constraint rate  // Shows: rate-limiting (used 5 times), rate-throttle
```

Suggestions are ranked by usage frequency.

**Identifier Name Completion**

When naming new elements, suggests action-based patterns:

```blueprint
@requirement val  // Shows: validate-..., validate-credentials, validate-input
```

For requirements, suggests action verb patterns like `validate-`, `create-`, `update-`.

**Code Block Language Completion**

After triple backticks, suggests language identifiers:

````blueprint
```typ  // Shows: typescript, typescriptreact
````

Supports common languages: `typescript`, `javascript`, `json`, `sql`, `graphql`, `python`, etc.

**Description Templates**

Inside `@description` blocks, suggests documentation templates:

```blueprint
@description
  // At empty line start, shows: "This document describes...", "Purpose:", "Goals:"
```

#### Snippets

Keywords insert as snippets with tab stops for efficient editing:

```
@module -> @module ${1:name}
              $0
@feature -> @feature ${1:name}
               $0
@depends-on -> @depends-on ${1:reference}$0
```

#### Lazy Documentation

Completion items show basic info initially. When you focus an item, full documentation loads including:

- Symbol description
- Dependency count and list
- Constraint count and list
- File location with link

### Other LSP Features

- **Hover**: Shows ticket status, description, dependencies, and constraints
- **Go-to-definition**: Navigate to referenced symbols or ticket files
- **Find references**: Find all `@depends-on` references to a symbol
- **Diagnostics**: Syntax errors, circular dependencies, unresolved references
- **Code actions**: Create tickets, fix typos in references
- **Document/Workspace symbols**: Browse and search symbols

## Development

This project was created using `bun init` in bun v1.3.5. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

### Running Tests

```bash
bun test
```

### Type Checking

```bash
bunx tsc --noEmit
```
