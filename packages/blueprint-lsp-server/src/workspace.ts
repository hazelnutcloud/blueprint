import { URI } from "vscode-uri";
import type { Connection, WorkspaceFolder } from "vscode-languageserver/node";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Represents a discovered Blueprint file in the workspace.
 */
export interface WorkspaceFile {
  /** The file URI */
  uri: string;
  /** The absolute file path */
  path: string;
}

/**
 * Manages workspace folder scanning and file discovery for Blueprint files.
 */
export class WorkspaceManager {
  private connection: Connection;
  private workspaceFolders: WorkspaceFolder[] = [];
  private discoveredFiles: Map<string, WorkspaceFile> = new Map();
  private onFilesChangedCallbacks: Array<(files: WorkspaceFile[]) => void> = [];

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Set the initial workspace folders.
   */
  setWorkspaceFolders(folders: WorkspaceFolder[] | null): void {
    this.workspaceFolders = folders ?? [];
  }

  /**
   * Handle workspace folder changes (additions and removals).
   */
  async handleWorkspaceFoldersChange(event: {
    added: WorkspaceFolder[];
    removed: WorkspaceFolder[];
  }): Promise<void> {
    // Remove files from removed folders
    for (const folder of event.removed) {
      this.removeFilesFromFolder(folder);
      const index = this.workspaceFolders.findIndex((f) => f.uri === folder.uri);
      if (index !== -1) {
        this.workspaceFolders.splice(index, 1);
      }
    }

    // Add new folders and scan them
    for (const folder of event.added) {
      this.workspaceFolders.push(folder);
      await this.scanFolder(folder);
    }

    // Notify listeners
    this.notifyFilesChanged();
  }

  /**
   * Scan all workspace folders for .bp files.
   */
  async scanAllFolders(): Promise<void> {
    this.discoveredFiles.clear();

    for (const folder of this.workspaceFolders) {
      await this.scanFolder(folder);
    }

    this.connection.console.log(
      `Workspace scan complete. Found ${this.discoveredFiles.size} .bp files.`
    );
    this.notifyFilesChanged();
  }

  /**
   * Scan a single workspace folder for .bp files.
   */
  private async scanFolder(folder: WorkspaceFolder): Promise<void> {
    const folderUri = URI.parse(folder.uri);
    const folderPath = folderUri.fsPath;

    this.connection.console.log(`Scanning workspace folder: ${folderPath}`);

    try {
      await this.scanDirectory(folderPath);
    } catch (error) {
      this.connection.console.error(`Error scanning folder ${folderPath}: ${error}`);
    }
  }

  /**
   * Recursively scan a directory for .bp files.
   */
  private async scanDirectory(dirPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      // Skip directories we can't read (permission errors, etc.)
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      // Skip hidden files and directories (starting with .)
      if (entry.name.startsWith(".")) {
        continue;
      }

      // Skip common non-source directories
      if (
        entry.isDirectory() &&
        (entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === "out")
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".bp")) {
        const fileUri = URI.file(fullPath).toString();
        this.discoveredFiles.set(fileUri, {
          uri: fileUri,
          path: fullPath,
        });
        this.connection.console.log(`Discovered Blueprint file: ${fullPath}`);
      }
    }
  }

  /**
   * Remove all discovered files that belong to a workspace folder.
   */
  private removeFilesFromFolder(folder: WorkspaceFolder): void {
    const folderUri = URI.parse(folder.uri);
    const folderPath = folderUri.fsPath;

    for (const [uri, file] of this.discoveredFiles) {
      if (file.path.startsWith(folderPath)) {
        this.discoveredFiles.delete(uri);
        this.connection.console.log(`Removed Blueprint file from index: ${file.path}`);
      }
    }
  }

  /**
   * Get all discovered Blueprint files.
   */
  getDiscoveredFiles(): WorkspaceFile[] {
    return Array.from(this.discoveredFiles.values());
  }

  /**
   * Get a discovered file by URI.
   */
  getFile(uri: string): WorkspaceFile | undefined {
    return this.discoveredFiles.get(uri);
  }

  /**
   * Check if a file URI is a discovered Blueprint file.
   */
  hasFile(uri: string): boolean {
    return this.discoveredFiles.has(uri);
  }

  /**
   * Get the count of discovered files.
   */
  getFileCount(): number {
    return this.discoveredFiles.size;
  }

  /**
   * Register a callback to be notified when discovered files change.
   */
  onFilesChanged(callback: (files: WorkspaceFile[]) => void): void {
    this.onFilesChangedCallbacks.push(callback);
  }

  /**
   * Notify all listeners that the discovered files have changed.
   */
  private notifyFilesChanged(): void {
    const files = this.getDiscoveredFiles();
    for (const callback of this.onFilesChangedCallbacks) {
      callback(files);
    }
  }

  /**
   * Add a file to the discovered files (e.g., when a new .bp file is created).
   */
  addFile(uri: string, path: string): void {
    if (!this.discoveredFiles.has(uri)) {
      this.discoveredFiles.set(uri, { uri, path });
      this.connection.console.log(`Added Blueprint file to index: ${path}`);
      this.notifyFilesChanged();
    }
  }

  /**
   * Remove a file from the discovered files (e.g., when a .bp file is deleted).
   */
  removeFile(uri: string): void {
    const file = this.discoveredFiles.get(uri);
    if (file) {
      this.discoveredFiles.delete(uri);
      this.connection.console.log(`Removed Blueprint file from index: ${file.path}`);
      this.notifyFilesChanged();
    }
  }

  /**
   * Get the URIs of all workspace folders.
   */
  getWorkspaceFolderUris(): string[] {
    return this.workspaceFolders.map((folder) => folder.uri);
  }

  /**
   * Clean up resources.
   */
  cleanup(): void {
    this.discoveredFiles.clear();
    this.onFilesChangedCallbacks = [];
    this.workspaceFolders = [];
  }
}
