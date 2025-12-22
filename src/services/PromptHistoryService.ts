import * as vscode from "vscode";

/**
 * A single prompt history entry
 */
export interface PromptHistoryEntry {
  text: string;
  workspaceName: string;
  workspacePath: string;
  timestamp: number;
}

/**
 * QuickPick item with history entry metadata
 */
export interface PromptHistoryQuickPickItem extends vscode.QuickPickItem {
  entry?: PromptHistoryEntry;
}

export type PromptType = "prefix" | "suffix";

const STORAGE_KEYS = {
  prefix: "promptTower.prefixHistory",
  suffix: "promptTower.suffixHistory",
} as const;

/**
 * Service for managing prompt prefix/suffix history
 * - Stores history per-workspace but allows viewing across workspaces
 * - Separate histories for prefix and suffix
 * - Auto-deduplicates entries
 */
export class PromptHistoryService {
  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Add a prompt to history if it has content
   * Returns true if added, false if empty or duplicate
   */
  addToHistory(
    type: PromptType,
    text: string,
    workspaceName: string,
    workspacePath: string
  ): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const history = this.getHistory(type);

    // Check for duplicate in same workspace
    const existingIndex = history.findIndex(
      (entry) => entry.text === trimmed && entry.workspacePath === workspacePath
    );

    if (existingIndex !== -1) {
      // Move to front (most recent) by removing and re-adding
      history.splice(existingIndex, 1);
    }

    // Add new entry at the beginning
    const entry: PromptHistoryEntry = {
      text: trimmed,
      workspaceName,
      workspacePath,
      timestamp: Date.now(),
    };

    history.unshift(entry);

    // Save updated history
    this.saveHistory(type, history);
    return true;
  }

  /**
   * Save both prefix and suffix if they have content
   */
  savePrompts(
    prefix: string,
    suffix: string,
    workspaceName: string,
    workspacePath: string
  ): { prefixSaved: boolean; suffixSaved: boolean } {
    return {
      prefixSaved: this.addToHistory("prefix", prefix, workspaceName, workspacePath),
      suffixSaved: this.addToHistory("suffix", suffix, workspaceName, workspacePath),
    };
  }

  /**
   * Get history entries for QuickPick display
   * Groups by: current workspace first, then other workspaces
   */
  getQuickPickItems(
    type: PromptType,
    currentWorkspacePath: string
  ): PromptHistoryQuickPickItem[] {
    const history = this.getHistory(type);
    const items: PromptHistoryQuickPickItem[] = [];

    // Separate current workspace vs others
    const currentWorkspaceEntries = history.filter(
      (e) => e.workspacePath === currentWorkspacePath
    );
    const otherEntries = history.filter(
      (e) => e.workspacePath !== currentWorkspacePath
    );

    // Current workspace section
    if (currentWorkspaceEntries.length > 0) {
      items.push({
        label: "Current Workspace",
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const entry of currentWorkspaceEntries) {
        items.push(this.entryToQuickPickItem(entry));
      }
    }

    // Other workspaces section
    if (otherEntries.length > 0) {
      items.push({
        label: "Other Workspaces",
        kind: vscode.QuickPickItemKind.Separator,
      });

      // Group by workspace
      const byWorkspace = new Map<string, PromptHistoryEntry[]>();
      for (const entry of otherEntries) {
        const existing = byWorkspace.get(entry.workspacePath) || [];
        existing.push(entry);
        byWorkspace.set(entry.workspacePath, existing);
      }

      for (const [, entries] of byWorkspace) {
        for (const entry of entries) {
          items.push(this.entryToQuickPickItem(entry, true));
        }
      }
    }

    return items;
  }

  /**
   * Check if history is empty for a given type
   */
  isEmpty(type: PromptType): boolean {
    return this.getHistory(type).length === 0;
  }

  /**
   * Get raw history array
   */
  private getHistory(type: PromptType): PromptHistoryEntry[] {
    return this.context.globalState.get<PromptHistoryEntry[]>(
      STORAGE_KEYS[type],
      []
    );
  }

  /**
   * Save history array
   */
  private saveHistory(type: PromptType, history: PromptHistoryEntry[]): void {
    this.context.globalState.update(STORAGE_KEYS[type], history);
  }

  /**
   * Convert history entry to QuickPick item
   */
  private entryToQuickPickItem(
    entry: PromptHistoryEntry,
    showWorkspace: boolean = false
  ): PromptHistoryQuickPickItem {
    // Truncate long text for display
    const maxLength = 60;
    const displayText =
      entry.text.length > maxLength
        ? entry.text.substring(0, maxLength) + "..."
        : entry.text;

    // Format relative time
    const relativeTime = this.getRelativeTime(entry.timestamp);

    let description = relativeTime;
    if (showWorkspace) {
      description = `${entry.workspaceName} · ${relativeTime}`;
    }

    return {
      label: displayText.replace(/\n/g, " "), // Single line
      description,
      entry,
    };
  }

  /**
   * Format timestamp as relative time (e.g., "2 hours ago")
   */
  private getRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    if (hours < 24) {
      return `${hours}h ago`;
    }
    if (days < 7) {
      return `${days}d ago`;
    }

    return new Date(timestamp).toLocaleDateString();
  }
}
