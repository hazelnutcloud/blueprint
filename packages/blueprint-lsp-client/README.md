# Blueprint VS Code Extension

VS Code language extension for Blueprint DSL - a human-authored requirements language for coding agents.

## Features

The Blueprint extension provides:

- **Syntax highlighting** with status-based coloring for requirements
- **Hover information** showing ticket status, constraint satisfaction, and dependencies
- **Go-to-definition** for navigating between requirements and tickets
- **Find references** to see all dependencies on a requirement
- **Diagnostics** for syntax errors, circular dependencies, and missing tickets
- **Code actions** for creating tickets and fixing typos in references
- **Gutter icons** showing requirement completion status
- **Progress highlighting** with customizable colors

## Installation

### From Source

1. Build the extension:

```bash
bun run compile
```

2. Run in VS Code's Extension Development Host:
   - Open the project root in VS Code
   - Press `F5` to launch the Extension Development Host
   - Open any `.bp` file to activate the extension

### Package as VSIX

```bash
bun run package
```

This creates a `.vsix` file that can be installed in VS Code via "Install from VSIX...".

## Configuration

Configure these settings in VS Code (File > Preferences > Settings) or in your workspace's `.vscode/settings.json`.

### General Settings

| Setting                  | Type     | Default              | Description                                                                                                                                           |
| ------------------------ | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blueprint.ticketsPath`  | `string` | `.blueprint/tickets` | Path to the tickets directory relative to the workspace root. The LSP server looks for `.tickets.json` files in this directory.                       |
| `blueprint.hoverDelay`   | `number` | `300`                | Delay in milliseconds before showing hover information. Range: 0-10000ms.                                                                             |
| `blueprint.gotoModifier` | `string` | `alt`                | Modifier key for go-to-definition. When set to `alt`, use Alt+Click (Ctrl/Cmd+Click adds cursors). When set to `ctrlCmd`, use Ctrl/Cmd+Click instead. |

### Progress Visualization

| Setting                              | Type      | Default | Description                                                                                                   |
| ------------------------------------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `blueprint.showProgressInGutter`     | `boolean` | `true`  | Show status icons in the editor gutter. Icons: ✓ complete, ◐ in-progress, ✗ blocked, ○ no-ticket, − obsolete. |
| `blueprint.showProgressHighlighting` | `boolean` | `true`  | Highlight requirement lines with background colors based on their status (see highlighting colors below).     |

### Highlighting Colors

Configure the colors used for requirement status highlighting. Colors should be specified as hex color codes.

| Setting                             | Type     | Default   | Description                                                 |
| ----------------------------------- | -------- | --------- | ----------------------------------------------------------- |
| `blueprint.highlighting.complete`   | `string` | `#2d5a27` | Color for completed requirements (green).                   |
| `blueprint.highlighting.inProgress` | `string` | `#8a6d3b` | Color for requirements currently being implemented (amber). |
| `blueprint.highlighting.blocked`    | `string` | `#a94442` | Color for requirements blocked by incomplete dependencies.  |
| `blueprint.highlighting.noTicket`   | `string` | `#6c757d` | Color for requirements without any associated tickets.      |
| `blueprint.highlighting.obsolete`   | `string` | `#868e96` | Color for obsolete requirements (gray with strikethrough).  |

### Debugging

| Setting                  | Type     | Default | Description                                                                                         |
| ------------------------ | -------- | ------- | --------------------------------------------------------------------------------------------------- |
| `blueprint.trace.server` | `string` | `off`   | Traces communication between VS Code and the language server. Values: `off`, `messages`, `verbose`. |

### Example Configuration

```json
{
  "blueprint.ticketsPath": ".blueprint/tickets",
  "blueprint.showProgressInGutter": true,
  "blueprint.showProgressHighlighting": true,
  "blueprint.gotoModifier": "alt",
  "blueprint.hoverDelay": 300,
  "blueprint.highlighting.complete": "#2d5a27",
  "blueprint.highlighting.inProgress": "#8a6d3b",
  "blueprint.highlighting.blocked": "#a94442",
  "blueprint.highlighting.noTicket": "#6c757d",
  "blueprint.highlighting.obsolete": "#868e96",
  "blueprint.trace.server": "off"
}
```

## Keyboard Shortcuts

| Action            | Default Shortcut     | Description                                    |
| ----------------- | -------------------- | ---------------------------------------------- |
| Go to Definition  | `Alt+Click` or `F12` | Navigate to ticket or referenced requirement   |
| Find References   | `Shift+F12`          | Find all dependencies on a requirement         |
| Hover             | Mouse hover          | Show ticket status and constraint satisfaction |
| Quick Fix         | `Ctrl+.` / `Cmd+.`   | Show code actions (create ticket, fix typo)    |
| Document Symbols  | `Ctrl+Shift+O`       | Browse modules, features, requirements         |
| Workspace Symbols | `Ctrl+T`             | Search across all `.bp` files                  |

## Development

### Build

```bash
bun run compile
```

### Watch Mode

```bash
bun run watch
```

### Run Tests

```bash
bun run test
```

### Lint

```bash
bun run lint
```

## Dependencies

This extension requires the `blueprint-lsp-server` package to be built. The server is bundled with the extension.
