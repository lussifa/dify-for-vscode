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

> Current release: **v0.3.0**

---

# 1. Quick start

## Step 1 — Install the VSIX

Download the latest release from:

```text
https://github.com/lussifa/dify-for-vscode/releases
```

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

The easiest method is to import the Chatflow DSL included in this repository and use it as the starting point.

The Chatflow Start node must contain these variables:

| Variable | Type | Required | Description |
| --- | --- | ---: | --- |
| `messages_json` | Paragraph / long text | Yes | Complete OpenAI-compatible conversation history |
| `tools_json` | Paragraph / long text | Yes | Tool schemas dynamically supplied by the VS Code extension |
| `tool_choice_json` | Text | Recommended | The extension sends `"auto"` |
| `retry_feedback` | Text | Optional | Reserved field; currently sent as an empty string |

The extension sends the full history on every call. It does not depend on Dify's own conversation memory.

Recommended Chatflow topology:

```text
Start
  -> LLM
  -> Answer
```

The VS Code extension owns the tool-execution loop, so the Dify workflow itself does not need to implement a tool loop.

---

# 2. Recommended Dify LLM settings

For the main tool-calling Chatflow, the recommended settings are:

```text
Thinking / Reasoning: OFF
Temperature: 0.1 - 0.3
Tool choice: auto
Output: strict JSON
```

## Why Thinking should normally be OFF

The extension expects the model to return a protocol object such as:

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

or a final answer:

```json
{
  "type": "message",
  "content": "Task completed.",
  "tool_calls": []
}
```

Reasoning models often prepend output such as:

```text
<think>
I should inspect the workspace first...
</think>
```

The extension contains compatibility logic that removes common `<think>`, `<analysis>`, and `<reasoning>` blocks and extracts the final JSON object, so Thinking can work.

However, keeping Thinking disabled for the main execution model usually gives:

- cleaner JSON output
- fewer protocol parsing problems
- lower latency
- lower token usage
- faster multi-agent execution
- more predictable tool calling

For complex architectures, a future/advanced pattern is to use a dedicated planning agent with reasoning enabled while keeping the actual tool-executing agents non-thinking.

---

# 3. Dify system prompt behavior

The LLM should treat `messages_json` as the authoritative conversation and `tools_json` as the exact list of tools currently available.

Important rules for the LLM:

1. Use only tool names present in `tools_json`.
2. Read existing files before editing them when practical.
3. Prefer precise edits over full rewrites when possible.
4. Use tool results as authoritative state.
5. Continue calling tools until the task is actually complete.
6. Return exactly one JSON protocol object for each Dify response.
7. Do not wrap the final JSON in Markdown fences.
8. `function.arguments` must be a JSON **string**.

See:

```text
dify/chatflow-prompt.md
```

for the protocol reference included in this repository.

After editing the Chatflow, always use:

```text
Publish / Update
```

because Dify API requests use the published application version.

---

# 4. Find the Dify API URL and API key

Open your Dify Chatflow application and locate:

```text
API Access
```

or, depending on the Dify version:

```text
Access API
API Reference
```

If Dify shows this endpoint:

```text
https://dify.example.com/v1/chat-messages
```

configure the extension with only:

```text
https://dify.example.com/v1
```

Do **not** include `/chat-messages` because the extension appends it automatically.

For a self-hosted instance this may look like:

```text
http://10.0.0.20/v1
```

or:

```text
https://dify.company.local/v1
```

Create or copy the Dify App API key. It normally looks like:

```text
app-xxxxxxxxxxxxxxxx
```

The API key is stored in VS Code SecretStorage rather than normal workspace settings.

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

Then open the Dify sidebar and click **+ New Chat**.

First test:

```text
ping
```

Expected answer:

```text
pong
```

Then test workspace access:

```text
Read package.json and tell me the current extension version.
```

Then test a real agent task:

```text
Inspect this workspace, explain its architecture, run appropriate checks, and tell me if you find any problems.
```

---

# 6. Core local tools

The extension includes a complete local coding/workspace tool surface.

## Read and inspect

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

Capabilities include:

- workspace inspection
- line-numbered UTF-8 file reads
- batch reads
- regex search
- VS Code symbol discovery
- diagnostics inspection
- opening files directly in the editor

## Editing and file management

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

These support normal coding tasks and general file automation such as organizing folders, renaming files, generating reports, or restructuring a project.

File operations are workspace-bound. Paths attempting to escape the current workspace are rejected.

## Execution and Git

```text
run_command
git_status
git_diff
```

This allows the agent to:

- run builds and tests
- execute scripts
- inspect Git changes
- verify modifications before finishing

## External and human interaction

```text
fetch_url
ask_user
```

`ask_user` allows an agent to pause and request missing information instead of guessing.

The total tool count is dynamic because external MCP tools can be added at runtime.

---

# 7. Example: organize a folder automatically

Example prompt:

```text
整理我的 demo 文件夹，统一命名规则，按类型和日期整理归档，最后输出一份文件清单。
```

A typical tool flow may look like:

```text
get_workspace_info
-> list_files
-> file_info
-> create_directory
-> rename_file
-> move_file
-> file_info
-> write_file
-> final report
```

With YOLO enabled, the agent can perform the entire sequence without asking for confirmation for every rename or move.

---

# 8. Browser automation

The extension includes browser automation using **Playwright Core**.

It does not bundle a full Chromium browser inside the VSIX. It normally uses an already installed Edge, Chrome, or Chromium.

Available tools:

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

## Recommended workflow

The agent should normally:

```text
browser_open
-> browser_snapshot
-> inspect available controls
-> browser_click / browser_fill
-> browser_snapshot again
```

`browser_snapshot` assigns stable selectors such as:

```text
[data-dify-ref="e12"]
```

which makes subsequent interactions more reliable than guessing CSS selectors from raw HTML.

## Browser settings

```json
{
  "difyForVscode.browserChannel": "auto",
  "difyForVscode.browserHeadless": false,
  "difyForVscode.browserExecutablePath": "",
  "difyForVscode.browserIgnoreHTTPSErrors": false
}
```

`auto` tries installed Edge/Chrome automatically.

If detection fails, set `browserExecutablePath` manually.

Example Windows paths may resemble:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Browser actions that can cause external side effects are approval-gated unless YOLO is enabled.

---

# 9. MCP client — connect external MCP servers

The extension can act as an MCP host/client and dynamically add external MCP tools to the Dify tool list.

Configure:

```text
difyForVscode.mcpServers
```

## stdio example

```json
{
  "difyForVscode.mcpServers": {
    "filesystem": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "D:\\code"
      ]
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

Environment variables can be referenced with:

```text
${env:VARIABLE_NAME}
```

Useful commands:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

Once discovered, MCP tools are injected into `tools_json` using names similar to:

```text
mcp__filesystem__read_file
mcp__github__search_repositories
mcp__database__query
```

Tools marked by the MCP server with `readOnlyHint: true` can run as read-only operations.

Unknown or potentially mutating MCP tools are approval-gated unless YOLO is enabled.

---

# 10. MCP bridge server — expose VS Code tools to other agents

The extension can also expose its own tools as a local MCP server.

Start it with:

```text
Dify for VS Code: Start MCP Bridge Server
```

Default endpoint:

```text
http://127.0.0.1:8765/mcp
```

By default:

- it binds only to `127.0.0.1`
- bearer-token authentication is enabled
- the token is stored in SecretStorage

Run:

```text
Dify for VS Code: Copy MCP Bridge Client Config
```

and the extension will copy a ready-to-use client configuration.

Settings:

```json
{
  "difyForVscode.mcpBridgeEnabled": false,
  "difyForVscode.mcpBridgePort": 8765,
  "difyForVscode.mcpBridgeRequireToken": true
}
```

This makes it possible for another MCP-capable agent to use the current VS Code workspace tools.

---

# 11. Semantic workspace index

For large codebases, exact text search is not always sufficient.

The extension therefore includes semantic workspace retrieval.

Tools:

```text
semantic_index_build
semantic_search
semantic_index_status
semantic_index_clear
```

## Configure embeddings

Run:

```text
Dify for VS Code: Configure Semantic Embeddings
```

The endpoint uses an OpenAI-compatible `/embeddings` API.

### Ollama example

```text
Base URL: http://127.0.0.1:11434/v1
Model: nomic-embed-text
```

### Other OpenAI-compatible provider

```text
Base URL: https://embedding-provider.example/v1
Model: your-embedding-model
API Key: stored in SecretStorage
```

Then build the index:

```text
Dify for VS Code: Build Semantic Workspace Index
```

Check its state with:

```text
Dify for VS Code: Semantic Index Status
```

The index is chunked and stored per workspace in extension storage.

If no embedding provider is configured, the extension falls back to a local code-aware feature-hash vector implementation.

The fallback is useful offline, but a real embedding model gives significantly better semantic retrieval on large projects.

Example prompt:

```text
Find the part of this project responsible for authentication and explain the request flow, even if the relevant files do not contain the exact word "authentication".
```

---

# 12. Long-term vector memory

The platform also provides persistent semantic memory:

```text
memory_save
memory_search
memory_clear
```

This is separate from normal conversation history.

Example uses:

- remember architectural decisions
- save important investigation findings
- remember project conventions
- persist Crew task results for later retrieval

A future task can semantically search those memories without relying on the current chat history.

---

# 13. Multi-agent Crews

The extension implements CrewAI-inspired Agent / Task / Crew concepts in JavaScript while continuing to use your Dify Chatflow as the model endpoint.

The top-level agent can invoke:

```text
run_crew
```

A Crew can contain specialist agents with separate roles, goals, histories, and tool permissions.

Example:

```json
{
  "name": "feature-crew",
  "process": "hierarchical",
  "planning": true,
  "memory": true,
  "agents": [
    {
      "id": "architect",
      "role": "Software Architect",
      "goal": "Understand the architecture and design a safe implementation",
      "backstory": "You focus on architecture, dependencies and design tradeoffs.",
      "tools": [
        "read_*",
        "search_files",
        "semantic_search",
        "list_code_definitions"
      ]
    },
    {
      "id": "coder",
      "role": "Implementation Engineer",
      "goal": "Implement the requested feature and keep the project buildable",
      "tools": [
        "read_*",
        "search_files",
        "write_file",
        "replace_text",
        "apply_patch",
        "run_command",
        "get_diagnostics"
      ]
    },
    {
      "id": "reviewer",
      "role": "Code Reviewer",
      "goal": "Review correctness, regressions and test results",
      "tools": [
        "read_*",
        "git_diff",
        "get_diagnostics",
        "run_command"
      ]
    }
  ],
  "tasks": [
    {
      "id": "design",
      "description": "Inspect the requested feature and create an implementation plan",
      "expected_output": "Concrete implementation plan",
      "agent": "architect"
    },
    {
      "id": "implement",
      "description": "Implement the feature according to the design",
      "expected_output": "Working implementation with verification",
      "agent": "coder",
      "context": ["design"]
    },
    {
      "id": "review",
      "description": "Review and test the implementation",
      "expected_output": "Review result and remaining issues",
      "agent": "reviewer",
      "context": ["implement"]
    }
  ]
}
```

## Multi-agent properties

Each sub-agent has:

- its own conversation history
- its own role
- its own goal
- optional backstory
- its own tool allowlist
- its own maximum step count

Supported processes:

```text
sequential
hierarchical
```

Tasks can also use:

```text
context dependencies
async_execution
```

Dependency-ready async tasks can execute concurrently, bounded by:

```text
difyForVscode.crewMaxParallelTasks
```

Potentially mutating tool executions are serialized to reduce race conditions when multiple agents are working against the same workspace.

Crew outputs can also be saved into long-term vector memory.

---

# 14. YOLO mode

YOLO mode automatically approves actions that would normally require confirmation.

Toggle it from the Dify sidebar or run:

```text
Dify for VS Code: Toggle YOLO Mode
```

With YOLO OFF, mutating actions display an approval dialog.

With YOLO ON, the agent can continue automatically.

Approval-gated operations include categories such as:

- file creation/modification/deletion
- directory creation
- rename/move/copy
- patch application
- shell commands
- browser navigation and form interaction
- browser JavaScript evaluation
- screenshots written to the workspace
- potentially mutating MCP tools
- mutating actions requested by Crew sub-agents

YOLO is especially useful for long autonomous tasks, but source control is strongly recommended.

For coding projects, use Git so changes can be reviewed or reverted.

---

# 15. New Chat and conversation history

Click:

```text
+ New Chat
```

or run:

```text
Dify for VS Code: New Chat
```

This clears the current workspace conversation history.

Use it when:

- switching to an unrelated task
- testing a new Chatflow configuration
- a previous task left irrelevant context
- validating whether a behavior is caused by history

The next Dify request starts from a clean `messages_json` history.

---

# 16. Recommended acceptance tests

After installation, the following tests provide a useful end-to-end validation.

## Test A — Dify protocol

```text
ping
```

Expected:

```text
pong
```

The UI should not display raw `<think>` blocks or protocol JSON.

## Test B — workspace tools

```text
Read package.json and tell me the extension version.
```

Expected tool flow includes `read_file`.

## Test C — file automation

Create a test directory and ask:

```text
整理 demo 文件夹，统一命名规则，分类归档，并生成文件清单。
```

Expected tools may include:

```text
list_files
file_info
create_directory
rename_file
move_file
write_file
```

## Test D — browser

```text
Open https://example.com in the browser, inspect the page and tell me its title and visible heading.
```

Expected tools:

```text
browser_open
browser_snapshot
```

## Test E — semantic index

Build the semantic index, then ask:

```text
Find the main request processing flow in this project and explain which files are involved.
```

Expected use of `semantic_search` where appropriate.

## Test F — multi-agent

```text
Use an architect, coder and reviewer crew to inspect this project, identify one meaningful improvement, implement it, run checks and review the final diff.
```

Expected top-level use of `run_crew`.

---

# 17. Configuration reference

Important VS Code settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `difyForVscode.baseUrl` | `http://127.0.0.1/v1` | Dify API base URL |
| `difyForVscode.userId` | `vscode-agent` | Dify user identifier |
| `difyForVscode.yoloMode` | `false` | Auto-approve mutating operations |
| `difyForVscode.maxAgentSteps` | `40` | Maximum top-level Dify/tool loop steps |
| `difyForVscode.commandTimeoutMs` | `120000` | Shell/patch/Git timeout |
| `difyForVscode.checkUpdatesOnStartup` | `true` | Check GitHub Releases after startup |
| `difyForVscode.browserChannel` | `auto` | Browser channel |
| `difyForVscode.browserExecutablePath` | empty | Explicit browser executable |
| `difyForVscode.browserHeadless` | `false` | Headless browser mode |
| `difyForVscode.browserIgnoreHTTPSErrors` | `false` | Ignore browser TLS errors |
| `difyForVscode.mcpServers` | `{}` | External MCP server definitions |
| `difyForVscode.mcpBridgeEnabled` | `false` | Auto-start local MCP bridge |
| `difyForVscode.mcpBridgePort` | `8765` | Local MCP bridge port |
| `difyForVscode.mcpBridgeRequireToken` | `true` | Require bridge bearer token |
| `difyForVscode.semanticEmbeddingBaseUrl` | empty | OpenAI-compatible embedding endpoint |
| `difyForVscode.semanticEmbeddingModel` | empty | Embedding model |
| `difyForVscode.semanticIndexMaxFiles` | `2500` | Maximum files per index build |
| `difyForVscode.semanticChunkChars` | `3500` | Approximate chunk size |
| `difyForVscode.semanticChunkOverlapChars` | `500` | Chunk overlap |
| `difyForVscode.crewTaskMaxSteps` | `14` | Maximum steps per Crew task |
| `difyForVscode.crewMaxParallelTasks` | `3` | Maximum concurrent async Crew tasks |

---

# 18. Troubleshooting

## `messages_json is required in input form`

The published Dify Chatflow Start node does not match the extension contract.

Verify the variable is named exactly:

```text
messages_json
```

Also verify:

```text
tools_json
tool_choice_json
retry_feedback
```

Then publish the Chatflow again.

---

## Raw `<think>` or JSON appears in chat

Recommended actions:

1. Disable Thinking/Reasoning in the main Dify LLM.
2. Confirm you are running the latest extension release.
3. Click **+ New Chat** to remove old malformed conversation history.
4. Verify the LLM returns the required JSON protocol object.

The extension contains parser fallbacks, but clean model output is more reliable.

---

## Tool calls are shown as text instead of executed

Usually the model returned invalid protocol JSON.

Check that the response is structurally similar to:

```json
{
  "type": "tool_calls",
  "content": "",
  "tool_calls": []
}
```

and that each tool uses:

```json
{
  "type": "function",
  "function": {
    "name": "tool_name",
    "arguments": "{}"
  }
}
```

---

## Dify changes do not affect VS Code

Publish the Chatflow.

Editor changes that have not been published may not be used by API calls.

---

## Browser does not start

Try:

```json
{
  "difyForVscode.browserChannel": "msedge"
}
```

or:

```json
{
  "difyForVscode.browserChannel": "chrome"
}
```

If necessary, configure `browserExecutablePath` explicitly.

---

## MCP tools do not appear

Run:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

Verify:

- MCP process/URL is reachable
- command exists for stdio servers
- authentication headers are correct
- environment variables used by `${env:NAME}` exist in the VS Code process environment

---

## Semantic search results are weak

If the extension is using fallback local hash vectors, configure a real embedding model.

Then rebuild the workspace index.

For large codebases, embedding quality has a substantial effect on retrieval quality.

---

## Agent stops after many steps

Increase:

```text
difyForVscode.maxAgentSteps
```

Default:

```text
40
```

For Crew sub-agents adjust:

```text
difyForVscode.crewTaskMaxSteps
```

---

# 19. Updates and GitHub Releases

The extension checks the GitHub Releases page after startup by default.

Manual check:

```text
Dify for VS Code: Check for Updates
```

When a newer release is available, VS Code displays a notification that opens the GitHub Release page.

This project also uses GitHub Actions to package versioned VSIX files and create releases automatically when the package version changes.

---

# 20. Architecture

```text
VS Code UI
   |
   v
platform-entry.js
   |  platform lifecycle + dynamic Dify tool injection
   |
   +-- compat.js
   |     Dify protocol adapter
   |     OpenAI tool history normalization
   |     reasoning-block cleanup
   |     GitHub update checking
   |
   +-- extension.js
   |     top-level chat UI
   |     main agent loop
   |     approval / YOLO handling
   |     New Chat
   |
   +-- agentRuntime.js
   |     isolated Crew sub-agent Dify loops
   |     per-agent histories and tool permissions
   |
   +-- tools.js
   |     platform-aware tool execution router
   |
   +-- localTools.js
   |     workspace / code / files / Git / shell
   |
   +-- browser.js
   |     Playwright browser automation
   |
   +-- mcp.js
   |     MCP client
   |     connection lifecycle
   |     dynamic tool discovery
   |
   +-- mcpServer.js
   |     localhost MCP bridge server
   |
   +-- semantic.js
   |     embeddings
   |     semantic workspace index
   |     long-term vector memory
   |
   +-- crew.js
   |     Agent / Task / Crew orchestration
   |
   +-- platform.js
         capability registry and lifecycle
```

The Agent/Task/Crew separation is inspired by CrewAI concepts, but this repository is an original VS Code/Dify implementation and does not embed the CrewAI Python runtime.

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

Run syntax/runtime checks:

```bash
npm run check
```

Build VSIX:

```bash
npm run package
```

Runtime dependencies currently include:

```text
playwright-core
@modelcontextprotocol/client
@modelcontextprotocol/server
@modelcontextprotocol/node
```

`playwright-core` does not bundle a browser download; an installed Chrome/Edge/Chromium is expected.

---

# 22. Suggested operating model

For reliable daily use:

```text
Main Dify tool-calling LLM
  Thinking: OFF
  Temperature: 0.1 - 0.3

VS Code Agent
  YOLO: OFF for unfamiliar repositories
  YOLO: ON for trusted autonomous workflows

Large projects
  Build semantic index
  Use a real embedding model

Complex tasks
  Let the top-level agent invoke a Crew
  Architect -> Coder -> Reviewer

Before major autonomous edits
  Commit current Git state
```

That combination gives the platform a useful balance of speed, autonomy, recoverability, and tool-call stability.
