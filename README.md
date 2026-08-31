# Dify for VS Code

A Dify-powered VS Code **agent platform** that turns a Dify Chatflow into a practical coding and automation agent inside VS Code.

It combines:

- native VS Code chat UI
- local workspace/code/file tools
- shell and Git operations
- Playwright browser automation
- MCP client with dynamic tool discovery
- local MCP bridge server
- semantic workspace indexing and long-term vector memory
- CrewAI-inspired multi-agent orchestration
- approval controls and YOLO auto-approval
- GitHub Release update checking

The extension talks **directly to your Dify Chatflow**. Roo Code, Cline, Continue, Claude Code, or another middle layer is not required.

> Current release: **v0.3.1**

---

# 1. Quick start

## Step 1 — Install the VSIX

Download the latest release from:

https://github.com/lussifa/dify-for-vscode/releases

Then in VS Code:

```text
Extensions
-> ...
-> Install from VSIX...
```

Select:

```text
dify-for-vscode-x.y.z.vsix
```

After installation, the **Dify** icon appears in the VS Code Activity Bar.

---

## Step 2 — Prepare the Dify Chatflow

The easiest and recommended method is to **download the ready-made Dify Chatflow DSL included in this repository and import it directly into Dify**.

### Download the Chatflow DSL

**GitHub file page:**

https://github.com/lussifa/dify-for-vscode/blob/main/dify/coding-agent1.yml

**Direct download / Raw file:**

https://raw.githubusercontent.com/lussifa/dify-for-vscode/main/dify/coding-agent1.yml

File name:

```text
coding-agent1.yml
```

In Dify:

```text
Dify
-> Create App / Import DSL
-> Import DSL File
-> select coding-agent1.yml
```

After importing, open the Chatflow and verify the workflow topology is:

```text
Start
  -> LLM
  -> Answer
```

The included DSL already contains the input variables and the transport prompt required by this extension.

### Required Start node variables

The Start node must contain:

| Variable | Type | Required | Description |
| --- | --- | ---: | --- |
| `messages_json` | Paragraph / long text | Yes | Complete OpenAI-compatible conversation history |
| `tools_json` | Paragraph / long text | Yes | Tool schemas dynamically supplied by the VS Code extension |
| `tool_choice_json` | Text | Recommended | The extension sends `"auto"` |
| `retry_feedback` | Text | Optional | Reserved field; normally empty |

The extension sends the complete conversation state to Dify on each request. It does not depend on Dify conversation memory for the agent tool loop.

### After importing the DSL

You normally only need to adjust the LLM provider/model to one available in your Dify environment.

Recommended settings:

```text
Thinking / Reasoning: OFF
Temperature: 0.1 - 0.3
Tool choice: auto
Output: strict JSON
```

Then use:

```text
Publish / Update
```

The Dify API uses the **published** Chatflow version, so editor-only changes will not be visible to the VS Code extension until you publish them.

> If your Dify installation does not have the exact model/provider referenced by the supplied DSL, simply replace the LLM node model with one available in your environment. Keep the Start variables and system prompt/output contract unchanged.

Protocol reference:

[`dify/chatflow-prompt.md`](dify/chatflow-prompt.md)

---

# 2. Recommended Dify LLM settings

For the main tool-calling Chatflow:

```text
Thinking / Reasoning: OFF
Temperature: 0.1 - 0.3
Tool choice: auto
Output: strict JSON
```

## Why Thinking should normally be OFF

The extension expects the model to return protocol JSON such as:

```json
{
  "type": "tool_calls",
  "content": "",
  "tool_calls": [
    {
      "id": "call_001",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"package.json\"}"
      }
    }
  ]
}
```

or:

```json
{
  "type": "message",
  "content": "Task completed.",
  "tool_calls": []
}
```

Reasoning models may prepend `<think>...</think>` blocks. The extension contains compatibility parsing to remove common reasoning wrappers, but disabling Thinking usually gives cleaner JSON, lower latency, lower token usage, and more reliable multi-agent tool calling.

---

# 3. Dify system prompt behavior

The LLM should treat `messages_json` as the authoritative conversation state and `tools_json` as the exact current tool registry.

Important rules:

1. Use only tools present in `tools_json`.
2. Read existing files before editing them when practical.
3. Prefer precise edits over unnecessary full rewrites.
4. Treat tool results as authoritative state.
5. Continue using tools until the task is complete.
6. Return exactly one JSON protocol object per Dify response.
7. Do not wrap the protocol JSON in Markdown fences.
8. `function.arguments` must be a JSON **string**.
9. Never fabricate tool execution results.
10. After a successful tool result, continue from the real result instead of blindly repeating the same tool call.

See [`dify/chatflow-prompt.md`](dify/chatflow-prompt.md) for the exact transport contract.

---

# 4. Find the Dify API URL and API key

Open your Dify Chatflow application and locate **API Access**, **Access API**, or **API Reference** depending on your Dify version.

If Dify shows:

```text
https://dify.example.com/v1/chat-messages
```

configure the extension with:

```text
https://dify.example.com/v1
```

Do **not** include `/chat-messages`; the extension appends it automatically.

The App API key normally looks like:

```text
app-xxxxxxxxxxxxxxxx
```

The API key is stored in VS Code SecretStorage.

---

# 5. Configure the VS Code extension

Open the Command Palette and run:

```text
Dify for VS Code: Configure
```

Enter:

```text
Base URL: https://dify.example.com/v1
App API Key: app-xxxxxxxxxxxxxxxx
User ID: vscode-agent
```

Then click **+ New Chat**.

Basic test:

```text
ping
```

Then test workspace access:

```text
Read package.json and tell me the current extension version.
```

---

# 6. Core local tools

## Read / inspect

```text
get_workspace_info
file_info
read_file
read_files
list_files
search_files
list_code_definitions
get_diagnostics
open_file
```

## Editing / file management

```text
write_file
replace_text
insert_text
apply_patch
create_directory
move_file
rename_file
copy_file
delete_file
```

## Execution / Git

```text
run_command
git_status
git_diff
```

## External / human interaction

```text
fetch_url
ask_user
```

File operations are workspace-bound. Shell commands can intentionally affect resources outside the workspace, so use YOLO carefully.

---

# 7. Browser automation

Browser automation is implemented with Playwright Core and normally uses an installed Edge, Chrome, or Chromium.

Tools:

```text
browser_open
browser_snapshot
browser_click
browser_fill
browser_press
browser_select
browser_wait
browser_evaluate
browser_screenshot
browser_close
```

Recommended interaction flow:

```text
browser_open
-> browser_snapshot
-> inspect controls
-> browser_click / browser_fill
-> browser_snapshot
```

`browser_snapshot` creates stable element references such as:

```text
[data-dify-ref="e12"]
```

Settings:

```json
{
  "difyForVscode.browserChannel": "auto",
  "difyForVscode.browserHeadless": false,
  "difyForVscode.browserExecutablePath": "",
  "difyForVscode.browserIgnoreHTTPSErrors": false
}
```

You do not need to install Playwright separately; `playwright-core` is bundled with the extension. A local Edge/Chrome/Chromium installation is expected.

---

# 8. MCP client

External MCP servers can be connected through `difyForVscode.mcpServers`.

## stdio example

```json
{
  "difyForVscode.mcpServers": {
    "filesystem": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\code"]
    }
  }
}
```

## Streamable HTTP example

```json
{
  "difyForVscode.mcpServers": {
    "internal-tools": {
      "enabled": true,
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MY_MCP_TOKEN}"
      }
    }
  }
}
```

Useful commands:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

Discovered MCP tools are injected into Dify dynamically with names similar to:

```text
mcp__filesystem__read_file
mcp__github__search_repositories
```

MCP tools explicitly marked read-only can execute without mutation approval. Unknown or potentially mutating MCP tools are approval-gated unless YOLO is enabled.

---

# 9. MCP bridge server

The extension can expose its own workspace tools as a local MCP server.

Start:

```text
Dify for VS Code: Start MCP Bridge Server
```

Default endpoint:

```text
http://127.0.0.1:8765/mcp
```

Copy a ready client configuration with:

```text
Dify for VS Code: Copy MCP Bridge Client Config
```

Defaults:

```json
{
  "difyForVscode.mcpBridgeEnabled": false,
  "difyForVscode.mcpBridgePort": 8765,
  "difyForVscode.mcpBridgeRequireToken": true
}
```

The bridge binds to localhost only and can require a generated bearer token stored in SecretStorage.

---

# 10. Semantic workspace index

Tools:

```text
semantic_index_build
semantic_search
semantic_index_status
semantic_index_clear
```

Configure a real embedding endpoint with:

```text
Dify for VS Code: Configure Semantic Embeddings
```

Example using Ollama:

```text
Base URL: http://127.0.0.1:11434/v1
Model: nomic-embed-text
```

Then build the index:

```text
Dify for VS Code: Build Semantic Workspace Index
```

If no embedding service is configured, the extension uses a local code-aware feature-hash vector fallback. This works offline, but a real embedding model gives better semantic retrieval on large projects.

---

# 11. Long-term vector memory

```text
memory_save
memory_search
memory_clear
```

Memory is persistent and separate from ordinary conversation history. It can store architecture decisions, project conventions, investigation findings, and Crew task results.

---

# 12. Multi-agent Crews

The top-level agent can invoke:

```text
run_crew
```

Each sub-agent has its own:

- role
- goal
- optional backstory
- conversation history
- tool allowlist
- step budget

Supported processes:

```text
sequential
hierarchical
```

Tasks can define dependencies through `context` and can request `async_execution`.

Example roles:

```text
Architect
-> Coder
-> Reviewer
```

## v0.3.1 Crew resilience

v0.3.1 adds protection against common multi-agent loops:

- remaining-step-budget reminders
- duplicate tool-call detection
- forced no-tool finalization near the step limit
- `max_steps_reached` partial fallback instead of crashing the entire Crew
- Reviewer PASS/FAIL behavior
- bounded Coder Fix -> Reviewer Recheck cycles

Default maximum review/fix cycles:

```text
difyForVscode.crewMaxReviewCycles = 2
```

A Reviewer failure can therefore produce:

```text
Reviewer FAIL
-> Coder Fix
-> Reviewer Recheck
-> PASS
```

If the configured review-cycle limit is reached, the Crew stops retrying and the Manager reports the unresolved findings instead of looping indefinitely.

---

# 13. YOLO mode

YOLO automatically approves operations that normally require confirmation.

Approval-gated categories include:

- file writes/moves/deletes
- patch application
- shell commands
- browser navigation/form actions/evaluation
- potentially mutating MCP tools
- mutating Crew sub-agent actions

For autonomous work, source control is strongly recommended.

---

# 14. Task-running UI

Starting with v0.3.1, clicking **Send** immediately changes the button to a visible running state:

```text
Send
-> Working + spinner
```

The status area also shows a running indicator and the current top-level Agent step, for example:

```text
Dify thinking - step 3/40
```

When the task completes or fails, the button returns to normal automatically.

---

# 15. New Chat

Click **+ New Chat** or run:

```text
Dify for VS Code: New Chat
```

This clears the current workspace conversation history and starts the next request with a clean `messages_json` context.

---

# 16. Recommended acceptance tests

## Dify protocol

```text
ping
```

## Workspace tools

```text
Read package.json and tell me the extension version.
```

## File automation

```text
整理 demo 文件夹，统一命名规则，分类归档，并生成文件清单。
```

## Browser

```text
Open https://example.com, inspect the page and tell me its title and visible heading.
```

## Semantic index

```text
Find the main request processing flow in this project and explain which files are involved.
```

## Multi-agent

```text
Use run_crew with an Architect, Coder and Reviewer to inspect this project, implement one meaningful improvement, run verification and review the final diff.
```

---

# 17. Important configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `difyForVscode.baseUrl` | `http://127.0.0.1/v1` | Dify API base URL |
| `difyForVscode.userId` | `vscode-agent` | Dify user identifier |
| `difyForVscode.yoloMode` | `false` | Auto-approve mutating operations |
| `difyForVscode.maxAgentSteps` | `40` | Top-level tool-loop step limit |
| `difyForVscode.commandTimeoutMs` | `120000` | Shell/patch/Git timeout |
| `difyForVscode.browserChannel` | `auto` | Browser channel |
| `difyForVscode.browserHeadless` | `false` | Headless browser mode |
| `difyForVscode.mcpServers` | `{}` | External MCP definitions |
| `difyForVscode.mcpBridgeEnabled` | `false` | Auto-start MCP bridge |
| `difyForVscode.mcpBridgePort` | `8765` | MCP bridge port |
| `difyForVscode.semanticEmbeddingBaseUrl` | empty | Embedding API base URL |
| `difyForVscode.semanticEmbeddingModel` | empty | Embedding model |
| `difyForVscode.semanticIndexMaxFiles` | `2500` | Maximum indexed files |
| `difyForVscode.crewTaskMaxSteps` | `14` | Default Crew task step limit |
| `difyForVscode.crewMaxParallelTasks` | `3` | Parallel async Crew tasks |
| `difyForVscode.crewMaxReviewCycles` | `2` | Reviewer/fix retry cycles |

---

# 18. Troubleshooting

## `messages_json is required in input form`

The published Chatflow does not contain the expected Start variables. Import the supplied DSL again or verify the variables manually, then Publish / Update.

## Raw `<think>` output appears

Disable Thinking for the main Dify tool-calling LLM, install the latest extension, and start a New Chat.

## Tool calls appear as plain text

Verify the Dify LLM returns the required JSON protocol and that `function.arguments` is a JSON string.

## Browser does not start

Try:

```json
{
  "difyForVscode.browserChannel": "msedge"
}
```

or configure `browserExecutablePath` explicitly.

## MCP tools do not appear

Run:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

## Semantic search is weak

Configure a real embedding model and rebuild the semantic index.

## Crew agent reaches the step limit

v0.3.1 normally returns a partial result instead of failing the entire Crew. You can also increase:

```text
difyForVscode.crewTaskMaxSteps
```

---

# 19. Updates

Manual update check:

```text
Dify for VS Code: Check for Updates
```

GitHub Actions builds versioned VSIX packages and publishes GitHub Releases automatically.

---

# 20. Architecture

```text
VS Code UI
   |
   v
platform-entry.js
   |
   +-- compat.js       Dify protocol adapter / reasoning cleanup
   +-- extension.js    top-level Agent loop / UI / approvals
   +-- agentRuntime.js Crew sub-agent loops / step resilience
   +-- tools.js        platform tool router
   +-- localTools.js   workspace / files / Git / shell
   +-- browser.js      Playwright automation
   +-- mcp.js          MCP client / dynamic discovery
   +-- mcpServer.js    localhost MCP bridge
   +-- semantic.js     embeddings / vector index / memory
   +-- crew.js         multi-agent Agent / Task / Crew orchestration
   +-- platform.js     capability lifecycle
```

The Agent/Task/Crew separation is inspired by CrewAI concepts, but this project is an original VS Code/Dify implementation and does not embed the CrewAI Python runtime.

---

# 21. Development

Requirements:

```text
Node.js 22 recommended
VS Code 1.90+
```

Install dependencies:

```bash
npm install
```

Validate:

```bash
npm run check
```

Package:

```bash
npm run package
```

Runtime dependencies include:

```text
playwright-core
@modelcontextprotocol/client
@modelcontextprotocol/server
@modelcontextprotocol/node
```

---

# 22. Suggested operating model

```text
Main Dify tool-calling LLM
  Thinking: OFF
  Temperature: 0.1 - 0.3

VS Code Agent
  YOLO: OFF for unfamiliar repositories
  YOLO: ON for trusted autonomous workflows

Large projects
  Build semantic index
  Prefer a real embedding model

Complex tasks
  Use run_crew
  Architect -> Coder -> Reviewer

Before major autonomous edits
  Commit current Git state
```
