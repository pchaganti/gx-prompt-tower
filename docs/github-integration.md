# Prompt Tower: GitHub Integration

Prompt Tower integrates with GitHub to pull in issues and PR diffs directly into your context.

---

## GitHub Issues

### What This Does

Include relevant issues alongside your code when creating context for AI coding assistants. Instead of manually copying issue descriptions into chat, select the issues you're working on and they automatically become part of your generated context.

This is particularly useful when:

- Working on bug fixes where the issue contains reproduction steps or user feedback
- Implementing features where the issue has detailed requirements or design decisions
- Getting AI help with code reviews where issues provide background context
- Debugging problems where similar issues contain relevant discussion

## How to Use It

### Basic Usage

1. **Open the GitHub Issues panel** in your Prompt Tower sidebar (appears automatically for GitHub repositories)
2. **Click to expand** the issues list - this loads your repository's open issues
3. **Select relevant issues** using the checkboxes next to each issue
4. **Generate context** as usual - selected issues will be included before your file selections

The integration detects your repository automatically from your git remote URL. No configuration needed for public repositories.

### Generated Context Format

Selected issues are formatted as structured blocks in your context:

```xml
<github_issue number="123" state="open">
  <title>Add dark mode toggle to settings page</title>
  <body>
    Users have requested the ability to switch between light and dark themes...

    Acceptance criteria:
    - Toggle switch in settings
    - Persists user preference
    - Affects all UI components
  </body>
  <comments>
    <!-- All issue comments included -->
  </comments>
</github_issue>
```

This gives AI assistants complete context about what you're building and why.

---

## GitHub Pull Requests

### What This Does

GitHub PR integration lets you include the raw diff from any open pull request in your context. This is useful when:

- Reviewing PRs and wanting AI assistance understanding the changes
- Working on a PR and needing help with related code
- Debugging issues introduced in a specific PR
- Getting AI help to write PR descriptions or review comments

### How to Use It

1. **Open the GitHub PRs panel** in your Prompt Tower sidebar (appears above GitHub Issues)
2. **Click to expand** the PR list - this loads your repository's open PRs
3. **Select relevant PRs** using the checkboxes
4. **Generate context** - the raw diff from each selected PR is included

### Generated Context Format

Selected PRs include the raw unified diff:

```xml
<github_pr number="123">
diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index abc123..def456 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,5 +1,7 @@
+import { useTheme } from '../hooks/useTheme';
+
 export function Button({ children }) {
+  const theme = useTheme();
   return (
-    <button className="btn">
+    <button className={theme.button}>
       {children}
     </button>
   );
 }
</github_pr>
```

The diff is fetched directly from GitHub's `.diff` endpoint (e.g., `https://github.com/owner/repo/pull/123.diff`).

---

## Authentication

### When You Need It

- **Private repositories**: Authentication required to access issues and PR diffs
- **Heavy usage**: Rate limits kick in after ~60 unauthenticated requests per hour
- **Team repositories**: Some organizations require authentication for any API access

Get your PAT from the GitHub Settings, read here: [Docs for PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic)

You can see your tokens in GitHub Settings, under Developer settings -> Personal access tokens.
[Settings](https://github.com/settings/tokens)

### Setting Up Authentication

1. **Run the command**: `Prompt Tower: Add GitHub Token` from VS Code's Command Palette (Cmd/Ctrl+Shift+P)
2. **Generate a token**: You'll need a GitHub Personal Access Token with `repo` scope
   - Go to GitHub Settings → Developer settings → Personal access tokens
   - Create a new token with `repo` permission
3. **Enter your token**: Paste it into the secure input field (tokens are stored locally and never shared)

Once authenticated, you get 5,000 API requests per hour instead of 60.

## Current Limitations

**Issues**:
- No filtering by label, assignee, or milestone yet
- Shows the 100 most recent open issues

**Pull Requests**:
- Shows the 100 most recent open PRs
- Large diffs may use significant tokens
