// src/providers/PromptTowerProvider.ts

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FileItem } from "../models/FileItem";
import { encode } from "gpt-tokenizer";
import { TokenUpdateEmitter } from "../models/EventEmitter";

/**
 * @TODO
 * - config listeners
 * - promptTower.useGitignore: This is the major missing piece. You need to add logic to read this setting, parse .gitignore files, and integrate those patterns (using a proper matching library) with the promptTower.ignore setting.
 * - "format path as comment" (need config and implementation)
 */

export class PromptTowerProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    FileItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private items = new Map<string, FileItem>();
  private excludedPatterns: string[] = [];
  private persistState: boolean = true;
  private maxFileSizeWarningKB: number = 500;

  private blockTemplate: string =
    '<file name="{fileNameWithExtension}">\n<source>{rawFilePath}</source>\n<file_content><![CDATA[\n{fileContent}\n]]>\n</file_content>\n</file>';
  private blockSeparator: string = "\n";
  private outputExtension: string = "txt";
  private wrapperTemplate: string | null =
    "<context>\n<files>\n{blocks}\n</files>\n</context>";

  // START ADD
  // --- Token Counting State ---
  private totalTokenCount: number = 0;
  private isCountingTokens: boolean = false;
  private currentTokenCalculationVersion = 0; // For cancellation
  // END ADD

  constructor(
    private workspaceRoot: string,
    private context: vscode.ExtensionContext,
    private tokenUpdateEmitter: TokenUpdateEmitter
  ) {
    this.loadConfig();
    this.loadPersistedState();
    this.debouncedUpdateTokenCount(100); // Initial count calculation (debounced slightly)
  }

  // START ADD
  // --- Token Counting Logic Helpers ---

  private notifyTokenUpdate() {
    // Fire event only if emitter exists (it should, but defensive check)
    if (this.tokenUpdateEmitter) {
      this.tokenUpdateEmitter.fire({
        count: this.totalTokenCount,
        isCounting: this.isCountingTokens,
      });
    }
  }

  // Debounce function
  private debounceTimeout: NodeJS.Timeout | null = null;
  private debouncedUpdateTokenCount = (delay: number = 300) => {
    // Always clear existing timeout
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }
    // Invalidate any ongoing calculation immediately because a new trigger occurred
    this.currentTokenCalculationVersion++;

    // Set a new timeout
    this.debounceTimeout = setTimeout(() => {
      // Trigger the actual update after the delay
      this.updateTokenCount();
    }, delay);
  };

  // --- Getters for current state (used by extension.ts for initial webview update) ---
  getCurrentTokenCount(): number {
    return this.totalTokenCount;
  }

  getIsCounting(): boolean {
    return this.isCountingTokens;
  }
  // END ADD

  // START ADD
  async updateTokenCount(): Promise<void> {
    // Capture the version intended for *this specific run*
    const calculationVersion = this.currentTokenCalculationVersion;

    // Get currently checked files that exist
    const checkedFiles = this.getCheckedFiles();

    // --- Handle No Files Selected ---
    if (checkedFiles.length === 0) {
      // Check if a newer calculation has already started
      if (calculationVersion !== this.currentTokenCalculationVersion) return;

      this.totalTokenCount = 0;
      this.isCountingTokens = false;
      this.notifyTokenUpdate();
      console.log(
        `Token count reset to 0 (Version ${calculationVersion} - no files selected).`
      );
      return;
    }

    // --- Start Counting ---
    console.log(
      `Token counting started (Version ${calculationVersion}) for ${checkedFiles.length} files.`
    );
    this.isCountingTokens = true;
    this.notifyTokenUpdate(); // Notify UI that counting started

    let runningTokenCount = 0;
    let filesProcessed = 0;

    try {
      for (const filePath of checkedFiles) {
        // --- Cancellation Check (Start of Loop) ---
        if (calculationVersion !== this.currentTokenCalculationVersion) {
          console.log(
            `Token counting cancelled (Version ${calculationVersion}). Newer version exists.`
          );
          // Don't change state here; let the newer calculation take over.
          return; // Stop this outdated calculation
        }

        try {
          // Double-check existence before reading, as getCheckedFiles might race
          // Although getCheckedFiles now filters, this is extra safety.
          if (!fs.existsSync(filePath)) {
            console.warn(
              `Skipping token count for non-existent file during loop: ${filePath}`
            );
            this.items.delete(filePath); // Clean up map
            continue;
          }
          const content = await fs.promises.readFile(filePath, "utf-8");
          const tokens = encode(content); // Count tokens
          runningTokenCount += tokens.length;
          filesProcessed++;

          // --- Yielding for Responsiveness (Optional but Recommended) ---
          if (filesProcessed % 50 === 0) {
            // Yield every 50 files
            await new Promise((resolve) => setImmediate(resolve));
            // Check for cancellation again after yielding
            if (calculationVersion !== this.currentTokenCalculationVersion) {
              console.log(
                `Token counting cancelled during yield (Version ${calculationVersion}).`
              );
              return; // Stop this outdated calculation
            }
          }
        } catch (err: any) {
          // Handle specific file read/encode errors
          if (err.code === "ENOENT") {
            console.warn(`File not found during token count loop: ${filePath}`);
            this.items.delete(filePath); // Clean up map
          } else if (
            err instanceof Error &&
            err.message?.includes("is too large")
          ) {
            console.warn(`Skipping large file during token count: ${filePath}`);
            // Optionally show a less intrusive warning once?
          } else {
            console.error(
              `Error processing file for token count ${filePath}:`,
              err
            );
            // Potentially notify user once about general errors?
          }
          // Continue with the next file even if one fails
        }
      } // End of for loop

      // --- Final Cancellation Check ---
      if (calculationVersion !== this.currentTokenCalculationVersion) {
        console.log(
          `Token counting cancelled before final update (Version ${calculationVersion}).`
        );
        return; // Stop if a newer calculation finished during the loop
      }

      // --- Update Final State ---
      this.totalTokenCount = runningTokenCount;
      this.isCountingTokens = false;
      console.log(
        `Token counting finished (Version ${calculationVersion}). Total tokens: ${this.totalTokenCount}`
      );
    } catch (error) {
      // Catch unexpected errors in the overall process
      console.error("Unexpected error during token counting process:", error);
      // Ensure state is reset if this calculation was the latest one
      if (calculationVersion === this.currentTokenCalculationVersion) {
        this.isCountingTokens = false;
        // Maybe set count to -1 or NaN to indicate error? Or keep last known good?
        // Let's keep the count as it was before the error for now.
      }
    } finally {
      // --- Notify UI (only if this calculation is still the latest) ---
      if (calculationVersion === this.currentTokenCalculationVersion) {
        // Ensure isCounting is false, even if errors occurred mid-way
        this.isCountingTokens = false;
        this.notifyTokenUpdate(); // Send final state
      }
      // If not the latest, the newer calculation's finally block will notify.
    }
  }
  // END ADD

  // Required by TreeDataProvider interface
  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  // Required by TreeDataProvider interface
  async getChildren(element?: FileItem): Promise<FileItem[]> {
    const dirPath = element ? element.filePath : this.workspaceRoot;

    try {
      // Check if path exists and is a directory before reading
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        console.warn(
          `getChildren called on non-existent or non-directory path: ${dirPath}`
        );
        // If the element itself is invalid, remove it from the map?
        if (element) this.items.delete(element.filePath);
        return [];
      }

      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });
      const children: FileItem[] = [];

      for (const entry of entries) {
        // Apply exclusion patterns defined in loadConfig
        if (
          this.excludedPatterns.some((pattern) =>
            this.matchesPattern(entry.name, pattern)
          )
        ) {
          continue;
        }

        const filePath = path.join(dirPath, entry.name);
        let item = this.items.get(filePath); // Check if we already know about this item

        if (!item) {
          // Item not in map - must be newly discovered
          const isDirectory = entry.isDirectory();
          item = new FileItem(
            entry.name,
            isDirectory
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
            filePath,
            // Check parent state ONLY if parent (element) exists and is checked
            // Default to false otherwise. This handles root items and children of unchecked folders.
            element?.isChecked ?? false
          );
          // Add newly discovered items to the map, inheriting checked state from parent (if applicable)
          this.items.set(filePath, item);
          // Should newly discovered items under a checked folder trigger a token recount?
          // Let's say yes, as the effective context changed.
          if (item.isChecked) {
            this.debouncedUpdateTokenCount();
          }
        } else {
          // Item exists in map - update its properties based on file system info
          // but KEEP its existing isChecked state from the map.
          // Create a new item instead of modifying read-only properties
          const isDirectory = entry.isDirectory();
          const newItem = new FileItem(
            entry.name,
            isDirectory
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
            filePath,
            item.isChecked // Keep the existing checked state
          );
          // Copy any other properties as needed
          newItem.tooltip = filePath;
          newItem.description = entry.isFile()
            ? path.extname(filePath)
            : undefined;
          // Replace the item in the map
          this.items.set(filePath, newItem);
          // Update reference for the children array
          item = newItem;
        }
        children.push(item);
      }

      // --- Sorting ---
      children.sort((a, b) => {
        // Folders before files
        const aIsFolder =
          a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
        const bIsFolder =
          b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
        if (aIsFolder !== bIsFolder) {
          return aIsFolder ? -1 : 1;
        }
        // Then sort alphabetically by label
        return a.label.localeCompare(b.label);
      });

      return children;
    } catch (error: any) {
      // Avoid spamming errors for common issues like permission denied
      if (
        error.code !== "EACCES" &&
        error.code !== "EPERM" &&
        error.code !== "ENOENT"
      ) {
        console.error(
          `Error reading directory for getChildren: ${dirPath}`,
          error
        );
        vscode.window.showErrorMessage(
          `Cannot read directory: ${path.basename(dirPath)}`
        );
      } else if (error.code === "ENOENT" && element) {
        // If the element directory itself doesn't exist, remove it from map
        this.items.delete(element.filePath);
        this.savePersistedState(); // Persist the removal
      }
      return []; // Return empty list on error
    }
  }

  refresh(): void {
    this.items.clear();
    this.loadPersistedState(); // Loads state, potentially changing checked items
    this._onDidChangeTreeData.fire(); // Update the tree view itself
    // START ADD
    this.debouncedUpdateTokenCount(); // Recalculate tokens after refresh completes
    // END ADD
  }

  async toggleAllFiles() {
    const allChecked = Array.from(this.items.values()).every(
      (item) => item.isChecked
    );
    const newState = !allChecked;

    // Update internal state first
    for (const [, item] of this.items) {
      // Consider large files warning here? Might be slow for many files.
      // Let's skip the warning on toggle-all for now.
      item.updateCheckState(newState);
    }

    if (this.persistState) {
      this.savePersistedState();
    }

    // --- Token Count Update ---
    if (!newState) {
      // If toggling OFF
      this.currentTokenCalculationVersion++; // Invalidate any ongoing count *immediately*
      this.totalTokenCount = 0;
      this.isCountingTokens = false;
      this.notifyTokenUpdate(); // Instantly update UI to 0
      console.log("Token count reset to 0 (Toggled all off).");
      // No need to trigger a new calculation, it's already 0.
    } else {
      // If toggling ON, trigger a debounced update
      this.debouncedUpdateTokenCount();
    }

    // Refresh the TreeView UI AFTER updating state and potentially tokens
    this._onDidChangeTreeData.fire(); // Use fire() for full refresh

    // Note: We removed the call to this.refresh() because it was redundant
    // and could potentially interfere with the immediate token reset logic.
    // Firing _onDidChangeTreeData is enough to update the visual checkboxes.
  }

  // Add back the missing toggleCheck method
  async toggleCheck(item: FileItem) {
    let newState = !item.isChecked;
    const originalState = item.isChecked; // Store original state
    let userCancelled = false;

    try {
      // Check file size only when checking ON a FILE
      if (newState && item.contextValue === "file") {
        await this.checkFileSize(item.filePath);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "User cancelled large file selection"
      ) {
        newState = false; // Force state back to unchecked
        userCancelled = true; // Flag cancellation
      }
      // Ignore other errors during checkFileSize
    }

    // Only proceed if the final intended state is different from the original
    if (newState !== originalState || userCancelled) {
      item.updateCheckState(newState); // Update the item's visual state

      let childrenCancelled = false;
      if (item.contextValue === "folder") {
        // Update children state in the map. Returns true if any child was cancelled.
        childrenCancelled = await this.toggleDirectoryChildren(
          item.filePath,
          newState
        );
      }
      // Ensure the toggled item itself is updated in the map
      this.items.set(item.filePath, item);

      this.savePersistedState();

      // Refresh the specific item and its children visually
      this._onDidChangeTreeData.fire(item);

      // Trigger Token Update (only if state wasn't cancelled back to original)
      // Or if children were cancelled (meaning effective selection changed)
      if (newState !== originalState || childrenCancelled) {
        this.debouncedUpdateTokenCount();
      }
    }
  }

  // Add back the needed helper method for toggleCheck
  private async checkFileSize(filePath: string): Promise<void> {
    try {
      const stats = await fs.promises.stat(filePath);
      const fileSizeKB = stats.size / 1024;

      if (fileSizeKB > this.maxFileSizeWarningKB) {
        const proceed = await vscode.window.showWarningMessage(
          `File "${path.basename(filePath)}" is ${Math.round(
            fileSizeKB
          )}KB, which exceeds the warning threshold (${
            this.maxFileSizeWarningKB
          }KB). This may impact performance.`,
          "Select Anyway",
          "Cancel"
        );

        if (proceed !== "Select Anyway") {
          throw new Error("User cancelled large file selection");
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "User cancelled large file selection"
      ) {
        throw error;
      }
      // Silently ignore other errors
    }
  }

  // Add back the missing toggleDirectoryChildren method
  private async toggleDirectoryChildren(
    dirPath: string,
    checked: boolean
  ): Promise<boolean> {
    let userCancelledSomewhere = false; // Track if cancellation happened in this branch

    try {
      // Check if directory exists before reading
      if (!fs.existsSync(dirPath)) {
        console.warn(
          `Directory not found in toggleDirectoryChildren: ${dirPath}`
        );
        return false;
      }
      // Ensure it's actually a directory
      if (!fs.statSync(dirPath).isDirectory()) {
        console.warn(
          `Path is not a directory in toggleDirectoryChildren: ${dirPath}`
        );
        return false;
      }

      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        // Apply exclusion patterns
        if (
          this.excludedPatterns.some((pattern) =>
            this.matchesPattern(entry.name, pattern)
          )
        ) {
          continue;
        }

        const filePath = path.join(dirPath, entry.name);
        let fileSpecificCancellation = false; // Was this specific file cancelled?

        // --- File Size Check (only when checking ON a FILE) ---
        if (checked && entry.isFile()) {
          try {
            await this.checkFileSize(filePath);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "User cancelled large file selection"
            ) {
              fileSpecificCancellation = true; // Mark this file as cancelled by user
              userCancelledSomewhere = true; // Mark that cancellation occurred in this subtree
              // Do NOT continue; we need to process this item below to ensure it's unchecked.
            }
            // Ignore other stat/check errors, proceed as if not cancelled
          }
        }

        // --- Find or Create Item ---
        let item = this.items.get(filePath);
        if (!item) {
          // If item doesn't exist (e.g., new file since last refresh), create it
          item = new FileItem(
            entry.name,
            entry.isDirectory()
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
            filePath,
            // Initial state is the target state *unless* user cancelled this specific file
            fileSpecificCancellation ? false : checked
          );
          this.items.set(filePath, item); // Add to map
        } else {
          // If item exists, update its check state based on target state and cancellation
          item.updateCheckState(fileSpecificCancellation ? false : checked);
          // Ensure the potentially updated item is in the map (redundant if get returned reference, but safe)
          this.items.set(filePath, item);
        }

        // --- Recurse for Directories ---
        if (entry.isDirectory()) {
          // Recursively toggle children and bubble up cancellation status
          const childCancelled = await this.toggleDirectoryChildren(
            filePath,
            checked
          );
          if (childCancelled) {
            // If any descendant was cancelled, mark this branch as cancelled
            userCancelledSomewhere = true;
          }
        }
      } // End for loop
    } catch (error: any) {
      // Log errors but don't prevent processing other items typically
      if (error.code === "EACCES" || error.code === "EPERM") {
        console.warn(
          `Permission error toggling directory children: ${dirPath}`
        );
      } else if (error.code !== "ENOENT") {
        // Ignore 'file not found' if dir deleted during process
        console.error(`Error processing directory children: ${dirPath}`, error);
      }
    }
    // Return whether cancellation happened at this level or below
    return userCancelledSomewhere;
  }

  private loadConfig() {
    const config = vscode.workspace.getConfiguration("promptTower");

    const useGitIgnore = config.get<boolean>("useGitignore", true);
    const manualIgnores = config.get<string[]>("ignore", []);

    // Define standard ignores that are usually good defaults
    const standardIgnores = [".git", "node_modules", ".vscode", "dist", "out"];

    // Combine standard, gitignore (if enabled), and manual ignores
    this.excludedPatterns = [
      ...new Set([
        // Use Set to remove duplicates
        ...standardIgnores,
        ...(useGitIgnore ? this.getGitIgnorePatterns() : []),
        ...manualIgnores.map((p) => p.trim()).filter((p) => p), // Trim and remove empty manual ignores
      ]),
    ];
    console.log("Prompt Tower Excluded Patterns:", this.excludedPatterns);

    this.persistState = config.get<boolean>("persistState", true);
    this.maxFileSizeWarningKB = config.get<number>("maxFileSizeWarningKB", 500);

    const outputFormat = config.get<any>("outputFormat");
    this.blockTemplate = outputFormat?.blockTemplate ?? this.blockTemplate;
    this.blockSeparator = outputFormat?.blockSeparator ?? this.blockSeparator;
    this.outputExtension =
      outputFormat?.outputExtension ?? this.outputExtension;

    const wrapperFormat = config.get<any>("outputFormat.wrapperFormat");
    if (wrapperFormat === null) {
      this.wrapperTemplate = null;
    } else {
      this.wrapperTemplate = wrapperFormat?.template ?? this.wrapperTemplate;
    }

    // NOTE: A listener for configuration changes should ideally be added
    // in extension.ts to call a method here that reloads config and refreshes.
    // For now, config is loaded on startup only.
  }

  // Placeholder for gitignore parsing logic (basic implementation)
  // TODO: Replace with a robust .gitignore parsing library if complex patterns are needed.
  private getGitIgnorePatterns(): string[] {
    const gitignorePath = path.join(this.workspaceRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        return content
          .split(/\r?\n/) // Split lines
          .map((line) => line.trim()) // Trim whitespace
          .filter((line) => line && !line.startsWith("#")); // Remove empty lines and comments
      } catch (e) {
        console.error("Error reading or parsing .gitignore:", e);
        return [];
      }
    }
    return []; // No .gitignore file found
  }

  private loadPersistedState() {
    if (!this.persistState) {
      this.items.clear(); // Clear items if persistence is off
      console.log("Prompt Tower: State persistence is disabled.");
      return;
    }

    const state =
      this.context.globalState.get<Record<string, boolean>>("fileStates");
    this.items.clear(); // Clear current items before loading persisted ones

    if (state) {
      console.log(
        `Prompt Tower: Loading ${
          Object.keys(state).length
        } persisted file states.`
      );
      let loadedCount = 0;
      for (const [filePath, isChecked] of Object.entries(state)) {
        // IMPORTANT: Check if the file/folder still exists before creating an item
        if (fs.existsSync(filePath)) {
          try {
            const stats = fs.statSync(filePath); // Use sync here as it's part of init
            const isDirectory = stats.isDirectory();
            // Create the item based on persisted state
            const item = new FileItem(
              path.basename(filePath),
              isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
              filePath,
              isChecked // Use the persisted checked state
            );
            // Add to the internal map
            this.items.set(filePath, item);
            loadedCount++;
          } catch (e) {
            // Error stating file (permissions?), log and skip
            console.error(`Error stating persisted file ${filePath}:`, e);
          }
        } else {
          // File/folder from state no longer exists, don't load it into `items`
          console.log(
            `Prompt Tower: Persisted item no longer exists, skipping: ${filePath}`
          );
          // Optionally, clean up the persisted state itself here by removing the entry?
          // delete state[filePath]; // Requires updating globalState again later
        }
      }
      console.log(
        `Prompt Tower: Successfully loaded state for ${loadedCount} existing items.`
      );
      // If you implement state cleanup:
      // this.context.globalState.update("fileStates", state);
    } else {
      console.log("Prompt Tower: No persisted state found.");
    }
    // DO NOT trigger token update here. The constructor calls it *after* this method runs.
  }

  private savePersistedState() {
    if (!this.persistState) {
      // If persistence was turned off, ensure the stored state is cleared.
      this.context.globalState.update("fileStates", undefined);
      return;
    }

    const state: Record<string, boolean> = {};
    let persistedCount = 0;
    // Iterate over the *current* items in the map
    this.items.forEach((item, filePath) => {
      // Persist state ONLY if the item still exists on disk
      // This prevents persisting state for items deleted during the session
      if (fs.existsSync(filePath)) {
        state[filePath] = item.isChecked;
        persistedCount++;
      }
    });

    // Update the global state
    this.context.globalState.update("fileStates", state);
    // console.log(`Prompt Tower: Saved state for ${persistedCount} items.`); // Optional log
  }

  getCheckedFiles(): string[] {
    // Filter based on map state AND ensure file exists on disk at time of check
    return Array.from(this.items.values())
      .filter(
        (item) =>
          item.isChecked &&
          item.contextValue === "file" &&
          fs.existsSync(item.filePath)
      )
      .map((item) => item.filePath);
  }

  // Basic pattern matching (for excludes).
  // TODO: Replace with a proper library like 'ignore' for full gitignore syntax support.
  private matchesPattern(fileName: string, pattern: string): boolean {
    if (!pattern) return false;

    // Simple exact match
    if (fileName === pattern) return true;

    // Simple folder match (e.g., "node_modules/")
    if (pattern.endsWith("/") && fileName === pattern.slice(0, -1)) return true;

    // Basic wildcard support (e.g., *.log) - limited
    if (pattern.startsWith("*.")) {
      return fileName.endsWith(pattern.substring(1));
    }

    // Add more basic cases if needed, but recommend a library.
    return false;
  }

  async generateFile() {
    const checkedFiles = this.getCheckedFiles();
    if (checkedFiles.length === 0) {
      vscode.window.showWarningMessage("No files selected!");
      return;
    }
    // Get file count early for potential use in wrapper
    const fileCount = checkedFiles.length;

    const fileNameRaw = // Use separate variable for input name
      (await vscode.window.showInputBox({
        prompt: "Enter output file name (without extension)",
        placeHolder: "context",
        validateInput: (value) =>
          value?.includes(".") ? "No extensions allowed" : null,
      })) || "context";

    try {
      // Prepare final filename and path using configured extension
      const outputFileNameWithExtension = `${fileNameRaw}.${this.outputExtension}`;
      const outputPath = path.join(
        this.workspaceRoot,
        outputFileNameWithExtension
      );

      // Process each checked file concurrently using the blockTemplate
      const fileBlockPromises = checkedFiles.map(async (fullFilePath) => {
        // Calculate necessary paths and names
        const relativePath = path.relative(this.workspaceRoot, fullFilePath); // e.g., src/database.js
        const fileNameWithExtension = path.basename(fullFilePath);
        const fileExtension = path.extname(fullFilePath);
        const fileName = path.basename(fullFilePath, fileExtension);

        // Read file content
        const fileContent = await fs.promises.readFile(fullFilePath, "utf8");

        // --- Apply Block Template Placeholders ---
        let formattedBlock = this.blockTemplate;

        // *** FIX START ***
        // Ensure relativePath starts with '/' if needed for the <source> tag
        const sourcePath = "/" + relativePath.replace(/\\/g, "/"); // Ensure forward slashes and leading slash

        formattedBlock = formattedBlock.replace(
          /{fileNameWithExtension}/g,
          fileNameWithExtension
        );
        // Replace {rawFilePath} with the calculated relative path (with leading slash)
        formattedBlock = formattedBlock.replace(/{rawFilePath}/g, sourcePath);
        // *** FIX END ***

        // Other placeholders (if they exist in your actual template - some are not in the default)
        // formattedBlock = formattedBlock.replace(/{filePath}/g, commentedFilePath); // REMOVE or keep ONLY if you ALSO use {filePath}
        formattedBlock = formattedBlock.replace(/{fileName}/g, fileName);
        formattedBlock = formattedBlock.replace(
          /{fileExtension}/g,
          fileExtension
        );
        formattedBlock = formattedBlock.replace(/{fullPath}/g, fullFilePath); // Keep if {fullPath} is ever used

        // Replace fileContent last to avoid issues if content contains placeholders
        formattedBlock = formattedBlock.replace(/{fileContent}/g, fileContent);

        return formattedBlock;
      });

      // Wait for all file processing to complete
      const contents = await Promise.all(fileBlockPromises);

      // --- Join the processed blocks ---
      const joinedBlocks = contents.join(this.blockSeparator);

      // --- Apply the Wrapper Template (if enabled) ---
      let finalOutput: string;
      if (this.wrapperTemplate) {
        finalOutput = this.wrapperTemplate; // Start with the wrapper template

        // Calculate values needed for wrapper placeholders
        const timestamp = new Date().toISOString(); // Use ISO format

        // Replace placeholders in the wrapper template
        finalOutput = finalOutput.replace(/{blocks}/g, joinedBlocks);
        finalOutput = finalOutput.replace(/{timestamp}/g, timestamp);
        finalOutput = finalOutput.replace(/{fileCount}/g, String(fileCount));
        finalOutput = finalOutput.replace(
          /{workspaceRoot}/g,
          this.workspaceRoot
        );
        finalOutput = finalOutput.replace(
          /{outputFileName}/g,
          outputFileNameWithExtension
        );
      } else {
        // No wrapper template defined, use joined blocks directly
        finalOutput = joinedBlocks;
      }

      // --- Write the final combined output ---
      await fs.promises.writeFile(outputPath, finalOutput);

      // --- Open the generated file ---
      const doc = await vscode.workspace.openTextDocument(outputPath);
      await vscode.window.showTextDocument(doc);
    } catch (error) {
      // Standard error handling
      vscode.window.showErrorMessage(
        `Error generating file: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }
}
