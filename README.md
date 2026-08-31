# Dify for VS Code

A standalone VS Code coding/automation agent that connects **directly to a Dify Chatflow**. No Cline, Roo, Dify plugin, or external proxy is required.

## Features

- Native VS Code sidebar chat UI
- Direct Dify `/v1/chat-messages` connection
- OpenAI-compatible tool-call history
- 23 built-in local tools for reading, searching, editing, file management, Git, diagnostics, web fetch, and user questions
- Workspace path protection for file operations
- Approval prompts for mutating tools
- **YOLO mode** for auto-approval
- New Chat button with clean context
- Dify API key stored in VS Code SecretStorage
- GitHub Release update check

## Install

Download the latest `.vsix` from GitHub Releases, then in VS Code:

```text
Extensions -> ... -> Install from VSIX...
```

## Dify setup

You need a Dify **Chatflow** plus its App API URL/key.

### Start node variables

Create these Start inputs:

| Variable | Type | Required | Purpose |
| --- | --- | --- | --- |
| `messages_json` | Paragraph / long text | Yes | Complete OpenAI-compatible conversation history as JSON |
| `tools_json` | Paragraph / long text | Recommended | Tool schemas sent by the VS Code extension |
| `tool_choice_json` | Paragraph / text | Recommended | Extension sends `"auto"` |
| `retry_feedback` | Paragraph / text | Optional | Reserved feedback field; currently empty |

The extension sends the complete history every request, so it does not depend on Dify conversation memory.

### Recommended Chatflow behavior

Your LLM node should inspect `messages_json` and `tools_json`, decide the next step, and return one JSON object only.

Normal answer:

```json
{
  "type": "message",
  "content": "Done.",
  "tool_calls": []
}
```

Tool call:

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

`function.arguments` must be a JSON **string**.

The extension tolerates common model wrappers such as `<think>...</think>` and extracts the final JSON object, but the best Chatflow behavior is still to return clean JSON.

See [`dify/chatflow-prompt.md`](dify/chatflow-prompt.md) for the protocol contract.

### Publish the Chatflow

After editing the workflow:

```text
Open Chatflow -> test -> Publish / Update
```

The API uses the published application version.

## Find the Dify API URL and key

Open the Chatflow application and find **API Access**, **Access API**, or **API Reference** (name varies by Dify version).

If Dify shows:

```text
https://dify.example.com/v1/chat-messages
```

configure the extension with only:

```text
https://dify.example.com/v1
```

The extension appends `/chat-messages` automatically.

On the same API page, create/copy the App API key, normally:

```text
app-xxxxxxxxxxxxxxxx
```

Do not commit this key. The extension stores it in VS Code SecretStorage.

## Configure the VS Code extension

Run:

```text
Dify for VS Code: Configure
```

Enter:

- Base URL: `https://dify.example.com/v1`
- App API Key: `app-...`
- User ID: e.g. `vscode-agent`

Then click **+ New Chat** and test:

```text
ping
```

Then try:

```text
Inspect this workspace and tell me what it does.
```

## Built-in tools (0.2.0)

### Workspace / inspection

- `get_workspace_info`
- `file_info`
- `read_file`
- `read_files`
- `list_files`
- `search_files` (regex)
- `list_code_definitions`
- `get_diagnostics`
- `open_file`

### Editing / file management

- `write_file`
- `replace_text`
- `insert_text`
- `apply_patch`
- `create_directory`
- `move_file`
- `rename_file`
- `copy_file`
- `delete_file`

### Execution / Git

- `run_command`
- `git_status`
- `git_diff`

### External / interaction

- `fetch_url`
- `ask_user`

This tool surface is intentionally similar in capability coverage to modern coding agents such as Roo Code and Cline: read/search, precise edits/patches, shell execution, code structure, external retrieval, and human-in-the-loop interaction.

Browser automation, MCP servers, and semantic vector indexing are **not** bundled into 0.2.0; those require dedicated subsystems rather than simple local functions.

## Safety and YOLO

Read-only tools execute automatically. Mutating tools such as writes, moves, deletes, patches, directory creation, copies, and shell commands require approval by default.

Turn on **YOLO** to auto-approve them. File tools are constrained to the current workspace; shell commands can still affect resources outside the workspace if the command itself does so.

`delete_file` uses the OS trash by default when supported.

## Updates

The extension checks GitHub Releases after startup by default. You can also run:

```text
Dify for VS Code: Check for Updates
```

## Development

Runtime has no third-party npm dependencies.

- `extension.js` — agent loop, UI, approvals, Dify request runtime
- `tools.js` — tool registry and local executors
- `compat.js` — Dify Chatflow protocol adapter and GitHub update checker

Packaging uses `@vscode/vsce` only as a development dependency.
