# Dify for VS Code

A Dify-powered VS Code **agent platform**: local coding/workspace tools, Playwright browser automation, MCP client + MCP bridge server, semantic vector search/memory, and CrewAI-inspired multi-agent orchestration.

> The extension still uses your Dify Chatflow as the model/orchestration endpoint. It does not require Roo/Cline as a middle layer.

## What 0.3.0 adds

- **Browser automation** with `playwright-core` and an installed Chrome/Edge/Chromium
- **MCP client/host**: stdio + Streamable HTTP, legacy SSE fallback, dynamic tool discovery
- **Local MCP bridge server** so other MCP clients can call this VS Code workspace agent's tools
- **Semantic vector index** for workspace code/text
- **Long-term vector memory** (`memory_save` / `memory_search`)
- **CrewAI-inspired multi-agent crews** with Agent/Task/Crew concepts, sequential + hierarchical processes, task context/dependencies and async task waves
- Existing 23 workspace/code/file/Git/shell tools remain available

The multi-agent design follows the same core separation used by CrewAI: Agents have role/goal/backstory/tools; Tasks have description/expected output/agent/context; Crews own agents, tasks, process, planning and shared memory.

## Install

Download the newest `.vsix` from GitHub Releases, then:

```text
VS Code -> Extensions -> ... -> Install from VSIX...
```

## 1. Dify Chatflow setup

Create/import a Dify **Chatflow** and configure these Start node variables:

| Variable | Type | Required | Purpose |
| --- | --- | --- | --- |
| `messages_json` | Paragraph / long text | Yes | Complete OpenAI-compatible history |
| `tools_json` | Paragraph / long text | Yes | Dynamic tool schemas from the extension |
| `tool_choice_json` | Text | Recommended | Extension sends `"auto"` |
| `retry_feedback` | Text | Optional | Reserved; currently empty |

Your LLM should inspect `messages_json` + `tools_json` and return either a normal message:

```json
{
  "type": "message",
  "content": "Done.",
  "tool_calls": []
}
```

or OpenAI-compatible tool calls:

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
        "arguments": "{\"path\":\"src/main.ts\"}"
      }
    }
  ]
}
```

`function.arguments` must be a JSON **string**. The extension strips common `<think>...</think>` / reasoning wrappers and extracts the final protocol object, but clean JSON is preferred.

After editing the Chatflow, **Publish / Update** it. The API uses the published version.

See [`dify/chatflow-prompt.md`](dify/chatflow-prompt.md).

## 2. Find Dify API URL and key

Open the Chatflow application and find **API Access / Access API / API Reference** (wording depends on Dify version).

If Dify shows:

```text
https://dify.example.com/v1/chat-messages
```

configure the extension with:

```text
https://dify.example.com/v1
```

Do not include `/chat-messages`; the extension appends it.

Create/copy the App API key, normally:

```text
app-xxxxxxxxxxxxxxxx
```

The Dify key is stored in VS Code SecretStorage.

Then run:

```text
Dify for VS Code: Configure
```

and test `ping`, followed by a real workspace task.

---

# Browser automation

The extension uses **Playwright Core** and does **not** download a browser into the VSIX. It tries an installed Edge/Chrome automatically.

Settings:

```json
{
  "difyForVscode.browserChannel": "auto",
  "difyForVscode.browserHeadless": false,
  "difyForVscode.browserExecutablePath": ""
}
```

Tools:

- `browser_open`
- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_select`
- `browser_wait`
- `browser_evaluate`
- `browser_screenshot`
- `browser_close`

`browser_snapshot` assigns stable selectors such as:

```text
[data-dify-ref="e12"]
```

so the model can inspect first, then click/fill a specific interactive element.

Browser actions that can cause external side effects are approval-gated unless YOLO is enabled.

---

# MCP client: connect external MCP servers

Configure `difyForVscode.mcpServers` in VS Code settings.

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

Environment interpolation is supported in strings:

```text
${env:MY_MCP_TOKEN}
```

Run:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

Discovered MCP tools are automatically exposed to Dify as names like:

```text
mcp__filesystem__read_file
mcp__github__search_repositories
```

MCP tools marked `readOnlyHint: true` execute as read-only; unknown/potentially mutating MCP tools are approval-gated unless YOLO is on.

---

# MCP bridge server: expose VS Code tools to other agents

The extension can also act as a **local MCP server**.

Run:

```text
Dify for VS Code: Start MCP Bridge Server
```

Default endpoint:

```text
http://127.0.0.1:8765/mcp
```

A bearer token is generated and stored in SecretStorage by default. Run:

```text
Dify for VS Code: Copy MCP Bridge Client Config
```

to copy a client config with URL + token.

Settings:

```json
{
  "difyForVscode.mcpBridgeEnabled": false,
  "difyForVscode.mcpBridgePort": 8765,
  "difyForVscode.mcpBridgeRequireToken": true
}
```

The bridge binds to `127.0.0.1` only.

---

# Semantic vector index + memory

## Recommended: real embedding model

Run:

```text
Dify for VS Code: Configure Semantic Embeddings
```

The endpoint is OpenAI-compatible, so examples include:

### Ollama

```text
Base URL: http://127.0.0.1:11434/v1
Model: nomic-embed-text
```

### OpenAI-compatible service

```text
Base URL: https://your-provider.example/v1
Model: your-embedding-model
API Key: stored in SecretStorage
```

Then run:

```text
Dify for VS Code: Build Semantic Workspace Index
```

Tools:

- `semantic_index_build`
- `semantic_search`
- `semantic_index_status`
- `semantic_index_clear`
- `memory_save`
- `memory_search`
- `memory_clear`

The index is chunked and persisted in the extension's global storage per workspace.

If no embedding endpoint/model is configured, the extension falls back to a **local code-aware feature-hash vector**. This keeps vector search usable offline, but a real embedding model provides substantially better semantic retrieval.

---

# Multi-agent Crews

The top-level Dify agent can invoke `run_crew` when a task benefits from specialist agents.

Example conceptual crew:

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
      "goal": "Understand architecture and propose a safe implementation",
      "tools": ["read_*", "search_files", "semantic_search", "list_code_definitions"]
    },
    {
      "id": "coder",
      "role": "Implementation Engineer",
      "goal": "Implement the approved changes and keep the project buildable",
      "tools": ["read_*", "search_files", "write_file", "replace_text", "apply_patch", "run_command", "get_diagnostics"]
    },
    {
      "id": "reviewer",
      "role": "Reviewer",
      "goal": "Review correctness, regressions and test results",
      "tools": ["read_*", "git_diff", "get_diagnostics", "run_command"]
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
      "description": "Implement the feature",
      "expected_output": "Working implementation with verification",
      "agent": "coder",
      "context": ["design"]
    },
    {
      "id": "review",
      "description": "Review and test the implementation",
      "expected_output": "Review result and any remaining issues",
      "agent": "reviewer",
      "context": ["implement"]
    }
  ]
}
```

Each sub-agent has its **own conversation history and tool allowlist**. Tool mutations from async sub-agents are serialized to reduce workspace races.

Processes:

- `sequential` — tasks follow their dependency graph
- `hierarchical` — a manager agent plans/assigns work and synthesizes the final result
- `async_execution: true` — dependency-ready tasks can execute concurrently in bounded waves

Crew task outputs can be persisted into vector memory with `memory: true`.

---

# Core local tools

The existing coding/workspace surface remains:

### Read / inspect

`get_workspace_info`, `file_info`, `read_file`, `read_files`, `list_files`, `search_files`, `list_code_definitions`, `get_diagnostics`, `open_file`

### Edit / file management

`write_file`, `replace_text`, `insert_text`, `apply_patch`, `create_directory`, `move_file`, `rename_file`, `copy_file`, `delete_file`

### Execution / Git

`run_command`, `git_status`, `git_diff`

### External / human interaction

`fetch_url`, `ask_user`

The actual tool count is dynamic because MCP tools are discovered at runtime.

---

# YOLO mode and safety

YOLO auto-approves actions that may mutate files/systems or cause external side effects.

Approval-gated categories include:

- file writes/moves/deletes/patches
- shell commands
- browser navigation/click/fill/evaluate actions
- MCP tools that are not explicitly marked read-only

Workspace file tools enforce workspace-bound paths. Shell commands and external MCP/browser actions can affect systems outside the workspace by design.

Use Git/source control for projects where rollback matters.

---

# Architecture

```text
VS Code UI
   |
   v
platform-entry.js            platform lifecycle + dynamic Dify tool injection
   |
   +-- compat.js             Dify Chatflow adapter + reasoning cleanup + update check
   +-- extension.js          stable top-level chat/agent loop + approvals
   +-- agentRuntime.js       isolated Crew sub-agent Dify loops + approvals
   +-- tools.js              platform-aware execution router
   +-- localTools.js         local workspace/code/Git/shell tools
   +-- browser.js            Playwright browser session + DOM refs
   +-- mcp.js                MCP client + dynamic tool resolver
   +-- mcpServer.js          localhost MCP bridge server
   +-- semantic.js           embeddings/vector index + long-term memory
   +-- crew.js               Agent/Task/Crew orchestration
   +-- platform.js           capability registry/lifecycle
```

This is inspired by CrewAI's architectural separation, but it is an original VS Code/Dify implementation and does not embed or depend on CrewAI Python runtime.

## Development

```bash
npm install
npm run check
npm run package
```

Runtime dependencies:

- `playwright-core`
- MCP TypeScript SDK v2 client/server/node packages

Playwright Core does not bundle a Chromium download; use an installed Chrome/Edge/Chromium.
