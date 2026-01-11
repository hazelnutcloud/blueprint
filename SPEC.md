# Blueprint DSL Specification

A domain-specific language for writing software requirements that integrates with coding agents through an LSP-powered development experience.

---

## 1. Overview

### 1.1 Purpose

Blueprint is a human-authored requirements language designed to communicate intent to coding agents. The DSL provides a structured yet readable format for defining software requirements at multiple levels of granularity.

### 1.2 Core Principles

**Human-owned requirements**: The `.bp` files are authored and maintained exclusively by humans. The coding agent never modifies these files.

**Agent-owned tickets**: The coding agent tracks implementation progress through separate ticket artifacts that it creates and maintains. These tickets reference requirements but exist independently.

**Minimal ticket context**: Ticket files are intentionally minimal to reduce context size for agents and prevent drift. The LSP/compiler handles derived information like dependency resolution and aggregate progress.

**Bidirectional traceability**: The LSP provides real-time visibility into the relationship between requirements and tickets, enabling hover-to-view and click-to-navigate interactions.

**Change-driven synchronization**: When humans modify requirement files, the agent analyzes the diff and updates its tickets accordingly—creating, modifying, or closing tickets as needed.

### 1.3 File Extension

Requirements files use the `.bp` extension.

---

## 2. Architecture

### 2.1 System Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Developer's Editor                          │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────────┐   │
│  │  .bp files   │    │     LSP       │    │  Ticket Viewer    │   │
│  │  (human-owned)│◄──►│   Server      │◄──►│  (hover/goto)     │   │
│  └───────────────┘    └───────┬───────┘    └───────────────────┘   │
└───────────────────────────────┼─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Coding Agent                               │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────────┐   │
│  │  Requirement  │    │    Ticket     │    │      Code         │   │
│  │  Analyzer     │───►│   Manager     │───►│    Generator      │   │
│  └───────────────┘    └───────────────┘    └───────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│                       ┌─────────────┐                               │
│                       │   .tickets  │                               │
│                       │    files    │                               │
│                       │(agent-owned)│                               │
│                       └─────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 File Ownership Model

| Artifact | Owner | Operations |
|----------|-------|------------|
| `.bp` files | Human | Create, read, update, delete |
| `.tickets.json` files | Agent | Create, read, update, delete |
| Source code | Agent | Create, read, update, delete |
| LSP index | LSP/Compiler | Read `.bp`, read `.tickets.json`, compute derived data |

### 2.3 Directory Structure

```
project/
├── requirements/
│   ├── auth.bp
│   ├── payments.bp
│   └── notifications.bp
├── .blueprint/
│   └── tickets/
│       ├── auth.tickets.json
│       ├── payments.tickets.json
│       └── notifications.tickets.json
└── src/
    └── ... (generated code)
```

---

## 3. Language Specification

### 3.1 Lexical Structure

#### 3.1.1 Character Set

Blueprint files are UTF-8 encoded. Line endings may be LF or CRLF (normalized to LF during parsing).

#### 3.1.2 Comments

```blueprint
// Single-line comment

/*
  Multi-line comment
  Can span multiple lines
*/
```

Comments are ignored by the parser but preserved for documentation purposes.

#### 3.1.3 Identifiers

Identifiers are used for naming modules, features, and requirements. They must:

- Start with a letter (a-z, A-Z) or underscore
- Contain only letters, digits, underscores, and hyphens
- Be unique within their scope
- Be case-sensitive

```blueprint
// Valid identifiers
user_authentication
payment-processing
OAuth2Flow
_internal_module

// Invalid identifiers
2fa-setup          // starts with digit
payment processing // contains space
```

### 3.2 Document-Level Keywords

#### 3.2.1 @description

Provides a high-level description of the software system these requirements define. This keyword may only appear once per `.bp` file and must appear before any `@module` declaration.

**Syntax:**
```blueprint
@description
  <description-text>
```

**Semantics:**
- Must appear at most once per file
- Must appear before any `@module` declaration
- Provides context for the entire requirements document
- Helps agents understand the overall system being built

**Example:**
```blueprint
@description
  CloudVault is a secure file storage and sharing platform for enterprise
  teams. It provides end-to-end encryption, fine-grained access controls,
  and seamless integration with existing productivity tools.
  
  This requirements document covers the authentication and authorization
  subsystems that form the security foundation of the platform.

@module authentication
  ...
```

### 3.3 Hierarchy Keywords

Blueprint defines three levels of hierarchy, each serving a distinct organizational purpose.

#### 3.3.1 @module

Modules represent major system boundaries or architectural components. They are the highest level of organization.

**Syntax:**
```blueprint
@module <identifier>
  <description>
  
  <children>
```

**Semantics:**
- A module may contain features, requirements, and constraints
- Modules cannot be nested within other modules
- A module's scope extends until the next `@module` declaration or end of file

**Example:**
```blueprint
@module authentication
  Handles all aspects of user identity verification and session management.
  This module is critical for security and must undergo additional review.
  
  @feature login
    ...
```

#### 3.3.2 @feature

Features represent user-facing capabilities or distinct functional areas within a module.

**Syntax:**
```blueprint
@feature <identifier>
  <description>
  
  <children>
```

**Semantics:**
- A feature must be declared within a module
- A feature may contain requirements and constraints
- Features cannot be nested within other features

**Example:**
```blueprint
@module authentication

@feature login
  Users can authenticate using email/password or OAuth providers.
  
  @requirement basic-auth
    ...
    
  @requirement oauth-flow
    ...
```

#### 3.3.3 @requirement

Requirements represent specific, implementable units of functionality. Requirements are the leaf nodes that the agent implements via tickets.

**Syntax:**
```blueprint
@requirement <identifier>
  <description>
  
  <annotations>
```

**Semantics:**
- A requirement must be declared within a feature
- Requirements are the atomic units of specification
- Requirements may contain constraints
- Requirements cannot contain other requirements (flat within features)
- Each requirement may generate one or more tickets (agent decides decomposition)

**Example:**
```blueprint
@requirement basic-auth
  Users can log in using their email address and password.
  
  The system accepts an email and password, validates the credentials
  against stored records, and returns an authentication token upon
  successful verification.
  
  @constraint bcrypt-hashing
    Passwords must be verified using bcrypt with a minimum cost factor of 12.
    
  @constraint audit-logging
    Failed login attempts must be logged with timestamp and source IP.
```

### 3.4 Annotation Keywords

#### 3.4.1 @depends-on

Declares a dependency relationship between elements. Dependencies are resolved by the LSP/compiler for scheduling and visualization.

**Syntax:**
```blueprint
@depends-on <reference> [, <reference>]*
```

**Reference Format:**
References use dot notation to specify the path to the target element:

- `module-name` — depends on entire module (all requirements within)
- `module-name.feature-name` — depends on entire feature (all requirements within)
- `module-name.feature-name.requirement-name` — depends on specific requirement

**Semantics:**
- Dependencies can be declared at any hierarchy level (module, feature, or requirement)
- A dependency implies that the referenced element must be implemented before the current element
- Circular dependencies are detected by the LSP/compiler and reported as errors
- Cross-file dependencies are supported
- The agent does not track dependencies in tickets; the LSP/compiler resolves them

**Examples:**
```blueprint
@module payments
  @depends-on authentication
  
  Payment processing requires users to be authenticated.

@feature checkout
  @depends-on payments.cart, inventory.stock-management
  
  Checkout requires cart functionality and stock verification.

@requirement process-refund
  @depends-on payments.checkout.capture-payment
  
  Refunds can only be processed for captured payments.
```

#### 3.4.2 @constraint

Defines implementation requirements that must be satisfied. Constraints are hard rules that the generated code must follow. Each constraint has an identifier for tracking.

**Syntax:**
```blueprint
@constraint <identifier>
  <constraint-description>
```

**Semantics:**
- Constraints apply to the immediately enclosing element (module, feature, or requirement)
- Each constraint has a unique identifier within its parent scope
- Multiple constraints can be declared; each creates a separate checkable condition
- Constraints should be specific and verifiable
- The agent tracks which constraints are satisfied using their identifiers

**Examples:**
```blueprint
@requirement store-password
  User passwords must be securely stored.
  
  @constraint bcrypt-cost
    Use bcrypt with cost factor >= 12 for password hashing.
    
  @constraint no-plaintext
    Never log or store plaintext passwords, even temporarily.
    
  @constraint unique-salt
    Salt must be unique per password and stored alongside the hash.
```

### 3.5 Description Blocks

Any text that is not a keyword or identifier is treated as description content. Descriptions provide context, rationale, and details that help the agent understand intent.

**Formatting:**
- Descriptions are free-form prose
- Blank lines separate paragraphs
- Markdown-style formatting is allowed for emphasis but not required
- Code examples can be included using fenced code blocks

**Example:**
```blueprint
@requirement rate-limiting
  API endpoints must implement rate limiting to prevent abuse.
  
  The rate limiter should use a sliding window algorithm to smooth out
  burst traffic while allowing legitimate high-volume users to operate
  normally. Consider using Redis for distributed rate limit state.
  
  Limits should be configurable per-endpoint and per-user-tier:
  
  ```
  Free tier:     100 requests/minute
  Pro tier:      1000 requests/minute
  Enterprise:    10000 requests/minute
  ```
  
  When a limit is exceeded, return HTTP 429 with a `Retry-After` header
  indicating when the client may retry.
  
  @constraint sliding-window
    Must use sliding window algorithm, not fixed window.
  
  @constraint redis-backend
    Rate limit state must be stored in Redis for distributed consistency.
```

### 3.6 Grammar (EBNF)

```ebnf
(* Top-level structure *)
document        = [ description ] { module } ;

description     = "@description" description-text ;

module          = "@module" identifier description-text { module-content } ;
module-content  = feature | requirement | depends-on | constraint ;

feature         = "@feature" identifier description-text { feature-content } ;
feature-content = requirement | depends-on | constraint ;

requirement     = "@requirement" identifier description-text { requirement-content } ;
requirement-content = depends-on | constraint ;

(* Annotations *)
depends-on      = "@depends-on" reference { "," reference } ;
constraint      = "@constraint" identifier description-text ;

(* Primitives *)
reference       = identifier { "." identifier } ;
identifier      = (letter | "_") { letter | digit | "_" | "-" } ;
description-text = { text-line | code-block | comment } ;

(* Lexical *)
letter          = "a".."z" | "A".."Z" ;
digit           = "0".."9" ;
text-line       = (* any characters until newline, excluding keywords at line start *) ;
code-block      = "```" { any-char } "```" ;
comment         = "//" { any-char } newline | "/*" { any-char } "*/" ;
```

---

## 4. Ticket Artifact Specification

### 4.1 Overview

Ticket artifacts are JSON files created and maintained exclusively by the coding agent. They track implementation progress for leaf requirements only. The schema is intentionally minimal to reduce context size and prevent drift.

### 4.2 Design Principles

- **Leaf requirements only**: Tickets exist only for `@requirement` elements, not for modules or features
- **One-to-many mapping**: A single requirement may generate multiple tickets; the agent decides how to decompose work
- **No derived data**: Dependencies, aggregate progress, and blocking status are computed by the LSP/compiler, not stored in tickets
- **Minimal fields**: Only essential information that the agent needs to track and update
- **Identifier-based constraint tracking**: Constraints are tracked by their identifiers, not by duplicating text

### 4.3 File Format

Ticket files use the `.tickets.json` extension and correspond to requirement files by name:

```
requirements/auth.bp  →  .blueprint/tickets/auth.tickets.json
```

### 4.4 Schema

```json
{
  "version": "1.0",
  "source": "requirements/auth.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "authentication.login.basic-auth",
      "description": "Implement email/password login endpoint with bcrypt verification",
      "status": "in-progress",
      "constraints_satisfied": ["bcrypt-cost", "audit-logging"],
      "implementation": {
        "files": ["src/auth/login.ts", "src/routes/auth.ts"],
        "tests": ["tests/auth/login.test.ts"]
      }
    }
  ]
}
```

### 4.5 Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | yes | Schema version (currently "1.0") |
| `source` | string | yes | Path to the source `.bp` file |
| `tickets` | array | yes | Array of ticket objects |

### 4.6 Ticket Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique ticket identifier |
| `ref` | string | yes | Dot-notation path to the source requirement |
| `description` | string | yes | Agent-written description of what this ticket accomplishes |
| `status` | enum | yes | Current implementation status |
| `constraints_satisfied` | array | yes | Array of constraint identifiers that have been satisfied |
| `implementation` | object | no | Files and tests implementing this requirement |

Note: A single requirement may map to multiple tickets. The agent determines how to decompose requirements into tickets and writes the `description` field to explain what each ticket accomplishes.

### 4.7 Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Not yet started |
| `in-progress` | Currently being implemented |
| `complete` | Fully implemented and all constraints satisfied |
| `obsolete` | Requirement was removed (ticket pending cleanup) |

Note: `blocked` status is not stored in tickets. The LSP/compiler determines blocking status dynamically by analyzing dependencies.

### 4.8 Implementation Object

```json
"implementation": {
  "files": [
    "src/auth/login.ts",
    "src/auth/password.ts"
  ],
  "tests": [
    "tests/auth/login.test.ts"
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | array | no | Source files implementing this requirement |
| `tests` | array | no | Test files verifying this requirement |

### 4.9 Constraint Satisfaction

Constraints are tracked by their identifiers. The agent adds a constraint identifier to `constraints_satisfied` when it has implemented code that satisfies that constraint.

**Requirement definition:**
```blueprint
@requirement basic-auth
  ...
  @constraint bcrypt-cost
    Use bcrypt with cost factor >= 12.
  @constraint rate-limit
    Rate limit to 5 attempts per 15 minutes.
  @constraint audit-logging
    Log all login attempts.
```

**Corresponding tickets (one requirement, multiple tickets):**
```json
{
  "id": "TKT-001",
  "ref": "authentication.login.basic-auth",
  "description": "Implement core login endpoint with password verification",
  "status": "complete",
  "constraints_satisfied": ["bcrypt-cost"],
  "implementation": {
    "files": ["src/auth/login.ts", "src/auth/password.ts"],
    "tests": ["tests/auth/login.test.ts"]
  }
},
{
  "id": "TKT-002",
  "ref": "authentication.login.basic-auth",
  "description": "Add rate limiting to login endpoint",
  "status": "in-progress",
  "constraints_satisfied": [],
  "implementation": {
    "files": ["src/middleware/rate-limit.ts"],
    "tests": []
  }
},
{
  "id": "TKT-003",
  "ref": "authentication.login.basic-auth",
  "description": "Add audit logging for login attempts",
  "status": "complete",
  "constraints_satisfied": ["audit-logging"],
  "implementation": {
    "files": ["src/auth/audit.ts"],
    "tests": ["tests/auth/audit.test.ts"]
  }
}
```

In this example, the agent decomposed one requirement into three tickets. The LSP/compiler aggregates constraint satisfaction across all tickets sharing the same `ref` to display "2/3 constraints satisfied".

### 4.10 Ticket Lifecycle

```
┌─────────┐    ┌───────────┐    ┌──────────┐
│ pending │───►│in-progress│───►│ complete │
└─────────┘    └───────────┘    └──────────┘
                                      │
                                      ▼
                               ┌──────────┐
                               │ obsolete │
                               └──────────┘
                                     ▲
                                     │
                              (requirement removed)
```

The agent transitions tickets through these states:
1. **pending → in-progress**: When the agent begins working on the ticket
2. **in-progress → complete**: When the ticket's work is done and relevant constraints are satisfied
3. **any → obsolete**: When the parent requirement is removed from the `.bp` file

**Requirement completion**: A requirement is considered complete when all of its constraints are satisfied across all associated tickets. The LSP/compiler determines this by aggregating `constraints_satisfied` from all tickets sharing the same `ref`.

---

## 5. LSP Specification

### 5.1 Overview

The Blueprint LSP provides IDE integration for requirement files. It handles all derived computations (dependencies, aggregate progress, blocking status) so that ticket files remain minimal.

### 5.2 LSP Responsibilities

The LSP/compiler is responsible for:

- Parsing `.bp` files and building the requirement hierarchy
- Resolving dependencies and detecting cycles
- Reading `.tickets.json` files and correlating with requirements
- Computing aggregate progress for modules and features
- Determining which requirements are blocked by unmet dependencies
- Providing hover information, diagnostics, and navigation

### 5.3 Syntax Highlighting

The LSP provides semantic tokens for:

| Element | Token Type | Suggested Style |
|---------|------------|-----------------|
| `@description` | `keyword` | Bold, gray |
| `@module` | `keyword` | Bold, blue |
| `@feature` | `keyword` | Bold, cyan |
| `@requirement` | `keyword` | Bold, green |
| `@depends-on` | `keyword` | Italic, orange |
| `@constraint` | `keyword` | Italic, yellow |
| Identifiers | `variable` | Default |
| References | `type` | Underlined |
| Comments | `comment` | Gray, italic |

### 5.4 Progress Highlighting

Requirements are highlighted based on their ticket status (computed by LSP):

| Status | Highlight Style |
|--------|----------------|
| No ticket | Dim/gray background |
| `pending` | No highlight (default) |
| Blocked (computed) | Red underline or background |
| `in-progress` | Yellow/amber background |
| `complete` | Green background or checkmark gutter icon |
| `obsolete` | Strikethrough |

### 5.5 Hover Information

When hovering over a requirement, the LSP computes and displays:

```
┌─────────────────────────────────────────────────────────────────┐
│ @requirement basic-auth                                         │
├─────────────────────────────────────────────────────────────────┤
│ Ticket: TKT-001                                                 │
│ Status: in-progress                                             │
├─────────────────────────────────────────────────────────────────┤
│ Constraints: 2/3 satisfied                                      │
│   ✓ bcrypt-cost                                                 │
│   ✓ audit-logging                                               │
│   ○ rate-limit                                                  │
├─────────────────────────────────────────────────────────────────┤
│ Dependencies: (computed by LSP)                                 │
│   ✓ storage.user-accounts (complete)                            │
│   ◐ authentication.session.create-token (in-progress)           │
├─────────────────────────────────────────────────────────────────┤
│ Files:                                                          │
│   src/auth/login.ts                                             │
└─────────────────────────────────────────────────────────────────┘
```

For modules and features, the LSP computes aggregate progress:

```
┌─────────────────────────────────────────────────────────────────┐
│ @feature login                                                  │
├─────────────────────────────────────────────────────────────────┤
│ Progress: 3/8 requirements complete (computed)                  │
│                                                                 │
│ ████████░░░░░░░░░░░░ 37%                                        │
│                                                                 │
│ Requirements:                                                   │
│   ✓ basic-auth (complete)                                       │
│   ✓ oauth-google (complete)                                     │
│   ✓ oauth-github (complete)                                     │
│   ◐ two-factor (in-progress)                                    │
│   ○ password-reset (pending)                                    │
│   ✗ biometric (blocked - depends on hardware.fingerprint)       │
└─────────────────────────────────────────────────────────────────┘
```

### 5.6 Go-to-Definition

Modifier-click (Alt+click by default, configurable per editor) on elements navigates to related artifacts:

| Target | Navigation Behavior |
|--------|---------------------|
| Requirement identifier | Opens ticket in `.tickets.json` file |
| `@depends-on` reference | Jumps to referenced requirement |
| Constraint identifier | Jumps to constraint definition |
| File path (in ticket hover) | Opens source file |

### 5.7 Find References

Find all places that reference a requirement:

- Other requirements that depend on it
- The ticket that tracks it
- Source files that implement it (via ticket data)

### 5.8 Diagnostics

The LSP reports:

| Severity | Condition |
|----------|-----------|
| Error | Circular dependency detected |
| Error | Reference to non-existent requirement |
| Error | Duplicate identifier in scope |
| Error | Multiple `@description` blocks in one file |
| Error | `@description` after `@module` |
| Warning | Requirement has no ticket |
| Warning | Ticket references removed requirement |
| Warning | Constraint identifier mismatch between `.bp` and ticket |
| Info | Requirement is blocked by pending dependencies |

### 5.9 Configuration

```json
{
  "blueprint.ticketsPath": ".blueprint/tickets",
  "blueprint.highlighting.complete": "#2d5a27",
  "blueprint.highlighting.inProgress": "#8a6d3b",
  "blueprint.highlighting.blocked": "#a94442",
  "blueprint.gotoModifier": "alt",
  "blueprint.showProgressInGutter": true,
  "blueprint.hoverDelay": 300
}
```

---

## 6. Agent Behavior Specification

### 6.1 Requirement Analysis

When the agent processes requirement files, it must:

1. Parse all `.bp` files in the project
2. Extract all `@requirement` elements (leaf nodes only)
3. Generate tickets for new requirements
4. Update tickets for modified requirements
5. Mark tickets obsolete for removed requirements

### 6.2 Change Detection

The agent detects changes by comparing the current `.bp` file with the existing tickets:

1. Parse the `.bp` file to get current requirements
2. Compare requirement refs against existing ticket refs
3. For each requirement:
   - If no ticket exists → create new ticket
   - If ticket exists → check for constraint changes
   - If ticket exists but requirement doesn't → mark obsolete

### 6.3 Ticket Operations

| Change Type | Agent Response |
|-------------|----------------|
| Requirement added | Create new ticket with status `pending` |
| Requirement removed | Set ticket status to `obsolete` |
| Constraint added | No ticket change needed (agent will satisfy it) |
| Constraint removed | Remove from `constraints_satisfied` if present |
| Constraint renamed | Update identifier in `constraints_satisfied` |

### 6.4 Implementation Workflow

When implementing a requirement, the agent:

1. Analyzes the requirement and decides how to decompose it into tickets
2. Creates one or more tickets, writing a `description` for each explaining its purpose
3. Sets ticket status to `in-progress` when starting work
4. Generates code to satisfy constraints
5. Adds constraint identifiers to `constraints_satisfied` as they are implemented
6. Updates `implementation.files` with created/modified files
7. Updates `implementation.tests` with test files
8. Sets ticket status to `complete` when its work is done

The agent has flexibility in how it decomposes requirements. A simple requirement might map to one ticket, while a complex requirement might be split into several tickets for better tracking.

### 6.5 Constraint Verification

Before marking a constraint as satisfied, the agent should verify:

- Code exists that implements the constraint
- The implementation is correct and complete
- Relevant tests pass (if applicable)

The agent adds the constraint identifier to `constraints_satisfied` only after verification.

---

## 7. Examples

### 7.1 Complete Example File

```blueprint
// authentication.bp

@description
  CloudVault Authentication System
  
  This document specifies the authentication and session management
  requirements for CloudVault, a secure enterprise file storage platform.
  Authentication is the security foundation of the system and all
  implementations must undergo security review.

@module authentication
  Handles user identity verification, session management, and access control.

@feature login
  @depends-on storage.user-accounts
  
  Provides mechanisms for users to prove their identity and establish
  authenticated sessions.

  @requirement credentials-login
    Users can authenticate using email and password.
    
    The system accepts a user's email address and password, validates them
    against stored credentials, and issues a session token upon successful
    authentication.
    
    @constraint bcrypt-verification
      Passwords must be verified using bcrypt with cost factor >= 12.
    
    @constraint rate-limiting
      Failed login attempts must be rate-limited to 5 attempts per 15 minutes
      per IP address and per account.
    
    @constraint audit-logging
      Successful and failed login attempts must be logged for security audit,
      including timestamp, IP address, and user agent.
    
    @constraint no-plaintext
      Plaintext passwords must never be logged, stored, or transmitted
      after initial receipt.

  @requirement oauth-login
    @depends-on authentication.login.credentials-login
    
    Users can authenticate using third-party OAuth providers.
    
    Support OAuth 2.0 authentication flow with Google, GitHub, and Microsoft
    as identity providers. Users authenticating via OAuth for the first time
    should have an account automatically created.
    
    @constraint csrf-protection
      OAuth state parameter must be validated to prevent CSRF attacks.
    
    @constraint encrypted-storage
      OAuth tokens must be stored encrypted at rest.

  @requirement two-factor
    @depends-on authentication.login.credentials-login
    
    Users can enable two-factor authentication for additional security.
    
    Support TOTP-based 2FA using authenticator apps. Users must be able to
    generate backup codes during 2FA setup.
    
    @constraint encrypted-secrets
      TOTP secrets must be stored encrypted.
    
    @constraint hashed-backup-codes
      Backup codes must be single-use and stored hashed.
    
    @constraint verification-order
      2FA verification must occur after password verification, never before.

@feature session
  @depends-on authentication.login
  
  Manages authenticated user sessions and their lifecycle.

  @requirement create-token
    Generate secure session tokens upon successful authentication.
    
    Tokens should be JWTs with appropriate claims and expiration.
    
    @constraint rs256-signing
      Tokens must be signed using RS256 with rotating keys.
    
    @constraint configurable-expiration
      Token expiration must be configurable, defaulting to 24 hours.

  @requirement refresh-token
    @depends-on authentication.session.create-token
    
    Allow sessions to be extended without re-authentication.
    
    Refresh tokens should be long-lived but revocable, and should rotate
    on each use.
    
    @constraint atomic-rotation
      Refresh token rotation must be atomic to prevent race conditions.
    
    @constraint family-invalidation
      Using a refresh token must invalidate all previous refresh tokens
      in that token family.

  @requirement logout
    @depends-on authentication.session.create-token
    
    Users can terminate their authenticated session.
    
    Logout must invalidate all session tokens and refresh tokens associated
    with the session.
    
    @constraint fast-propagation
      Token invalidation must propagate to all application instances
      within 1 second.
```

### 7.2 Corresponding Ticket File

```json
{
  "version": "1.0",
  "source": "requirements/authentication.bp",
  "tickets": [
    {
      "id": "TKT-001",
      "ref": "authentication.login.credentials-login",
      "description": "Implement core email/password authentication endpoint",
      "status": "complete",
      "constraints_satisfied": [
        "bcrypt-verification",
        "no-plaintext"
      ],
      "implementation": {
        "files": [
          "src/auth/login.ts",
          "src/auth/password.ts"
        ],
        "tests": [
          "tests/auth/login.test.ts",
          "tests/auth/password.test.ts"
        ]
      }
    },
    {
      "id": "TKT-002",
      "ref": "authentication.login.credentials-login",
      "description": "Add rate limiting for login attempts",
      "status": "complete",
      "constraints_satisfied": [
        "rate-limiting"
      ],
      "implementation": {
        "files": [
          "src/middleware/rate-limit.ts"
        ],
        "tests": [
          "tests/middleware/rate-limit.test.ts"
        ]
      }
    },
    {
      "id": "TKT-003",
      "ref": "authentication.login.credentials-login",
      "description": "Add security audit logging for login events",
      "status": "complete",
      "constraints_satisfied": [
        "audit-logging"
      ],
      "implementation": {
        "files": [
          "src/auth/audit.ts"
        ],
        "tests": [
          "tests/auth/audit.test.ts"
        ]
      }
    },
    {
      "id": "TKT-004",
      "ref": "authentication.login.oauth-login",
      "description": "Implement OAuth 2.0 flow for Google, GitHub, and Microsoft",
      "status": "in-progress",
      "constraints_satisfied": [
        "csrf-protection"
      ],
      "implementation": {
        "files": [
          "src/auth/oauth.ts"
        ],
        "tests": []
      }
    },
    {
      "id": "TKT-005",
      "ref": "authentication.login.oauth-login",
      "description": "Add encrypted storage for OAuth tokens",
      "status": "pending",
      "constraints_satisfied": [],
      "implementation": {}
    },
    {
      "id": "TKT-006",
      "ref": "authentication.login.two-factor",
      "description": "Implement TOTP-based two-factor authentication",
      "status": "pending",
      "constraints_satisfied": [],
      "implementation": {}
    },
    {
      "id": "TKT-007",
      "ref": "authentication.session.create-token",
      "description": "Implement JWT token generation with RS256 signing",
      "status": "complete",
      "constraints_satisfied": [
        "rs256-signing",
        "configurable-expiration"
      ],
      "implementation": {
        "files": [
          "src/auth/token.ts",
          "src/auth/keys.ts"
        ],
        "tests": [
          "tests/auth/token.test.ts"
        ]
      }
    },
    {
      "id": "TKT-008",
      "ref": "authentication.session.refresh-token",
      "description": "Implement refresh token rotation mechanism",
      "status": "pending",
      "constraints_satisfied": [],
      "implementation": {}
    },
    {
      "id": "TKT-009",
      "ref": "authentication.session.logout",
      "description": "Implement session termination with token invalidation",
      "status": "pending",
      "constraints_satisfied": [],
      "implementation": {}
    }
  ]
}
```

### 7.3 Cross-File Dependencies

**storage.bp:**
```blueprint
@description
  CloudVault Storage Layer
  
  Database and persistence requirements for the CloudVault platform.

@module storage

@feature user-accounts
  User account storage and retrieval.
  
  @requirement user-table
    Database schema for user accounts.
    
    @constraint unique-email
      Email addresses must be unique and indexed.
    
    @constraint soft-delete
      User records must support soft deletion for audit purposes.
```

**authentication.bp:**
```blueprint
@description
  CloudVault Authentication System

@module authentication

@feature login
  @depends-on storage.user-accounts
  
  // This feature depends on the user-accounts feature in storage module
  // The LSP will resolve this and show blocking status if storage is incomplete
```

---

## 8. Appendix

### 8.1 File Extension Associations

| Extension | Purpose |
|-----------|---------|
| `.bp` | Requirement specification files (human-owned) |
| `.tickets.json` | Ticket tracking artifacts (agent-owned) |

### 8.2 Reserved Keywords

The following tokens are reserved and cannot be used as identifiers:

```
@description
@module
@feature
@requirement
@depends-on
@constraint
```

### 8.3 LSP Message Types

| Method | Direction | Purpose |
|--------|-----------|---------|
| `textDocument/didOpen` | Client → Server | Parse and index opened .bp file |
| `textDocument/didChange` | Client → Server | Re-parse on edit |
| `textDocument/hover` | Client → Server | Get computed ticket info for position |
| `textDocument/definition` | Client → Server | Navigate to ticket/dependency |
| `textDocument/references` | Client → Server | Find all references to requirement |
| `textDocument/publishDiagnostics` | Server → Client | Report errors/warnings |
| `textDocument/semanticTokens` | Client → Server | Get syntax highlighting tokens |

### 8.4 Editor Keybinding Defaults

| Editor | Go-to-Ticket Modifier |
|--------|----------------------|
| VS Code | Alt + Click |
| JetBrains IDEs | Alt + Click |
| Neovim | gd (go to definition) |
| Emacs | M-. (xref-find-definitions) |
| Sublime Text | Alt + Click |

### 8.5 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-01-11 | Initial specification |
