/**
 * Test Suite Entry Point
 *
 * This module is loaded by VS Code's test runner and discovers/runs all tests.
 * Uses Mocha as the test framework (standard for VS Code extension testing).
 */

import Mocha from "mocha";
import { glob } from "glob";
import { join } from "node:path";

export async function run(): Promise<void> {
  // Create the mocha test runner
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 60000, // Longer timeout for VS Code extension tests
  });

  const testsRoot = __dirname;

  // Find all test files
  const files = await glob("**/*.test.js", { cwd: testsRoot });

  // Add files to the test suite
  for (const file of files) {
    mocha.addFile(join(testsRoot, file));
  }

  // Set up Mocha globals before loading test files
  // This exposes suite, test, etc. to the global scope
  mocha.suite.emit("pre-require", global, "", mocha);

  // Run the mocha test
  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
