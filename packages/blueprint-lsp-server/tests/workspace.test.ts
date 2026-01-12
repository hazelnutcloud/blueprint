import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WorkspaceManager } from "../src/workspace";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { URI } from "vscode-uri";

// Mock connection for testing
function createMockConnection() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    console: {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    },
    logs,
    errors,
  };
}

describe("WorkspaceManager", () => {
  let testDir: string;
  let mockConnection: ReturnType<typeof createMockConnection>;
  let workspaceManager: WorkspaceManager;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = join(tmpdir(), `blueprint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    mockConnection = createMockConnection();
    workspaceManager = new WorkspaceManager(mockConnection as any);
  });

  afterEach(async () => {
    workspaceManager.cleanup();
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe("setWorkspaceFolders", () => {
    test("accepts null workspace folders", () => {
      expect(() => workspaceManager.setWorkspaceFolders(null)).not.toThrow();
    });

    test("accepts empty workspace folders", () => {
      expect(() => workspaceManager.setWorkspaceFolders([])).not.toThrow();
    });

    test("accepts workspace folders array", () => {
      const folders = [{ uri: URI.file(testDir).toString(), name: "test" }];
      expect(() => workspaceManager.setWorkspaceFolders(folders)).not.toThrow();
    });
  });

  describe("scanAllFolders", () => {
    test("finds .bp files in workspace root", async () => {
      // Create test files
      await writeFile(join(testDir, "auth.bp"), "@module auth");
      await writeFile(join(testDir, "payments.bp"), "@module payments");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      const files = workspaceManager.getDiscoveredFiles();
      expect(files.length).toBe(2);
      expect(files.some((f) => f.path.endsWith("auth.bp"))).toBe(true);
      expect(files.some((f) => f.path.endsWith("payments.bp"))).toBe(true);
    });

    test("finds .bp files in subdirectories", async () => {
      // Create nested structure
      const requirementsDir = join(testDir, "requirements");
      await mkdir(requirementsDir, { recursive: true });
      await writeFile(join(requirementsDir, "auth.bp"), "@module auth");

      const deepDir = join(testDir, "src", "specs");
      await mkdir(deepDir, { recursive: true });
      await writeFile(join(deepDir, "api.bp"), "@module api");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      const files = workspaceManager.getDiscoveredFiles();
      expect(files.length).toBe(2);
      expect(files.some((f) => f.path.includes("requirements") && f.path.endsWith("auth.bp"))).toBe(
        true
      );
      expect(files.some((f) => f.path.includes("specs") && f.path.endsWith("api.bp"))).toBe(true);
    });

    test("ignores hidden directories", async () => {
      // Create hidden directory with .bp file
      const hiddenDir = join(testDir, ".hidden");
      await mkdir(hiddenDir, { recursive: true });
      await writeFile(join(hiddenDir, "secret.bp"), "@module secret");

      // Create visible .bp file
      await writeFile(join(testDir, "visible.bp"), "@module visible");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      const files = workspaceManager.getDiscoveredFiles();
      expect(files.length).toBe(1);
      expect(files[0]!.path.endsWith("visible.bp")).toBe(true);
    });

    test("ignores node_modules directory", async () => {
      // Create node_modules with .bp file
      const nodeModulesDir = join(testDir, "node_modules", "some-package");
      await mkdir(nodeModulesDir, { recursive: true });
      await writeFile(join(nodeModulesDir, "package.bp"), "@module package");

      // Create visible .bp file
      await writeFile(join(testDir, "app.bp"), "@module app");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      const files = workspaceManager.getDiscoveredFiles();
      expect(files.length).toBe(1);
      expect(files[0]!.path.endsWith("app.bp")).toBe(true);
    });

    test("ignores dist, build, and out directories", async () => {
      // Create build directories with .bp files
      for (const dir of ["dist", "build", "out"]) {
        const buildDir = join(testDir, dir);
        await mkdir(buildDir, { recursive: true });
        await writeFile(join(buildDir, "generated.bp"), "@module generated");
      }

      // Create visible .bp file
      await writeFile(join(testDir, "source.bp"), "@module source");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      const files = workspaceManager.getDiscoveredFiles();
      expect(files.length).toBe(1);
      expect(files[0]!.path.endsWith("source.bp")).toBe(true);
    });

    test("ignores non-.bp files", async () => {
      await writeFile(join(testDir, "auth.bp"), "@module auth");
      await writeFile(join(testDir, "readme.md"), "# Readme");
      await writeFile(join(testDir, "config.json"), "{}");
      await writeFile(join(testDir, "script.ts"), "console.log('hi')");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      const files = workspaceManager.getDiscoveredFiles();
      expect(files.length).toBe(1);
      expect(files[0]!.path.endsWith("auth.bp")).toBe(true);
    });

    test("handles empty workspace", async () => {
      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      expect(workspaceManager.getDiscoveredFiles().length).toBe(0);
      expect(workspaceManager.getFileCount()).toBe(0);
    });

    test("logs scan completion message", async () => {
      await writeFile(join(testDir, "auth.bp"), "@module auth");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      expect(mockConnection.logs.some((log) => log.includes("Workspace scan complete"))).toBe(true);
      expect(mockConnection.logs.some((log) => log.includes("1 .bp files"))).toBe(true);
    });
  });

  describe("handleWorkspaceFoldersChange", () => {
    test("adds files from newly added folders", async () => {
      // Create a second test directory
      const testDir2 = join(tmpdir(), `blueprint-test2-${Date.now()}`);
      await mkdir(testDir2, { recursive: true });
      await writeFile(join(testDir2, "new.bp"), "@module new");

      try {
        workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

        await workspaceManager.handleWorkspaceFoldersChange({
          added: [{ uri: URI.file(testDir2).toString(), name: "test2" }],
          removed: [],
        });

        const files = workspaceManager.getDiscoveredFiles();
        expect(files.some((f) => f.path.endsWith("new.bp"))).toBe(true);
      } finally {
        await rm(testDir2, { recursive: true, force: true });
      }
    });

    test("removes files from removed folders", async () => {
      await writeFile(join(testDir, "auth.bp"), "@module auth");

      const folder = { uri: URI.file(testDir).toString(), name: "test" };
      workspaceManager.setWorkspaceFolders([folder]);
      await workspaceManager.scanAllFolders();

      expect(workspaceManager.getFileCount()).toBe(1);

      await workspaceManager.handleWorkspaceFoldersChange({
        added: [],
        removed: [folder],
      });

      expect(workspaceManager.getFileCount()).toBe(0);
    });
  });

  describe("file access methods", () => {
    beforeEach(async () => {
      await writeFile(join(testDir, "auth.bp"), "@module auth");
      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);
      await workspaceManager.scanAllFolders();
    });

    test("getFile returns file by URI", () => {
      const files = workspaceManager.getDiscoveredFiles();
      const file = workspaceManager.getFile(files[0]!.uri);
      expect(file).toBeDefined();
      expect(file!.path.endsWith("auth.bp")).toBe(true);
    });

    test("getFile returns undefined for unknown URI", () => {
      const file = workspaceManager.getFile("file:///nonexistent/file.bp");
      expect(file).toBeUndefined();
    });

    test("hasFile returns true for known files", () => {
      const files = workspaceManager.getDiscoveredFiles();
      expect(workspaceManager.hasFile(files[0]!.uri)).toBe(true);
    });

    test("hasFile returns false for unknown files", () => {
      expect(workspaceManager.hasFile("file:///nonexistent/file.bp")).toBe(false);
    });

    test("getFileCount returns correct count", () => {
      expect(workspaceManager.getFileCount()).toBe(1);
    });
  });

  describe("addFile and removeFile", () => {
    test("addFile adds a new file to the index", () => {
      const uri = URI.file(join(testDir, "new.bp")).toString();
      const path = join(testDir, "new.bp");

      workspaceManager.addFile(uri, path);

      expect(workspaceManager.hasFile(uri)).toBe(true);
      expect(workspaceManager.getFileCount()).toBe(1);
    });

    test("addFile does not duplicate existing files", () => {
      const uri = URI.file(join(testDir, "auth.bp")).toString();
      const path = join(testDir, "auth.bp");

      workspaceManager.addFile(uri, path);
      workspaceManager.addFile(uri, path);

      expect(workspaceManager.getFileCount()).toBe(1);
    });

    test("removeFile removes a file from the index", () => {
      const uri = URI.file(join(testDir, "auth.bp")).toString();
      const path = join(testDir, "auth.bp");

      workspaceManager.addFile(uri, path);
      expect(workspaceManager.hasFile(uri)).toBe(true);

      workspaceManager.removeFile(uri);
      expect(workspaceManager.hasFile(uri)).toBe(false);
    });

    test("removeFile is safe for non-existent files", () => {
      expect(() => workspaceManager.removeFile("file:///nonexistent.bp")).not.toThrow();
    });
  });

  describe("onFilesChanged callback", () => {
    test("callback is invoked on scanAllFolders", async () => {
      await writeFile(join(testDir, "auth.bp"), "@module auth");

      let callbackInvoked = false;
      let receivedFiles: any[] = [];

      workspaceManager.onFilesChanged((files) => {
        callbackInvoked = true;
        receivedFiles = files;
      });

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);

      await workspaceManager.scanAllFolders();

      expect(callbackInvoked).toBe(true);
      expect(receivedFiles.length).toBe(1);
    });

    test("callback is invoked on addFile", () => {
      let callbackInvoked = false;

      workspaceManager.onFilesChanged(() => {
        callbackInvoked = true;
      });

      workspaceManager.addFile(
        URI.file(join(testDir, "new.bp")).toString(),
        join(testDir, "new.bp")
      );

      expect(callbackInvoked).toBe(true);
    });

    test("callback is invoked on removeFile", () => {
      const uri = URI.file(join(testDir, "auth.bp")).toString();
      workspaceManager.addFile(uri, join(testDir, "auth.bp"));

      let callbackInvoked = false;
      workspaceManager.onFilesChanged(() => {
        callbackInvoked = true;
      });

      workspaceManager.removeFile(uri);

      expect(callbackInvoked).toBe(true);
    });
  });

  describe("cleanup", () => {
    test("clears all state", async () => {
      await writeFile(join(testDir, "auth.bp"), "@module auth");

      workspaceManager.setWorkspaceFolders([{ uri: URI.file(testDir).toString(), name: "test" }]);
      await workspaceManager.scanAllFolders();

      expect(workspaceManager.getFileCount()).toBe(1);

      workspaceManager.cleanup();

      expect(workspaceManager.getFileCount()).toBe(0);
      expect(workspaceManager.getDiscoveredFiles()).toEqual([]);
    });
  });

  describe("getWorkspaceFolderUris", () => {
    test("returns empty array when no workspace folders set", () => {
      const uris = workspaceManager.getWorkspaceFolderUris();
      expect(uris).toEqual([]);
    });

    test("returns empty array when workspace folders is null", () => {
      workspaceManager.setWorkspaceFolders(null);
      const uris = workspaceManager.getWorkspaceFolderUris();
      expect(uris).toEqual([]);
    });

    test("returns URIs for all workspace folders", () => {
      const folder1Uri = URI.file(testDir).toString();
      const folder2Uri = URI.file(join(testDir, "subdir")).toString();

      workspaceManager.setWorkspaceFolders([
        { uri: folder1Uri, name: "test1" },
        { uri: folder2Uri, name: "test2" },
      ]);

      const uris = workspaceManager.getWorkspaceFolderUris();
      expect(uris.length).toBe(2);
      expect(uris).toContain(folder1Uri);
      expect(uris).toContain(folder2Uri);
    });

    test("preserves order of workspace folders", () => {
      const folder1Uri = URI.file(join(testDir, "first")).toString();
      const folder2Uri = URI.file(join(testDir, "second")).toString();

      workspaceManager.setWorkspaceFolders([
        { uri: folder1Uri, name: "first" },
        { uri: folder2Uri, name: "second" },
      ]);

      const uris = workspaceManager.getWorkspaceFolderUris();
      expect(uris[0]).toBe(folder1Uri);
      expect(uris[1]).toBe(folder2Uri);
    });
  });
});
