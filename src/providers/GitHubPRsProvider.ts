import * as vscode from "vscode";
import { GitHubApiClient, GitHubPullRequest as ApiPullRequest } from "../api/GitHubApiClient";
import { GitHubConfigManager } from "../utils/githubConfig";
import { encode } from "gpt-tokenizer";

export class GitHubPR extends vscode.TreeItem {
  constructor(
    public readonly title: string,
    public readonly number: number,
    public readonly state: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly isSpecialItem: boolean = false
  ) {
    super(title, collapsibleState);

    if (isSpecialItem) {
      this.label = title;
      this.contextValue = "githubSpecialItem";
      this.iconPath = new vscode.ThemeIcon(this.getSpecialIcon());
    } else {
      this.label = `#${number}: ${title}`;
      this.tooltip = `PR #${number}: ${title} (${state})`;
      this.contextValue = "githubPR";
      this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      this.iconPath = new vscode.ThemeIcon("git-pull-request");
    }
  }

  private getSpecialIcon(): string {
    switch (this.state) {
      case "loading": return "loading~spin";
      case "error": return "error";
      case "info": return "info";
      case "auth": return "lock";
      default: return "circle-slash";
    }
  }
}

interface CachedPRData {
  pr: ApiPullRequest;
  diff: string;
  tokenCount: number;
  fetchedAt: Date;
}

export interface PRTokenUpdate {
  totalTokens: number;
  selectedCount: number;
  isCounting: boolean;
}

export class GitHubPRsProvider implements vscode.TreeDataProvider<GitHubPR> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GitHubPR | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<GitHubPR | undefined | void> = this._onDidChangeTreeData.event;

  private _onDidChangeTokens = new vscode.EventEmitter<PRTokenUpdate>();
  readonly onDidChangeTokens: vscode.Event<PRTokenUpdate> = this._onDidChangeTokens.event;

  private prs: GitHubPR[] = [];
  private loaded = false;
  private isLoading = false;
  private errorMessage?: string;
  private selectedPRs = new Set<number>();
  private apiClient?: GitHubApiClient;
  private repoInfo?: { owner: string; repo: string };

  private prCache = new Map<number, CachedPRData>();
  private totalPRTokens = 0;
  private activeFetches = new Set<number>();

  constructor(
    private context: vscode.ExtensionContext,
    private workspaceRoot: string
  ) {}

  getTreeItem(element: GitHubPR): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GitHubPR): Promise<GitHubPR[]> {
    if (!element) {
      if (!this.loaded && !this.isLoading) {
        await this.loadPRs();
      }

      if (this.isLoading) {
        return [new GitHubPR("Loading PRs...", -1, "loading", vscode.TreeItemCollapsibleState.None, true)];
      }

      if (this.errorMessage) {
        const isAuthError = this.errorMessage.includes("🔒") || this.errorMessage.includes("🔑");
        const state = isAuthError ? "auth" : "error";
        const collapsibleState = isAuthError ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
        return [new GitHubPR(this.errorMessage, -1, state, collapsibleState, true)];
      }

      if (this.prs.length === 0) {
        return [new GitHubPR("No open PRs", -1, "info", vscode.TreeItemCollapsibleState.None, true)];
      }

      return this.prs;
    }

    if (element.isSpecialItem && element.state === "auth") {
      return [new GitHubPR("💡 Cmd/Ctrl+Shift+P → Prompt Tower: Add GitHub Token", -2, "info", vscode.TreeItemCollapsibleState.None, true)];
    }

    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadPRs(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = undefined;
    this.refresh();

    try {
      if (!this.repoInfo) {
        const detected = await GitHubConfigManager.detectRepoInfo(this.workspaceRoot);
        if (!detected || !detected.isGitHub) {
          this.errorMessage = "Not a GitHub repository";
          return;
        }
        this.repoInfo = { owner: detected.owner, repo: detected.repo };
      }

      if (!this.apiClient) {
        this.apiClient = new GitHubApiClient(
          this.context,
          this.repoInfo.owner,
          this.repoInfo.repo
        );
        await this.apiClient.initialize();
      }

      const apiPRs = await this.apiClient.listPullRequests('open', 100);

      this.prs = apiPRs.map((pr: ApiPullRequest) => {
        const treeItem = new GitHubPR(
          pr.title,
          pr.number,
          pr.state,
          vscode.TreeItemCollapsibleState.None
        );

        treeItem.checkboxState = this.selectedPRs.has(pr.number) ?
          vscode.TreeItemCheckboxState.Checked :
          vscode.TreeItemCheckboxState.Unchecked;

        return treeItem;
      });

      if (apiPRs.length === 100) {
        this.prs.push(
          new GitHubPR(
            "Showing 100 most recent PRs",
            -1,
            "info",
            vscode.TreeItemCollapsibleState.None,
            true
          )
        );
      }

    } catch (error: any) {
      if (error.status === 404) {
        const hasToken = await this.hasValidToken();
        if (!hasToken) {
          this.errorMessage = "🔒 Private repository - authentication required";
        } else {
          this.errorMessage = "Repository not found";
        }
      } else if (error.status === 401) {
        this.errorMessage = "🔑 Invalid GitHub token. Please add a valid token.";
      } else if (error.status === 403) {
        this.errorMessage = "🔒 Rate limit exceeded. Add token for higher limits.";
      } else if (error.message) {
        this.errorMessage = error.message;
      } else {
        this.errorMessage = "Failed to load PRs";
      }
      console.error("Error loading GitHub PRs:", error);
    } finally {
      this.loaded = true;
      this.isLoading = false;
      this.refresh();
    }
  }

  async reloadPRs(): Promise<void> {
    this.loaded = false;
    this.prs = [];
    this.prCache.clear();
    this.selectedPRs.clear();
    this.apiClient = undefined;
    this.updateTokenCount();
    await this.loadPRs();
  }

  async togglePRSelection(pr: GitHubPR): Promise<void> {
    if (pr.isSpecialItem || pr.number < 0) {
      return;
    }

    if (this.selectedPRs.has(pr.number)) {
      this.selectedPRs.delete(pr.number);
      pr.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      this.updateTokenCount();
    } else {
      this.selectedPRs.add(pr.number);
      pr.checkboxState = vscode.TreeItemCheckboxState.Checked;
      this.updateTokenCount();
      await this.fetchAndCachePRDiff(pr.number);
    }

    this._onDidChangeTreeData.fire(pr);
  }

  clearAllSelections(): void {
    if (this.selectedPRs.size === 0) {
      return;
    }

    this.selectedPRs.clear();

    for (const pr of this.prs) {
      if (!pr.isSpecialItem && pr.checkboxState !== undefined) {
        pr.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      }
    }

    this.updateTokenCount();
    this._onDidChangeTreeData.fire();
  }

  private calculatePRTokens(diff: string): number {
    const tokens = encode(diff);
    return tokens.length;
  }

  private updateTokenCount(): void {
    this.totalPRTokens = 0;

    for (const prNumber of this.selectedPRs) {
      const cached = this.prCache.get(prNumber);
      if (cached) {
        this.totalPRTokens += cached.tokenCount;
      }
    }

    this._onDidChangeTokens.fire({
      totalTokens: this.totalPRTokens,
      selectedCount: this.selectedPRs.size,
      isCounting: this.activeFetches.size > 0
    });
  }

  private async fetchAndCachePRDiff(prNumber: number): Promise<CachedPRData | null> {
    const cached = this.prCache.get(prNumber);
    if (cached) {
      return cached;
    }

    if (this.activeFetches.has(prNumber)) {
      return null;
    }

    if (!this.apiClient) {
      console.error('GitHub API client not initialized');
      return null;
    }

    try {
      this.activeFetches.add(prNumber);
      this.updateTokenCount();

      const diff = await this.apiClient.getPullRequestDiff(prNumber);
      const tokenCount = this.calculatePRTokens(diff);

      // Find the PR in our list to get its metadata
      const prItem = this.prs.find(p => p.number === prNumber);
      const pr: ApiPullRequest = {
        number: prNumber,
        title: prItem?.title || `PR #${prNumber}`,
        state: (prItem?.state as 'open' | 'closed') || 'open',
        html_url: `https://github.com/${this.repoInfo?.owner}/${this.repoInfo?.repo}/pull/${prNumber}`
      };

      const data: CachedPRData = {
        pr,
        diff,
        tokenCount,
        fetchedAt: new Date()
      };

      this.prCache.set(prNumber, data);

      return data;

    } catch (error) {
      console.error(`Failed to fetch PR #${prNumber} diff:`, error);
      return null;
    } finally {
      this.activeFetches.delete(prNumber);
      this.updateTokenCount();
    }
  }

  async getSelectedPRDetails(): Promise<Map<number, { pr: ApiPullRequest; diff: string }>> {
    const details = new Map<number, { pr: ApiPullRequest; diff: string }>();

    for (const prNumber of this.selectedPRs) {
      const cached = this.prCache.get(prNumber);
      if (cached) {
        details.set(prNumber, {
          pr: cached.pr,
          diff: cached.diff
        });
      }
    }

    return details;
  }

  getCurrentTokenStatus(): PRTokenUpdate {
    return {
      totalTokens: this.totalPRTokens,
      selectedCount: this.selectedPRs.size,
      isCounting: this.activeFetches.size > 0
    };
  }

  private async hasValidToken(): Promise<boolean> {
    try {
      const token = await GitHubConfigManager.getPAT(this.context);
      return !!token;
    } catch {
      return false;
    }
  }
}
