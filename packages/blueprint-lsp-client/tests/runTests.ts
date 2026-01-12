/**
 * VS Code Extension End-to-End Test Runner
 *
 * This script downloads VS Code, installs the extension, and runs the test suite.
 * It uses @vscode/test-electron to launch a real VS Code instance for testing.
 */

import { runTests } from "@vscode/test-electron";
import { join } from "node:path";

async function main(): Promise<void> {
  try {
    // The folder containing the Extension Manifest package.json
    // __dirname is out/tests, so we need to go up two levels to reach the package root
    const extensionDevelopmentPath = join(__dirname, "..", "..");

    // The path to the extension test script
    // This is relative to out/tests, so suite/index.js is in out/tests/suite/index.js
    const extensionTestsPath = join(__dirname, "suite", "index.js");

    // Download VS Code, unzip it and run the integration tests
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Use a clean user data directory for tests
      launchArgs: [
        "--disable-gpu", // Disable GPU for headless environments
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();
