# Dify for VS Code

A standalone VS Code coding agent that connects **directly to a Dify Chatflow**. No Cline, Roo, Dify plugin, or external proxy is required.

## Features

- Native VS Code sidebar chat UI
- Direct Dify `/v1/chat-messages` connection
- OpenAI-compatible agent/tool message history
- Workspace file reading and listing
- Code/text search
- File creation and rewriting
- Exact text replacement
- Shell command execution
- VS Code diagnostics collection
- **YOLO mode**: automatically execute mutating tools and shell commands without confirmation
- Dify API key stored in VS Code SecretStorage
- Conversation state kept per workspace

## Install

Install the `.vsix` from VS Code: Extensions -> `...` -> **Install from VSIX...**.

## Configure

Run `Dify for VS Code: Configure`, then enter the Dify `/v1` base URL, App API key, and User ID.

## Dify Chatflow contract

Version 0.1.1 is aligned with the `coding agent1` Chatflow contract used for this project.

The Chatflow Start node expects exactly these inputs:

- `messages_json` — required; complete OpenAI-compatible messages array serialized as JSON
- `tools_json` — OpenAI tools array serialized as JSON
- `tool_choice_json` — currently sent as `"auto"`
- `retry_feedback` — currently sent as an empty string

The extension sends the complete conversation on every request and intentionally does **not** rely on Dify conversation memory.

### Normal response

```json
{
  "type": "message",
  "content": "Done.",
  "tool_calls": []
}
```

### Tool response

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

`function.arguments` must be a JSON **string**, matching OpenAI Chat Completions tool-call format.

See [`dify/chatflow-prompt.md`](dify/chatflow-prompt.md) for the exact request/response contract.

## Built-in tools

- `get_workspace_info`
- `read_file`
- `list_files`
- `search_files`
- `write_file`
- `replace_text`
- `run_command`
- `get_diagnostics`

Read-only tools execute automatically. By default, `write_file`, `replace_text`, and `run_command` require approval.

## YOLO mode

Turn on **YOLO** in the sidebar to auto-approve supported file writes and shell commands. Use source control when possible.

## Development

The extension intentionally has no runtime npm dependencies. `extension.js` contains the stable runtime, while `compat.js` adapts it to the current Dify Chatflow contract.
