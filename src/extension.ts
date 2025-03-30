import * as vscode from "vscode";
import { PromptTowerProvider } from "./providers/PromptTowerProvider";
import { registerCommands } from "./commands";
import { FileItem } from "./models/FileItem";
import { TokenUpdateEmitter, TokenUpdatePayload } from "./models/EventEmitter";

// --- Webview Panel Handling ---
let webviewPanel: vscode.WebviewPanel | undefined;
const VIEW_TYPE = "promptTowerUI"; // Unique identifier for the webview panel

// --- Shared State/Communication ---
const tokenUpdateEmitter = new TokenUpdateEmitter();

// --- Reference to the provider instance ---
let providerInstance: PromptTowerProvider | undefined;

// --- Flag to track if preview needs invalidation ---
let isPreviewValid = false;

// --- Helper to send invalidate message ---
function invalidateWebviewPreview() {
  if (webviewPanel && isPreviewValid) {
    console.log("Extension: Sending invalidatePreview to webview.");
    webviewPanel.webview.postMessage({ command: "invalidatePreview" });
    isPreviewValid = false; // Mark as invalidated
  }
}

// Generates a random nonce string for Content Security Policy
function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Generates the HTML content for the Webview Panel
 *
 * @TODO:
 * - the preview text area invalidation style is not perfect.
 *
 *
 * @param webview
 * @param extensionUri
 * @param initialPrefix
 * @param initialSuffix
 * @returns
 */

// Generates the HTML content for the Webview Panel
function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  initialPrefix: string = "",
  initialSuffix: string = ""
): string {
  const nonce = getNonce();
  const styles = `
        body {
            padding: 1em;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.4;
            /* Add these if not already present or modify existing */
            display: flex;
            flex-direction: column;
            height: 100vh; /* Use full viewport height */
            box-sizing: border-box;
        }
        h1 {
            margin-top: 0;
            font-size: 1.5em; /* Adjust as needed */
            border-bottom: 1px solid var(--vscode-separator-foreground);
            padding-bottom: 0.3em;
            margin-bottom: 0.8em;
        }
        #token-info {
            margin-bottom: 15px;
            padding: 10px 12px;
            border: 1px solid var(--vscode-editorWidget-border, #ccc);
            border-radius: 4px;
            background-color: var(--vscode-editorWidget-background, #f0f0f0);
            display: flex; /* Use flexbox for alignment */
            align-items: center; /* Vertically align items */
            gap: 8px; /* Space between items */
            margin-bottom: 1em; /* Add margin below token info */
            flex-shrink: 0; /* Prevent token info from shrinking */
        }
        #token-count {
            font-weight: bold;
            font-size: 1.1em; /* Make count slightly larger */
            color: var(--vscode-charts-blue); /* Use a theme color */
        }
        #token-status {
            font-style: italic;
            color: var(--vscode-descriptionForeground, #777);
            flex-grow: 1; /* Allow status to take remaining space */
        }
        .spinner {
            display: inline-block;
            width: 1em; /* Size relative to font */
            height: 1em;
            border: 2px solid currentColor; /* Use text color */
            border-right-color: transparent; /* Hide one side for spin effect */
            border-radius: 50%;
            animation: spinner-border .75s linear infinite;
            vertical-align: middle; /* Align better with text */
            opacity: 0; /* Hidden by default */
            transition: opacity 0.2s ease-in-out;
            margin-left: 5px;
        }
        .spinner.visible {
            opacity: 1; /* Show when counting */
        }
        @keyframes spinner-border {
            to { transform: rotate(360deg); }
        }
        hr {
            border: none;
            border-top: 1px solid var(--vscode-separator-foreground);
            margin: 1em 0; /* Adjusted margin */
            width: 100%;
            flex-shrink: 0; /* Prevent hr from shrinking */
        }
        button {
             /* Use VS Code button styles */
             color: var(--vscode-button-foreground);
             background-color: var(--vscode-button-background);
             border: 1px solid var(--vscode-button-border, transparent);
             padding: 5px 10px;
             cursor: pointer;
             border-radius: 2px;
        }
        button:hover {
             background-color: var(--vscode-button-hoverBackground);
        }
        button:active {
             background-color: var(--vscode-button-background); /* Or a slightly darker variant */
        }
        .textarea-container {
          margin-bottom: 20px;
          display: flex;
          flex-direction: column;
        }
        label {
          margin-bottom: 0.4em;
          font-weight: bold;
          color: var(--vscode-descriptionForeground);
        }
        textarea {
          /* Use VS Code text area styles */
          width: 100%; /* Take full width */
          box-sizing: border-box; /* Include padding/border in width */
          padding: 8px;
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-input-foreground);
          background-color: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder));
          border-radius: 2px;
          min-height: 80px; /* Minimum height */
          resize: vertical; /* Allow vertical resize */
        }
        #prompt-prefix-container textarea:focus,
        #prompt-suffix-container textarea:focus {
          outline: 1px solid var(--vscode-focusBorder);
          outline-offset: -1px;
          border-color: var(--vscode-focusBorder);
        }
        /* Ensure text areas take available space */
        #prompt-prefix-container,
        #prompt-suffix-container {
          /* Define flex grow/shrink/basis if needed for more complex layouts */
          min-height: 100px; /* Give them some initial height */
        }
        #prompt-prefix,
        #prompt-suffix {
          flex-grow: 1; /* Allow textareas to grow */
        }
        #action-button-container {
          margin-top: 1em; /* Adjusted spacing */
          margin-bottom: 1em; /* Added margin below button */
          flex-shrink: 0; /* Prevent button container from shrinking */
        }

        #preview-container {
            display: flex;
            flex-direction: column;
            flex-grow: 1; /* Allow preview to take remaining space */
            min-height: 0; /* Allow shrinking below intrinsic size */
            margin-top: 0px; /* Remove extra top margin */
            border-top: 1px solid var(--vscode-separator-foreground); /* Optional separator */
            padding-top: 1em; /* Spacing above label */
        }
        #context-preview {
            flex-grow: 1; /* Textarea takes up available space in its container */
            height: 256px; /* Initial desired height */
            min-height: 100px; /* Minimum height */
            border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder));
            border-color: var(--vscode-input-border, var(--vscode-contrastBorder)) !important;
            background-color: var(--vscode-editorWidget-background,  var(--vscode-input-background)) !important;
            color: var(--vscode-input-foreground) !important;
            overflow-y: auto; /* Add scrollbar if content exceeds height */
            white-space: pre-wrap; /* Respect whitespace and wrap lines */
            word-wrap: break-word; /* Break long words */
            font-family: var(--vscode-editor-font-family, monospace); /* Use editor font */
        }
        #preview-status {
          font-size: 0.9em;
          color: var(--vscode-descriptionForeground);
          margin-top: 5px;
          min-height: 1.2em; /* Reserve space for status */
        }

        
        #preview-container.invalidated #context-preview,
        #preview-container.invalidated #context-preview:focus,
        #preview-container.invalidated #context-preview:hover,
        #preview-container.invalidated #context-preview:active {
          border: 1px solid var(--vscode-input-border, var(--vscode-inputValidation-warningForeground, orange)) !important;
          border-color: var(--vscode-inputValidation-warningForeground, orange) !important;
        }
        #preview-container.invalidated #preview-status {
            color: var(--vscode-inputValidation-warningForeground, orange);
        }
        /* --- END PREVIEW STYLES --- */
    `;

  return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="
                default-src 'none';
                style-src ${webview.cspSource} 'unsafe-inline';
                img-src ${webview.cspSource} https: data:;
                script-src 'nonce-${nonce}';
            ">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Prompt Tower UI</title>
            <style nonce="${nonce}">${styles}</style>
        </head>
        <body>
            <h1>Prompt Tower</h1>

             <div id="token-info">
                <span>Selected Tokens:</span>
                <span id="token-count">0</span>
                <div id="spinner" class="spinner"></div>
                <span id="token-status"></span>
            </div>

            <div style="width: 100%; height: 5px; background-color: var(--vscode-editorWidget-border); margin-bottom: 20px;"></div>

            <div id="prompt-prefix-container" class="textarea-container">
              <label for="prompt-prefix">Prompt Prefix (Prepended to export)</label>
              <textarea id="prompt-prefix">${initialPrefix}</textarea>
            </div>

            <div id="prompt-suffix-container" class="textarea-container">
              <label for="prompt-suffix">Prompt Suffix (Appended to export)</label>
              <textarea id="prompt-suffix">${initialSuffix}</textarea>
            </div>

            <p>Additional controls and prompt preview will go here.</p>
            <div id="action-button-container">
              <button id="copyButton">Create Context and Copy to Clipboard</button>
            </div>

            <div id="preview-container">
                <label for="context-preview">Context Preview</label>
                <textarea id="context-preview"></textarea>
                <span id="preview-status">Click "Create Context..." to generate preview.</span>
            </div>
            <script nonce="${nonce}">
                (function() {
                    const vscode = acquireVsCodeApi(); // Get VS Code API access
                    const state = vscode.getState() || {};

                    // --- Get references to elements ---
                    const tokenCountElement = document.getElementById('token-count');
                    const tokenStatusElement = document.getElementById('token-status');
                    const spinnerElement = document.getElementById('spinner');
                    const prefixTextArea = document.getElementById("prompt-prefix");
                    const suffixTextArea = document.getElementById("prompt-suffix");
                    const copyButton = document.getElementById('copyButton');
                    
                    // --- NEW PREVIEW ELEMENTS ---
                    const previewContainer = document.getElementById("preview-container");
                    const previewTextArea = document.getElementById("context-preview");
                    const previewStatusElement = document.getElementById("preview-status");

                    // --- State for preview validity ---
                    let isPreviewContentValid = false; // Track if the *content* in the preview is current
                    let currentValidContext = null;   // Store the last known valid context string

                    // --- Restore state if available ---
                    if (prefixTextArea && state.promptPrefix) {
                      prefixTextArea.value = state.promptPrefix;
                    }
                    if (suffixTextArea && state.promptSuffix) {
                      suffixTextArea.value = state.promptSuffix;
                    }

                    // --- Event Listener for Messages from Extension ---
                    window.addEventListener('message', event => {
                        const message = event.data; // The JSON data sent from the extension

                        switch (message.command) {
                            case 'tokenUpdate':
                                if (message.payload && tokenCountElement && tokenStatusElement && spinnerElement) {
                                    const { count, isCounting } = message.payload;

                                    // Format large numbers with commas
                                    tokenCountElement.textContent = count.toLocaleString();

                                    if (isCounting) {
                                        tokenStatusElement.textContent = '(Calculating...)';
                                        spinnerElement.classList.add('visible');
                                    } else {
                                        tokenStatusElement.textContent = ''; // Clear status text
                                        spinnerElement.classList.remove('visible');
                                    }
                                }
                                break;
                            // Add other command handlers here if needed in the future
                            // case 'someOtherCommand':
                            //    // ... handle other commands ...
                            //    break;

                            // Handle initial/updated prefix/suffix from extension
                            case 'updatePrefix':
                                if (prefixTextArea && typeof message.text === 'string') {
                                    prefixTextArea.value = message.text;
                                    // Update state
                                    state.promptPrefix = message.text;
                                    vscode.setState(state);
                                }
                                break;
                            case 'updateSuffix':
                                 if (suffixTextArea && typeof message.text === 'string') {
                                    suffixTextArea.value = message.text;
                                     // Update state
                                     state.promptSuffix = message.text;
                                     vscode.setState(state);
                                }
                                break;

                            // --- NEW MESSAGE HANDLERS ---
                            case "updatePreview":
                                if (message.payload && typeof message.payload.context === "string") {
                                    validatePreviewState(message.payload.context);
                                }
                                break;
                            case "invalidatePreview":
                                invalidatePreviewState("extension");
                                break;
                            // --- END NEW MESSAGE HANDLERS ---
                        }
                    });

                    // --- Event Listeners for Text Area Input ---
                    if (prefixTextArea) {
                      prefixTextArea.addEventListener("input", (e) => {
                        const text = e.target.value;
                        vscode.postMessage({ command: "updatePrefix", text: text });
                        state.promptPrefix = text;
                        vscode.setState(state);
                        invalidatePreviewState("extension");
                      });
                    }
                    if (suffixTextArea) {
                      suffixTextArea.addEventListener("input", (e) => {
                        const text = e.target.value;
                        vscode.postMessage({ command: "updateSuffix", text: text });
                        state.promptSuffix = text;
                        vscode.setState(state);
                        invalidatePreviewState("extension");
                      });
                    }
                    // --- NEW: Add input listener for the preview text area ---
                    if (previewTextArea) {
                      previewTextArea.addEventListener("input", (e) => {
                        const currentValue = e.target.value;
                        // Check if there's a known valid context and if the current value matches it
                        if (currentValidContext !== null && currentValue === currentValidContext) {
                           // User typed/pasted the exact valid content back
                           previewContainer.classList.remove("invalidated");
                           previewStatusElement.textContent = "Preview matches last generated content.";
                           isPreviewContentValid = true;
                        } else {
                           // User typed something different, or no valid context exists yet
                           previewContainer.classList.add("invalidated");
                           previewStatusElement.textContent = currentValidContext !== null
                             ? 'Preview manually modified, content is no longer the generated version.'
                             : 'Preview content is not validated. Generate context to validate.';
                           isPreviewContentValid = false;
                        }
                      });
                    }

                    // --- Event Listener for Copy Button ---
                    if (copyButton) {
                      copyButton.addEventListener("click", () => {
                        // Clear the preview immediately and show thinking status
                        if (previewTextArea && previewStatusElement && previewContainer) {
                          // Check container too
                          previewTextArea.value = ""; // Clear old content
                          previewContainer.classList.remove("invalidated"); // Remove invalid state
                          previewStatusElement.textContent = "Generating context...";
                          isPreviewContentValid = false; // Mark as not valid while generating
                        }
                        // Tell extension to generate, copy, AND send back preview content
                        vscode.postMessage({
                          command: "copyToClipboard", // Keep command name
                        });
                      });
                    }

                    // --- Optional: Notify Extension when Webview is Ready ---
                    // Useful if the extension needs to know when to send initial data.
                    vscode.postMessage({ command: "webviewReady" });
                    console.log("Webview script loaded and ready.");

                    // --- Function to invalidate the preview ---
                    function invalidatePreviewState(reason = "unknown") {
                      if (previewContainer && previewStatusElement) {
                         currentValidContext = null; // Clear the known valid context
                         isPreviewContentValid = false; // Mark internal state as invalid
                         previewContainer.classList.add("invalidated");

                         if (reason === "extension") {
                            console.log("Webview: Invalidating preview state (due to extension change).");
                            previewStatusElement.textContent =
                             'Context source changed (files/prefix/suffix), preview outdated. Click "Create Context..." to update.';
                         } else {
                             console.log("Webview: Invalidating preview state (reason: " + reason + ").");
                             // Keep existing text if user was typing, otherwise set generic message
                              if (!previewStatusElement.textContent.startsWith('Preview manually modified')) {
                                 previewStatusElement.textContent = 'Preview content is outdated or invalid.';
                              }
                         }
                         // Keep the text area editable
                      }
                    }

                    // --- Function to validate the preview ---
                    function validatePreviewState(newContent) {
                      if (previewTextArea && previewContainer && previewStatusElement) {
                        console.log("Webview: Validating preview state.");
                        currentValidContext = newContent; // Store the new valid content
                        previewTextArea.value = newContent;
                        previewContainer.classList.remove("invalidated");
                        previewStatusElement.textContent =
                          "Preview generated. Copied to clipboard."; // Updated status
                        isPreviewContentValid = true;
                        // previewTextArea.readOnly = true; // Make it readonly again? Decided against for now.
                        // Scroll to top after updating
                        previewTextArea.scrollTop = 0;
                      }
                    }

                }()); // Immediately invoke the function to scope variables
              </script>
          </body>
        </html>`;
}

function createOrShowWebviewPanel(context: vscode.ExtensionContext) {
  const column = vscode.window.activeTextEditor
    ? vscode.window.activeTextEditor.viewColumn
    : vscode.ViewColumn.Beside;

  // If we already have a panel, show it.
  if (webviewPanel) {
    webviewPanel.reveal(column);
    console.log("Prompt Tower UI: Revealed existing panel.");
    isPreviewValid = false;
    // Resend state when revealed
    if (providerInstance) {
      webviewPanel.webview.postMessage({
        command: "updatePrefix",
        text: providerInstance.getPromptPrefix(),
      });
      webviewPanel.webview.postMessage({
        command: "updateSuffix",
        text: providerInstance.getPromptSuffix(),
      });
      webviewPanel.webview.postMessage({
        command: "tokenUpdate",
        payload: {
          count: providerInstance.getCurrentTokenCount(),
          isCounting: providerInstance.getIsCounting(),
        },
      });
      invalidateWebviewPreview();
    }
    return;
  }

  console.log("Prompt Tower UI: Creating new panel.");
  isPreviewValid = false;

  // Otherwise, create a new panel.
  webviewPanel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "Prompt Tower",
    column || vscode.ViewColumn.Beside,
    {
      // Enable JS in webview
      enableScripts: true,
      // Keep panel alive when not visible (important)
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    }
  );

  // ... set webviewPanel.webview.html ...
  webviewPanel.webview.html = getWebviewContent(
    webviewPanel.webview,
    context.extensionUri,
    providerInstance ? providerInstance.getPromptPrefix() : "",
    providerInstance ? providerInstance.getPromptSuffix() : ""
  );

  // --- Listener for Token Updates from Provider ---
  // Make sure the listener is disposed only when the extension deactivates,
  // not necessarily when the panel closes, so it can re-attach if panel reopens.
  // We add it to context.subscriptions.
  context.subscriptions.push(
    tokenUpdateEmitter.event((payload: TokenUpdatePayload) => {
      // Only post if the panel currently exists
      if (webviewPanel) {
        webviewPanel.webview.postMessage({ command: "tokenUpdate", payload });
      }
    })
  );

  // --- Handle messages FROM the webview ---
  webviewPanel.webview.onDidReceiveMessage(
    async (message) => {
      console.log("Message received from webview:", message);
      switch (message.command) {
        case "updatePrefix":
          if (providerInstance && typeof message.text === "string") {
            providerInstance.setPromptPrefix(message.text);
            invalidateWebviewPreview();
          }
          return;
        case "updateSuffix":
          if (providerInstance && typeof message.text === "string") {
            providerInstance.setPromptSuffix(message.text);
            invalidateWebviewPreview();
          }
          return;
        case "webviewReady": // Handle webview ready message
          console.log("Prompt Tower Webview reported ready.");
          if (providerInstance && webviewPanel) {
            // Send initial state
            webviewPanel.webview.postMessage({
              command: "updatePrefix",
              text: providerInstance.getPromptPrefix(),
            });
            webviewPanel.webview.postMessage({
              command: "updateSuffix",
              text: providerInstance.getPromptSuffix(),
            });
            webviewPanel.webview.postMessage({
              command: "tokenUpdate",
              payload: {
                count: providerInstance.getCurrentTokenCount(),
                isCounting: providerInstance.getIsCounting(),
              },
            });
            invalidateWebviewPreview();
          }
          return;
        case "copyToClipboard":
          if (providerInstance && webviewPanel) {
            try {
              // 1. Call provider to copy to clipboard (shows info message)
              await providerInstance.copyContextToClipboard();

              // 2. Generate the context *again* to get the string for preview
              // Use await as generateContextString is async
              const { contextString } =
                await providerInstance.generateContextString();

              // 3. Send the context string back to the webview for preview
              console.log("Extension: Sending updatePreview to webview.");
              webviewPanel.webview.postMessage({
                command: "updatePreview",
                payload: { context: contextString },
              });
              isPreviewValid = true; // Mark preview as valid now
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              vscode.window.showErrorMessage(
                `Error handling context generation/copy: ${errorMessage}`
              );
              console.error("Error in copyToClipboard handling:", error);
              // Optionally send an error back to webview?
              // webviewPanel.webview.postMessage({ command: 'previewError', message: 'Failed to generate context.' });
              isPreviewValid = false; // Ensure it's marked invalid on error
            }
          } else {
            vscode.window.showErrorMessage(
              "Prompt Tower provider not available."
            );
            isPreviewValid = false;
          }
          return;
      }
    },
    undefined, // thisArg
    context.subscriptions // Add disposable to context
  );

  webviewPanel.onDidDispose(
    () => {
      console.log("Prompt Tower UI: Panel disposed."); // Log for debugging
      webviewPanel = undefined;
      // Listener remains active via context.subscriptions
    },
    null, // thisArg
    context.subscriptions // Add disposable to context
  );

  console.log("Prompt Tower UI: Panel created and listeners set.");
}

export function activate(context: vscode.ExtensionContext) {
  // --- Tree View Setup (Keep if needed) ---
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let treeView: vscode.TreeView<FileItem> | undefined;

  if (rootPath) {
    // Check if the view contribution exists before creating the provider/view
    // Use optional chaining ?. for safety
    const viewContribution = vscode.extensions
      .getExtension(context.extension.id)
      ?.packageJSON?.contributes?.views?.["prompt-tower"]?.find(
        (v: any) => v.id === "promptTowerView"
      );

    if (viewContribution) {
      console.log("Prompt Tower: Initializing Tree View."); // Log for debugging
      providerInstance = new PromptTowerProvider(
        rootPath,
        context,
        tokenUpdateEmitter,
        invalidateWebviewPreview
      );
      treeView = vscode.window.createTreeView("promptTowerView", {
        treeDataProvider: providerInstance,
        canSelectMany: true,
        showCollapseAll: true,
      });
      context.subscriptions.push(treeView);

      registerCommands(context, providerInstance, treeView);
    } else {
      // Handle case where tree view is not defined in package.json
      console.log(
        "Prompt Tower: Tree View contribution not found. Skipping Tree View setup."
      );
      // Register commands that DON'T depend on the provider/treeView if necessary
      // Ensure registerCommands is called even without provider/treeView for shared commands like config updates
      registerCommands(context);
    }
  } else {
    vscode.window.showInformationMessage(
      "Prompt Tower: No workspace open. Tree view not available."
    );
    // Register commands that DON'T depend on the provider/treeView if necessary
    // Ensure registerCommands is called even without provider/treeView for shared commands like config updates
    registerCommands(context);
  }
  // --- End Tree View Setup ---

  // --- ADD tokenUpdateEmitter listener registration here ---
  const tokenUpdateListener = tokenUpdateEmitter.event(
    (payload: TokenUpdatePayload) => {
      if (webviewPanel) {
        webviewPanel.webview.postMessage({ command: "tokenUpdate", payload });
        invalidateWebviewPreview(); // Invalidate on token update
      }
    }
  );
  context.subscriptions.push(tokenUpdateListener); // Add listener to subscriptions

  // --- Register Webview Panel Command ---
  console.log("Prompt Tower: Registering command promptTower.showTowerUI");
  context.subscriptions.push(
    vscode.commands.registerCommand("promptTower.showTowerUI", () => {
      console.log("Prompt Tower: Command promptTower.showTowerUI executed.");
      createOrShowWebviewPanel(context);
    })
  );

  // Automatically show the panel upon activation (CRITICAL UX, DO NOT REMOVE)
  vscode.commands.executeCommand("promptTower.showTowerUI");
}

export function deactivate() {
  console.log('Deactivating "prompt-tower"'); // Log for debugging
  // Dispose the webview panel if it exists
  if (webviewPanel) {
    console.log("Disposing Prompt Tower UI panel."); // Log for debugging
    webviewPanel.dispose();
  }
  // Dispose the emitter to clean up listeners
  tokenUpdateEmitter.dispose();
  console.log("Disposed token update emitter.");
}
