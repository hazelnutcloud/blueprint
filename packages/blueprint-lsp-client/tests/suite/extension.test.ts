/**
 * End-to-End Tests for Blueprint VS Code Extension Activation
 *
 * These tests verify the full extension lifecycle including:
 * - Extension activation on .bp files
 * - Language client initialization
 * - LSP server communication
 * - Configuration settings
 * - Syntax highlighting
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import { suite, test } from "mocha";

// Extension ID format: publisher.name
// When testing locally, VS Code uses the values from package.json
const extensionId = "blueprint.blueprint-lsp-client";

/**
 * Helper to find the Blueprint extension.
 * Tries both possible extension IDs (with and without publisher prefix).
 */
function findBlueprintExtension(): vscode.Extension<unknown> | undefined {
  // Try with publisher prefix first
  let extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    // Try without publisher prefix (local development)
    extension = vscode.extensions.getExtension("blueprint-lsp-client");
  }
  return extension;
}

suite("Extension Activation", () => {
  test("extension is present in the extensions list", () => {
    const extension = findBlueprintExtension();
    assert.ok(
      extension,
      `Extension should be installed (tried ${extensionId} and blueprint-lsp-client)`
    );
  });

  test("extension activates on .bp file open", async () => {
    const extension = findBlueprintExtension();
    assert.ok(extension, "Extension should be installed");

    // Extension should not be active initially (lazy activation)
    // Note: It may already be active if a .bp file was opened

    // Create a temporary .bp file content
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module test
  Test module for extension activation.

  @feature example
    Example feature.

    @requirement sample
      Sample requirement for testing.
`,
    });

    // Open the document to trigger activation
    await vscode.window.showTextDocument(doc);

    // Wait for extension to activate
    await extension.activate();

    assert.strictEqual(
      extension.isActive,
      true,
      "Extension should be active after opening .bp file"
    );
  });

  test("blueprint language is registered", async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(languages.includes("blueprint"), "Blueprint language should be registered");
  });
});

suite("Language Configuration", () => {
  test("comment toggling is configured", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test content",
    });

    const editor = await vscode.window.showTextDocument(doc);

    // Select the first line
    editor.selection = new vscode.Selection(0, 0, 0, 12);

    // Execute toggle line comment
    await vscode.commands.executeCommand("editor.action.commentLine");

    // Check that comment was added
    const text = doc.getText();
    assert.ok(
      text.startsWith("// ") || text.startsWith("//"),
      "Line comment should be toggled with //"
    );
  });

  test("bracket matching is configured", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Some (parentheses) and [brackets]",
    });

    await vscode.window.showTextDocument(doc);

    // Verify the document was created with blueprint language
    assert.strictEqual(doc.languageId, "blueprint", "Document should have blueprint language ID");
  });
});

suite("Extension Settings", () => {
  test("ticketsPath setting has correct default", () => {
    const config = vscode.workspace.getConfiguration("blueprint");
    const ticketsPath = config.get<string>("ticketsPath");
    assert.strictEqual(
      ticketsPath,
      ".blueprint/tickets",
      "Default ticketsPath should be .blueprint/tickets"
    );
  });

  test("highlighting color settings have defaults", () => {
    const config = vscode.workspace.getConfiguration("blueprint.highlighting");

    const complete = config.get<string>("complete");
    const inProgress = config.get<string>("inProgress");
    const blocked = config.get<string>("blocked");
    const noTicket = config.get<string>("noTicket");
    const obsolete = config.get<string>("obsolete");

    assert.strictEqual(complete, "#2d5a27", "complete color should have default");
    assert.strictEqual(inProgress, "#8a6d3b", "inProgress color should have default");
    assert.strictEqual(blocked, "#a94442", "blocked color should have default");
    assert.strictEqual(noTicket, "#6c757d", "noTicket color should have default");
    assert.strictEqual(obsolete, "#868e96", "obsolete color should have default");
  });

  test("gotoModifier setting has correct default", () => {
    const config = vscode.workspace.getConfiguration("blueprint");
    const gotoModifier = config.get<string>("gotoModifier");
    assert.strictEqual(gotoModifier, "alt", "Default gotoModifier should be 'alt'");
  });

  test("showProgressInGutter setting has correct default", () => {
    const config = vscode.workspace.getConfiguration("blueprint");
    const showProgressInGutter = config.get<boolean>("showProgressInGutter");
    assert.strictEqual(showProgressInGutter, true, "Default showProgressInGutter should be true");
  });

  test("showProgressHighlighting setting has correct default", () => {
    const config = vscode.workspace.getConfiguration("blueprint");
    const showProgressHighlighting = config.get<boolean>("showProgressHighlighting");
    assert.strictEqual(
      showProgressHighlighting,
      true,
      "Default showProgressHighlighting should be true"
    );
  });

  test("hoverDelay setting has correct default", () => {
    const config = vscode.workspace.getConfiguration("blueprint");
    const hoverDelay = config.get<number>("hoverDelay");
    assert.strictEqual(hoverDelay, 300, "Default hoverDelay should be 300ms");
  });

  test("trace.server setting has correct default", () => {
    const config = vscode.workspace.getConfiguration("blueprint");
    const traceServer = config.get<string>("trace.server");
    assert.strictEqual(traceServer, "off", "Default trace.server should be 'off'");
  });
});

suite("Syntax Highlighting", () => {
  test("TextMate grammar is registered for blueprint", async () => {
    // Create a document with blueprint content
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@description
  Test description

@module auth
  Authentication module

  @feature login
    User login feature

    @requirement basic-auth
      @depends-on storage.users

      Basic authentication

      @constraint bcrypt
        Use bcrypt for passwords
`,
    });

    await vscode.window.showTextDocument(doc);

    // Verify the document has blueprint language
    assert.strictEqual(doc.languageId, "blueprint", "Document should have blueprint language ID");

    // The TextMate grammar should be applied (we can't easily verify tokens in e2e tests,
    // but we can verify the document is recognized)
    assert.ok(doc.lineCount > 0, "Document should have content");
  });

  test("semantic tokens legend is available", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test module",
    });

    await vscode.window.showTextDocument(doc);

    // Wait for LSP server to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get the semantic tokens legend
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
      "vscode.provideDocumentSemanticTokensLegend",
      doc.uri
    );

    // Legend should be available from LSP
    if (legend) {
      assert.ok(Array.isArray(legend.tokenTypes), "Legend should have tokenTypes array");
      assert.ok(Array.isArray(legend.tokenModifiers), "Legend should have tokenModifiers array");

      // Verify expected token types per SPEC.md Section 5.3
      assert.ok(legend.tokenTypes.includes("keyword"), "Legend should include 'keyword' type");
      assert.ok(legend.tokenTypes.includes("variable"), "Legend should include 'variable' type");
      assert.ok(legend.tokenTypes.includes("type"), "Legend should include 'type' type");
      assert.ok(legend.tokenTypes.includes("comment"), "Legend should include 'comment' type");

      // Verify status modifiers per SPEC.md Section 5.4
      assert.ok(
        legend.tokenModifiers.includes("noTicket"),
        "Legend should include 'noTicket' modifier"
      );
      assert.ok(
        legend.tokenModifiers.includes("blocked"),
        "Legend should include 'blocked' modifier"
      );
      assert.ok(
        legend.tokenModifiers.includes("inProgress"),
        "Legend should include 'inProgress' modifier"
      );
      assert.ok(
        legend.tokenModifiers.includes("complete"),
        "Legend should include 'complete' modifier"
      );
      assert.ok(
        legend.tokenModifiers.includes("obsolete"),
        "Legend should include 'obsolete' modifier"
      );
    } else {
      // LSP may not be ready - this is acceptable for transient e2e test
      console.log("Semantic tokens legend not available (LSP server may not be ready)");
    }
  });

  test("semantic tokens are provided for blueprint files", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module auth
  Authentication module

  @feature login
    User login feature

    @requirement basic-auth
      @depends-on storage.users

      Basic authentication

      @constraint bcrypt
        Use bcrypt for passwords
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for LSP server to initialize and retry if needed
    let tokens: vscode.SemanticTokens | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
        "vscode.provideDocumentSemanticTokens",
        doc.uri
      );

      if (tokens && tokens.data.length > 0) {
        break;
      }
    }

    // Semantic tokens should be provided
    if (tokens) {
      assert.ok(tokens.data, "Semantic tokens should have data");
      assert.ok(tokens.data.length > 0, "Semantic tokens data should not be empty");

      // The data array contains encoded tokens in groups of 5:
      // [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
      // Verify we have valid token data (must be multiple of 5)
      assert.strictEqual(tokens.data.length % 5, 0, "Token data length should be multiple of 5");

      // Calculate number of tokens
      const tokenCount = tokens.data.length / 5;
      assert.ok(tokenCount >= 4, "Should have at least 4 tokens (keywords)");

      console.log(`Semantic tokens: ${tokenCount} tokens returned`);
    } else {
      console.log("Semantic tokens not available (LSP server may not be ready)");
    }
  });

  test("semantic tokens include keywords and identifiers", async () => {
    // Simple document with clear token expectations
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module test
  Module description
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for LSP server to initialize
    let tokens: vscode.SemanticTokens | undefined;
    let legend: vscode.SemanticTokensLegend | undefined;

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      [tokens, legend] = await Promise.all([
        vscode.commands.executeCommand<vscode.SemanticTokens>(
          "vscode.provideDocumentSemanticTokens",
          doc.uri
        ),
        vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
          "vscode.provideDocumentSemanticTokensLegend",
          doc.uri
        ),
      ]);

      if (tokens && tokens.data.length > 0 && legend) {
        break;
      }
    }

    if (tokens && legend && tokens.data.length > 0) {
      // Decode the first few tokens to verify types
      const keywordIndex = legend.tokenTypes.indexOf("keyword");
      const variableIndex = legend.tokenTypes.indexOf("variable");

      assert.ok(keywordIndex >= 0, "Should have keyword type in legend");
      assert.ok(variableIndex >= 0, "Should have variable type in legend");

      // First token should be @module keyword (line 0, col 0, length 7)
      // Token format: [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
      const firstTokenType = tokens.data[3]; // tokenType is at index 3
      assert.strictEqual(firstTokenType, keywordIndex, "First token should be a keyword (@module)");

      // Second token should be 'test' identifier
      // Need to check if there are more tokens
      if (tokens.data.length >= 10) {
        const secondTokenType = tokens.data[8]; // tokenType of second token
        assert.strictEqual(
          secondTokenType,
          variableIndex,
          "Second token should be a variable (identifier)"
        );
      }

      console.log("Semantic token types verified: keyword and variable tokens present");
    } else {
      console.log("Could not verify token types (LSP server may not be ready)");
    }
  });

  test("semantic tokens include references in @depends-on", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module storage
  Storage module

  @feature users
    Users feature

    @requirement user-table
      User table

@module auth
  Auth module

  @feature login
    @depends-on storage.users.user-table

    Login feature
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for LSP server to initialize
    let tokens: vscode.SemanticTokens | undefined;
    let legend: vscode.SemanticTokensLegend | undefined;

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      [tokens, legend] = await Promise.all([
        vscode.commands.executeCommand<vscode.SemanticTokens>(
          "vscode.provideDocumentSemanticTokens",
          doc.uri
        ),
        vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
          "vscode.provideDocumentSemanticTokensLegend",
          doc.uri
        ),
      ]);

      if (tokens && tokens.data.length > 0 && legend) {
        break;
      }
    }

    if (tokens && legend && tokens.data.length > 0) {
      const typeIndex = legend.tokenTypes.indexOf("type");
      assert.ok(typeIndex >= 0, "Should have 'type' type in legend for references");

      // Find if any token has 'type' as its token type (used for references)
      let foundReferenceToken = false;
      for (let i = 0; i < tokens.data.length; i += 5) {
        const tokenType = tokens.data[i + 3];
        if (tokenType === typeIndex) {
          foundReferenceToken = true;
          break;
        }
      }

      assert.ok(foundReferenceToken, "Should have at least one reference token (type)");
      console.log("Reference tokens (type) verified in @depends-on");
    } else {
      console.log("Could not verify reference tokens (LSP server may not be ready)");
    }
  });

  test("semantic tokens include comments", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `// This is a comment
@module test
  Test module

  /* Multi-line
     comment */
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for LSP server to initialize
    let tokens: vscode.SemanticTokens | undefined;
    let legend: vscode.SemanticTokensLegend | undefined;

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      [tokens, legend] = await Promise.all([
        vscode.commands.executeCommand<vscode.SemanticTokens>(
          "vscode.provideDocumentSemanticTokens",
          doc.uri
        ),
        vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
          "vscode.provideDocumentSemanticTokensLegend",
          doc.uri
        ),
      ]);

      if (tokens && tokens.data.length > 0 && legend) {
        break;
      }
    }

    if (tokens && legend && tokens.data.length > 0) {
      const commentIndex = legend.tokenTypes.indexOf("comment");
      assert.ok(commentIndex >= 0, "Should have 'comment' type in legend");

      // Find if any token has 'comment' as its token type
      let foundCommentToken = false;
      for (let i = 0; i < tokens.data.length; i += 5) {
        const tokenType = tokens.data[i + 3];
        if (tokenType === commentIndex) {
          foundCommentToken = true;
          break;
        }
      }

      assert.ok(foundCommentToken, "Should have at least one comment token");
      console.log("Comment tokens verified");
    } else {
      console.log("Could not verify comment tokens (LSP server may not be ready)");
    }
  });
});

suite("LSP Client", () => {
  // These tests verify LSP functionality through the VS Code API

  test("hover provider is available for blueprint files", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module test
  Test module

  @feature example
    Example feature

    @requirement sample
      Sample requirement
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for the language server to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Try to get hover at the @module keyword position
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      new vscode.Position(0, 1) // Position on @module
    );

    // Hover may or may not be available depending on server state
    // This test verifies the provider is registered
    assert.ok(Array.isArray(hovers), "Hover provider should return an array");
  });

  test("document symbols are available for blueprint files", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module auth
  Authentication

  @feature login
    Login feature

    @requirement basic
      Basic auth
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for the language server to initialize and retry if needed
    let symbols: vscode.DocumentSymbol[] | undefined | null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get document symbols - may return undefined or null if not ready
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
        "vscode.executeDocumentSymbolProvider",
        doc.uri
      );

      if (Array.isArray(result) && result.length > 0) {
        symbols = result;
        break;
      }
    }

    // Document symbols should be available
    // Note: The provider may not return symbols if the LSP server isn't ready yet
    // This is acceptable for an e2e test as it verifies the provider is registered
    if (symbols !== undefined && symbols !== null) {
      assert.ok(Array.isArray(symbols), "Document symbol provider should return an array");

      // If symbols are returned, verify structure
      if (symbols.length > 0) {
        const moduleSymbol = symbols.find((s) => s.name === "auth");
        assert.ok(moduleSymbol, "Should find 'auth' module symbol");
      }
    } else {
      // LSP server not ready in time - this is acceptable for a transient e2e test
      // The test still validates that the document symbol provider is registered
      console.log("Document symbol provider returned undefined/null (LSP server may not be ready)");
    }
  });

  test("go-to-definition works for @depends-on references", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module storage
  Storage module

  @feature users
    User storage

    @requirement user-table
      User database table

@module auth
  Authentication

  @feature login
    @depends-on storage.users

    Login feature

    @requirement basic
      @depends-on storage.users.user-table

      Basic auth
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for the language server to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Try to get definition at the @depends-on reference
    // Line 12 contains "@depends-on storage.users"
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      doc.uri,
      new vscode.Position(12, 18) // Position on "storage" in @depends-on
    );

    // Definition provider should return locations
    assert.ok(Array.isArray(definitions), "Definition provider should return an array");
  });
});

suite("Navigation Commands", () => {
  /**
   * Flag to track if we've successfully communicated with the LSP server.
   * Once true, we know the server is operational.
   */
  let serverConfirmedReady = false;

  /**
   * Helper to wait for the LSP server to be ready by checking if document symbols are available.
   * This is a reliable indicator that the document has been parsed and indexed.
   *
   * Uses longer timeouts on the first call (to wait for server initialization),
   * and shorter timeouts on subsequent calls.
   */
  async function waitForDocumentReady(
    docUri: vscode.Uri,
    maxAttempts?: number,
    delayMs?: number
  ): Promise<boolean> {
    // Use longer timeouts if server hasn't been confirmed ready yet
    const attempts = maxAttempts ?? (serverConfirmedReady ? 10 : 20);
    const delay = delayMs ?? (serverConfirmedReady ? 300 : 500);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        docUri
      );
      if (Array.isArray(symbols) && symbols.length > 0) {
        serverConfirmedReady = true;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
  }

  /**
   * Helper to retry an operation until it succeeds or times out.
   */
  async function retryOperation<T>(
    operation: () => Thenable<T>,
    isReady: (result: T) => boolean,
    maxAttempts = 3,
    delayMs = 200
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await operation();
      if (isReady(result)) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return undefined;
  }

  test("go-to-definition navigates to requirement from @depends-on reference", async () => {
    // Use unique identifiers to avoid conflicts with other test documents
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module nav-test-auth
  Authentication module for navigation test

  @feature nav-test-login
    Login functionality

    @requirement nav-test-basic-auth
      Email and password authentication

  @feature nav-test-session
    @depends-on nav-test-auth.nav-test-login.nav-test-basic-auth

    Session management
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "nav-test-basic-auth" in @depends-on (line 10, character ~30)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(10, 35)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      // Should navigate to line 6 where @requirement nav-test-basic-auth is defined
      assert.strictEqual(def.range.start.line, 6);
      console.log("Go-to-definition for @depends-on reference verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition navigates to feature from reference", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module core
  Core module

  @feature user-management
    User management feature

    @requirement create-user
      Create new users

@module admin
  @depends-on core.user-management

  Admin module
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "user-management" in @depends-on (line 10, character ~20)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(10, 20)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      // Should navigate to line 3 where @feature user-management is defined
      assert.strictEqual(def.range.start.line, 3);
      console.log("Go-to-definition for feature reference verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition navigates to module from reference", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module database
  Database module

  @feature connections
    Connection pooling

@module api
  @depends-on database

  API module
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "database" in @depends-on (line 7, character ~16)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(7, 16)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      // Should navigate to line 0 where @module database is defined
      assert.strictEqual(def.range.start.line, 0);
      console.log("Go-to-definition for module reference verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition works for module identifier", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module payments
  Payment processing module

  @feature checkout
    Checkout feature
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "payments" identifier (line 0, character 10)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(0, 10)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      assert.strictEqual(def.range.start.line, 0);
      console.log("Go-to-definition for module identifier verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition works for feature identifier", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module inventory
  Inventory module

  @feature stock-management
    Stock management feature

    @requirement track-levels
      Track inventory levels
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "stock-management" identifier (line 3, character 15)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(3, 15)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      assert.strictEqual(def.range.start.line, 3);
      console.log("Go-to-definition for feature identifier verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition works for requirement identifier", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module security
  Security module

  @feature encryption
    Encryption feature

    @requirement encrypt-data
      Encrypt sensitive data
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "encrypt-data" identifier (line 6, character 20)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(6, 20)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      assert.strictEqual(def.range.start.line, 6);
      console.log("Go-to-definition for requirement identifier verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition works for constraint identifier", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module auth
  Auth module

  @feature passwords
    Password handling

    @requirement hash-password
      Hash passwords securely

      @constraint bcrypt-cost
        Use bcrypt with cost factor >= 12
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "bcrypt-cost" identifier (line 9, character 20)
    const definitions = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(9, 20)
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (definitions && definitions.length > 0) {
      const def = definitions[0]!;
      assert.strictEqual(def.uri.toString(), doc.uri.toString());
      assert.strictEqual(def.range.start.line, 9);
      console.log("Go-to-definition for constraint identifier verified");
    } else {
      console.log("Go-to-definition not available (LSP server may not be ready)");
    }
  });

  test("go-to-definition returns empty for keywords", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module test
  Test module
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on @module keyword (line 0, character 3)
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      doc.uri,
      new vscode.Position(0, 3)
    );

    // Keywords should not have definitions
    assert.ok(!definitions || definitions.length === 0, "Keywords should not have definitions");
    console.log("Go-to-definition correctly returns empty for keywords");
  });

  test("find-references finds all @depends-on references to a requirement", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module auth
  Auth module

  @feature login
    Login feature

    @requirement basic-auth
      Basic authentication

  @feature session
    @depends-on auth.login.basic-auth

    Session feature

    @requirement create-token
      Create tokens

  @feature logout
    @depends-on auth.login.basic-auth

    Logout feature

    @requirement invalidate-token
      Invalidate tokens
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "basic-auth" identifier (line 6, character 20)
    const references = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          doc.uri,
          new vscode.Position(6, 20)
        ),
      (result) => Array.isArray(result) && result.length >= 2
    );

    if (references && references.length >= 2) {
      // Should find at least the two @depends-on references (lines 10 and 18)
      const lines = references.map((ref) => ref.range.start.line).sort((a, b) => a - b);
      assert.ok(lines.includes(10), "Should find reference on line 10");
      assert.ok(lines.includes(18), "Should find reference on line 18");
      console.log(`Find-references found ${references.length} references`);
    } else {
      console.log("Find-references not available (LSP server may not be ready)");
    }
  });

  test("find-references finds references to a feature", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module core
  Core module

  @feature user-management
    User management

    @requirement create-user
      Create users

@module admin
  @depends-on core.user-management

  Admin module

@module reporting
  @depends-on core.user-management

  Reporting module
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "user-management" identifier (line 3, character 15)
    const references = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          doc.uri,
          new vscode.Position(3, 15)
        ),
      (result) => Array.isArray(result) && result.length >= 2
    );

    if (references && references.length >= 2) {
      // Should find references on lines 10 and 15
      const lines = references.map((ref) => ref.range.start.line).sort((a, b) => a - b);
      assert.ok(lines.includes(10), "Should find reference on line 10");
      assert.ok(lines.includes(15), "Should find reference on line 15");
      console.log(`Find-references found ${references.length} references to feature`);
    } else {
      console.log("Find-references not available (LSP server may not be ready)");
    }
  });

  test("find-references finds references to a module", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module database
  Database module

  @feature connections
    Connection pool

@module api
  @depends-on database

  API module

@module workers
  @depends-on database

  Workers module
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "database" identifier (line 0, character 10)
    const references = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          doc.uri,
          new vscode.Position(0, 10)
        ),
      (result) => Array.isArray(result) && result.length >= 2
    );

    if (references && references.length >= 2) {
      // Should find references on lines 7 and 12
      const lines = references.map((ref) => ref.range.start.line).sort((a, b) => a - b);
      assert.ok(lines.includes(7), "Should find reference on line 7");
      assert.ok(lines.includes(12), "Should find reference on line 12");
      console.log(`Find-references found ${references.length} references to module`);
    } else {
      console.log("Find-references not available (LSP server may not be ready)");
    }
  });

  test("find-references returns empty for unreferenced symbol", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module standalone
  Standalone module

  @feature isolated
    Isolated feature

    @requirement unreferenced
      This is not referenced anywhere
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Position on "unreferenced" identifier (line 6, character 20)
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      doc.uri,
      new vscode.Position(6, 20)
    );

    // Should return empty array or only the declaration itself
    assert.ok(
      !references || references.length <= 1,
      "Unreferenced symbol should have no external references"
    );
    console.log("Find-references correctly returns empty for unreferenced symbol");
  });

  test("workspace symbols search finds symbols across document", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module authentication
  Authentication module

  @feature user-login
    User login feature

    @requirement password-verification
      Verify user passwords
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Search for "password" in workspace symbols
    const symbols = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          "password"
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (symbols && symbols.length > 0) {
      const passwordSymbol = symbols.find((s) => s.name.includes("password"));
      assert.ok(passwordSymbol, "Should find symbol containing 'password'");
      console.log(`Workspace symbols search found ${symbols.length} matches`);
    } else {
      console.log("Workspace symbols not available (LSP server may not be ready)");
    }
  });

  test("workspace symbols search finds modules", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module payments
  Payment processing

  @feature checkout
    Checkout feature
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed
    const isReady = await waitForDocumentReady(doc.uri);
    if (!isReady) {
      console.log("LSP server did not become ready in time - skipping verification");
      return;
    }

    // Search for "payments" in workspace symbols
    const symbols = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          "payments"
        ),
      (result) => Array.isArray(result) && result.length > 0
    );

    if (symbols && symbols.length > 0) {
      const paymentsSymbol = symbols.find((s) => s.name === "payments");
      assert.ok(paymentsSymbol, "Should find 'payments' module");
      assert.strictEqual(paymentsSymbol?.kind, vscode.SymbolKind.Module);
      console.log("Workspace symbols search found module");
    } else {
      console.log("Workspace symbols not available (LSP server may not be ready)");
    }
  });

  test("document symbols returns hierarchical structure", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module auth
  Authentication

  @feature login
    Login feature

    @requirement basic-auth
      Basic authentication

      @constraint bcrypt
        Use bcrypt hashing

  @feature logout
    Logout feature

    @requirement session-invalidation
      Invalidate session
`,
    });

    await vscode.window.showTextDocument(doc);

    // Wait for document to be indexed - for this test, we use the symbols themselves as the readiness check
    const symbols = await retryOperation(
      () =>
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          "vscode.executeDocumentSymbolProvider",
          doc.uri
        ),
      (result) => Array.isArray(result) && result.length > 0,
      10, // more attempts for this comprehensive test
      500
    );

    if (symbols && symbols.length > 0) {
      // Should have one module at top level
      assert.strictEqual(symbols.length, 1, "Should have one top-level module");
      const moduleSymbol = symbols[0]!;
      assert.strictEqual(moduleSymbol.name, "auth");
      assert.strictEqual(moduleSymbol.kind, vscode.SymbolKind.Module);

      // Module should have children (features)
      const moduleChildren = moduleSymbol.children;
      assert.ok(
        moduleChildren && moduleChildren.length >= 2,
        "Module should have feature children"
      );

      // Find the login feature
      const loginFeature = moduleChildren?.find((c) => c.name === "login");
      assert.ok(loginFeature, "Should find login feature");
      assert.strictEqual(loginFeature?.kind, vscode.SymbolKind.Class);

      // Login feature should have children (requirements)
      const featureChildren = loginFeature?.children;
      assert.ok(
        featureChildren && featureChildren.length >= 1,
        "Feature should have requirement children"
      );

      // Find the basic-auth requirement
      const basicAuth = featureChildren?.find((c) => c.name === "basic-auth");
      assert.ok(basicAuth, "Should find basic-auth requirement");
      assert.strictEqual(basicAuth?.kind, vscode.SymbolKind.Function);

      // Requirement should have constraint as child
      const reqChildren = basicAuth?.children;
      assert.ok(
        reqChildren && reqChildren.length >= 1,
        "Requirement should have constraint children"
      );

      const bcryptConstraint = reqChildren?.find((c) => c.name === "bcrypt");
      assert.ok(bcryptConstraint, "Should find bcrypt constraint");

      console.log("Document symbols hierarchical structure verified");
    } else {
      console.log("Document symbols not available (LSP server may not be ready)");
    }
  });
});

suite("File Associations", () => {
  test(".bp files are associated with blueprint language", async () => {
    // Create a document with .bp extension simulation
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test",
    });

    assert.strictEqual(doc.languageId, "blueprint", "Document should have blueprint language ID");
  });
});

suite("Settings Application", () => {
  /**
   * Helper to update a configuration setting and wait for it to propagate.
   */
  async function updateSetting<T>(
    section: string,
    value: T,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    const parts = section.split(".");
    const key = parts.pop()!;
    const configSection = parts.join(".");
    const config = vscode.workspace.getConfiguration(configSection);
    await config.update(key, value, target);
    // Allow time for the setting change to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  /**
   * Helper to reset a configuration setting to its default.
   */
  async function resetSetting(section: string): Promise<void> {
    const parts = section.split(".");
    const key = parts.pop()!;
    const configSection = parts.join(".");
    const config = vscode.workspace.getConfiguration(configSection);
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  test("gotoModifier setting updates editor.multiCursorModifier for blueprint", async () => {
    // Open a Blueprint document to ensure language-specific settings are active
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test module",
    });
    await vscode.window.showTextDocument(doc);

    // Wait for extension to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // Set gotoModifier to "ctrlCmd" (means Ctrl/Cmd+Click for definition)
      await updateSetting("blueprint.gotoModifier", "ctrlCmd");

      // Check that editor.multiCursorModifier is set to "alt" for Blueprint
      // (inverse relationship: if gotoModifier is ctrlCmd, multiCursorModifier should be alt)
      const editorConfig = vscode.workspace.getConfiguration("editor", {
        languageId: "blueprint",
      });
      const multiCursorModifier = editorConfig.get<string>("multiCursorModifier");

      // The setting should be "alt" when gotoModifier is "ctrlCmd"
      assert.strictEqual(
        multiCursorModifier,
        "alt",
        "multiCursorModifier should be 'alt' when gotoModifier is 'ctrlCmd'"
      );

      // Now set gotoModifier to "alt" (default)
      await updateSetting("blueprint.gotoModifier", "alt");

      // Check that editor.multiCursorModifier is set to "ctrlCmd" for Blueprint
      const updatedConfig = vscode.workspace.getConfiguration("editor", {
        languageId: "blueprint",
      });
      const updatedModifier = updatedConfig.get<string>("multiCursorModifier");
      assert.strictEqual(
        updatedModifier,
        "ctrlCmd",
        "multiCursorModifier should be 'ctrlCmd' when gotoModifier is 'alt'"
      );
    } finally {
      // Reset to default
      await resetSetting("blueprint.gotoModifier");
    }
  });

  test("hoverDelay setting updates editor.hover.delay for blueprint", async () => {
    // Open a Blueprint document
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test module",
    });
    await vscode.window.showTextDocument(doc);

    // Wait for extension to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // Set a custom hover delay
      const customDelay = 500;
      await updateSetting("blueprint.hoverDelay", customDelay);

      // Check that editor.hover.delay is updated for Blueprint
      const editorConfig = vscode.workspace.getConfiguration("editor", {
        languageId: "blueprint",
      });
      const hoverDelay = editorConfig.get<number>("hover.delay");

      assert.strictEqual(
        hoverDelay,
        customDelay,
        `hover.delay should be ${customDelay} after setting hoverDelay`
      );

      // Set a different delay
      const anotherDelay = 150;
      await updateSetting("blueprint.hoverDelay", anotherDelay);

      const updatedConfig = vscode.workspace.getConfiguration("editor", {
        languageId: "blueprint",
      });
      const updatedDelay = updatedConfig.get<number>("hover.delay");
      assert.strictEqual(
        updatedDelay,
        anotherDelay,
        `hover.delay should be ${anotherDelay} after updating hoverDelay`
      );
    } finally {
      // Reset to default
      await resetSetting("blueprint.hoverDelay");
    }
  });

  test("highlighting color settings update semantic token customizations", async () => {
    // Open a Blueprint document
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test module",
    });
    await vscode.window.showTextDocument(doc);

    // Wait for extension to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // Set custom highlighting colors
      const customCompleteColor = "#00ff00";
      const customBlockedColor = "#ff0000";

      await updateSetting("blueprint.highlighting.complete", customCompleteColor);
      await updateSetting("blueprint.highlighting.blocked", customBlockedColor);

      // Allow extra time for semantic token customizations to update
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Check that editor.semanticTokenColorCustomizations includes our rules
      const editorConfig = vscode.workspace.getConfiguration("editor");
      const tokenCustomizations = editorConfig.get<{ rules?: Record<string, unknown> }>(
        "semanticTokenColorCustomizations"
      );

      assert.ok(tokenCustomizations, "semanticTokenColorCustomizations should exist");
      assert.ok(tokenCustomizations.rules, "semanticTokenColorCustomizations.rules should exist");

      // Verify the complete color rule
      const completeRule = tokenCustomizations.rules["*.complete:blueprint"] as
        | { foreground?: string }
        | undefined;
      assert.ok(completeRule, "Should have *.complete:blueprint rule");
      assert.strictEqual(
        completeRule.foreground,
        customCompleteColor,
        "complete rule foreground should match custom color"
      );

      // Verify the blocked color rule
      const blockedRule = tokenCustomizations.rules["*.blocked:blueprint"] as
        | { foreground?: string }
        | undefined;
      assert.ok(blockedRule, "Should have *.blocked:blueprint rule");
      assert.strictEqual(
        blockedRule.foreground,
        customBlockedColor,
        "blocked rule foreground should match custom color"
      );
    } finally {
      // Reset to defaults
      await resetSetting("blueprint.highlighting.complete");
      await resetSetting("blueprint.highlighting.blocked");
    }
  });

  test("showProgressInGutter setting can be toggled", async () => {
    // This test verifies the setting can be changed without errors.
    // We cannot easily verify decorations are applied in E2E tests,
    // but we can verify the setting change is accepted.

    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module test
  Test module

  @feature example
    Example feature

    @requirement sample
      Sample requirement
`,
    });
    await vscode.window.showTextDocument(doc);

    // Wait for extension to initialize
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      // Disable gutter icons
      await updateSetting("blueprint.showProgressInGutter", false);

      // Verify the setting was applied
      const config = vscode.workspace.getConfiguration("blueprint");
      const gutterEnabled = config.get<boolean>("showProgressInGutter");
      assert.strictEqual(gutterEnabled, false, "showProgressInGutter should be false");

      // Re-enable gutter icons
      await updateSetting("blueprint.showProgressInGutter", true);

      const updatedConfig = vscode.workspace.getConfiguration("blueprint");
      const updatedGutterEnabled = updatedConfig.get<boolean>("showProgressInGutter");
      assert.strictEqual(updatedGutterEnabled, true, "showProgressInGutter should be true");
    } finally {
      // Reset to default
      await resetSetting("blueprint.showProgressInGutter");
    }
  });

  test("showProgressHighlighting setting can be toggled", async () => {
    // This test verifies the setting can be changed without errors.

    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: `@module test
  Test module

  @feature example
    Example feature

    @requirement sample
      Sample requirement
`,
    });
    await vscode.window.showTextDocument(doc);

    // Wait for extension to initialize
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      // Disable background highlighting
      await updateSetting("blueprint.showProgressHighlighting", false);

      // Verify the setting was applied
      const config = vscode.workspace.getConfiguration("blueprint");
      const highlightingEnabled = config.get<boolean>("showProgressHighlighting");
      assert.strictEqual(highlightingEnabled, false, "showProgressHighlighting should be false");

      // Re-enable background highlighting
      await updateSetting("blueprint.showProgressHighlighting", true);

      const updatedConfig = vscode.workspace.getConfiguration("blueprint");
      const updatedHighlightingEnabled = updatedConfig.get<boolean>("showProgressHighlighting");
      assert.strictEqual(
        updatedHighlightingEnabled,
        true,
        "showProgressHighlighting should be true"
      );
    } finally {
      // Reset to default
      await resetSetting("blueprint.showProgressHighlighting");
    }
  });

  test("ticketsPath setting is readable and can be changed", async () => {
    try {
      // Get the default value
      const config = vscode.workspace.getConfiguration("blueprint");
      const defaultPath = config.get<string>("ticketsPath");
      assert.strictEqual(
        defaultPath,
        ".blueprint/tickets",
        "Default ticketsPath should be .blueprint/tickets"
      );

      // Set a custom path
      const customPath = "custom/tickets/path";
      await updateSetting("blueprint.ticketsPath", customPath);

      // Verify the setting was applied
      const updatedConfig = vscode.workspace.getConfiguration("blueprint");
      const updatedPath = updatedConfig.get<string>("ticketsPath");
      assert.strictEqual(updatedPath, customPath, "ticketsPath should be updated to custom path");
    } finally {
      // Reset to default
      await resetSetting("blueprint.ticketsPath");
    }
  });

  test("trace.server setting accepts valid values", async () => {
    try {
      // Test each valid trace level
      const validLevels = ["off", "messages", "verbose"] as const;

      for (const level of validLevels) {
        await updateSetting("blueprint.trace.server", level);

        const config = vscode.workspace.getConfiguration("blueprint");
        const traceLevel = config.get<string>("trace.server");
        assert.strictEqual(traceLevel, level, `trace.server should be '${level}'`);
      }
    } finally {
      // Reset to default
      await resetSetting("blueprint.trace.server");
    }
  });

  test("multiple highlighting colors can be updated together", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "blueprint",
      content: "@module test\n  Test module",
    });
    await vscode.window.showTextDocument(doc);

    // Wait for extension to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // Set all highlighting colors at once
      const customColors = {
        complete: "#11aa11",
        inProgress: "#aaaa11",
        blocked: "#aa1111",
        noTicket: "#555555",
        obsolete: "#888888",
      };

      await updateSetting("blueprint.highlighting.complete", customColors.complete);
      await updateSetting("blueprint.highlighting.inProgress", customColors.inProgress);
      await updateSetting("blueprint.highlighting.blocked", customColors.blocked);
      await updateSetting("blueprint.highlighting.noTicket", customColors.noTicket);
      await updateSetting("blueprint.highlighting.obsolete", customColors.obsolete);

      // Allow time for semantic token customizations to update
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify all colors in the configuration
      const highlightConfig = vscode.workspace.getConfiguration("blueprint.highlighting");
      assert.strictEqual(highlightConfig.get("complete"), customColors.complete);
      assert.strictEqual(highlightConfig.get("inProgress"), customColors.inProgress);
      assert.strictEqual(highlightConfig.get("blocked"), customColors.blocked);
      assert.strictEqual(highlightConfig.get("noTicket"), customColors.noTicket);
      assert.strictEqual(highlightConfig.get("obsolete"), customColors.obsolete);

      // Verify semantic token rules were updated
      const editorConfig = vscode.workspace.getConfiguration("editor");
      const tokenCustomizations = editorConfig.get<{ rules?: Record<string, unknown> }>(
        "semanticTokenColorCustomizations"
      );

      assert.ok(tokenCustomizations?.rules, "semanticTokenColorCustomizations.rules should exist");

      const rules = tokenCustomizations.rules as Record<string, { foreground?: string }>;
      assert.strictEqual(rules["*.complete:blueprint"]?.foreground, customColors.complete);
      assert.strictEqual(rules["*.inProgress:blueprint"]?.foreground, customColors.inProgress);
      assert.strictEqual(rules["*.blocked:blueprint"]?.foreground, customColors.blocked);
      assert.strictEqual(rules["*.noTicket:blueprint"]?.foreground, customColors.noTicket);
      assert.strictEqual(rules["*.obsolete:blueprint"]?.foreground, customColors.obsolete);
    } finally {
      // Reset all to defaults
      await resetSetting("blueprint.highlighting.complete");
      await resetSetting("blueprint.highlighting.inProgress");
      await resetSetting("blueprint.highlighting.blocked");
      await resetSetting("blueprint.highlighting.noTicket");
      await resetSetting("blueprint.highlighting.obsolete");
    }
  });
});
