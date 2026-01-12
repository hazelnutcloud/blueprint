# Blueprint

A domain-specific language for writing software requirements that integrates with coding agents through an LSP-powered development experience.

## Overview

Blueprint is a human-authored requirements language designed to communicate intent to coding agents. The DSL provides a structured yet readable format for defining software requirements at multiple levels of granularity.

**Key Principles:**

- **Human-owned requirements**: `.bp` files are authored and maintained exclusively by humans
- **Agent-owned tickets**: Coding agents track implementation progress through `.tickets.json` files
- **Bidirectional traceability**: The LSP provides real-time visibility into the relationship between requirements and tickets
- **Minimal ticket context**: Ticket files are intentionally minimal; the LSP handles derived information like dependency resolution and aggregate progress

## Installation

### Prerequisites

- [Bun](https://bun.sh/) v1.0 or later
- [VS Code](https://code.visualstudio.com/) v1.85.0 or later (for the editor extension)

### Building from Source

1. Clone the repository:

```bash
git clone https://github.com/blueprintlang/blueprint.git
cd blueprint
```

2. Install dependencies:

```bash
bun install
```

3. Generate the tree-sitter parser:

```bash
cd packages/tree-sitter-blueprint
bunx tree-sitter generate
```

4. Build the LSP server:

```bash
cd packages/blueprint-lsp-server
bun run build
```

5. Build the VS Code extension:

```bash
cd packages/blueprint-lsp-client
bun run compile
```

### Installing the VS Code Extension

During development, you can run the extension in VS Code's Extension Development Host:

1. Open the project root in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open any `.bp` file to activate the extension

## Quick Start

Create a new file with the `.bp` extension:

```blueprint
// authentication.bp

@description
  User authentication system for a web application.

@module authentication
  Handles user identity verification and session management.

@feature login
  Users can authenticate using various methods.

  @requirement basic-auth
    Users can log in using email and password.

    The system validates credentials against stored records
    and returns an authentication token on success.

    @constraint bcrypt-hashing
      Passwords must be verified using bcrypt with cost factor >= 12.

    @constraint rate-limiting
      Limit failed login attempts to 5 per 15 minutes per IP.

  @requirement oauth-login
    @depends-on authentication.login.basic-auth

    Users can authenticate using OAuth providers (Google, GitHub).

    @constraint csrf-protection
      OAuth state parameter must be validated.
```

## Language Syntax

### Hierarchy Keywords

| Keyword        | Purpose                    | Scope          |
| -------------- | -------------------------- | -------------- |
| `@description` | Document-level description | File           |
| `@module`      | Major system boundary      | Top-level      |
| `@feature`     | User-facing capability     | Within module  |
| `@requirement` | Implementable unit         | Within feature |

### Annotation Keywords

| Keyword       | Purpose                               |
| ------------- | ------------------------------------- |
| `@depends-on` | Declares dependency on other elements |
| `@constraint` | Defines implementation requirements   |

### Comments

```blueprint
// Single-line comment

/*
  Multi-line comment
*/
```

## Project Structure

```
project/
├── requirements/
│   ├── auth.bp
│   └── payments.bp
├── .blueprint/
│   └── tickets/
│       ├── auth.tickets.json
│       └── payments.tickets.json
└── src/
    └── ... (generated code)
```

## LSP Features

The Blueprint LSP provides:

- **Syntax highlighting** with status-based coloring
- **Hover information** showing ticket status, constraint satisfaction, and dependencies
- **Go-to-definition** for navigating between requirements and tickets
- **Find references** to see all dependencies on a requirement
- **Diagnostics** for syntax errors, circular dependencies, and missing tickets
- **Code actions** for creating tickets and fixing typos in references

For VS Code extension configuration, keyboard shortcuts, and detailed usage, see the [VS Code Extension README](./packages/blueprint-lsp-client/README.md).

## Development

### Running Tests

```bash
# Run LSP server tests
cd packages/blueprint-lsp-server
bun test

# Run tree-sitter corpus tests
cd packages/tree-sitter-blueprint
bunx tree-sitter test

# Run VS Code extension E2E tests
cd packages/blueprint-lsp-client
bun run test
```

### Type Checking

```bash
cd packages/blueprint-lsp-server
bunx tsc --noEmit
```

### Linting and Formatting

```bash
# From project root
bun run lint
bun run format
```

### Benchmarks

```bash
cd packages/blueprint-lsp-server
bun run bench:all
```

## Monorepo Structure

| Package                          | Description                       |
| -------------------------------- | --------------------------------- |
| `packages/blueprint-lsp-server`  | LSP server implementation         |
| `packages/blueprint-lsp-client`  | VS Code extension client          |
| `packages/tree-sitter-blueprint` | Tree-sitter grammar for Blueprint |

## Specification

See [SPEC.md](./SPEC.md) for the complete language specification including:

- Lexical structure and grammar (EBNF)
- Ticket artifact schema
- LSP behavior specification
- Agent behavior specification

## License

MIT
