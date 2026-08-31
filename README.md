# Dify for VS Code

A standalone VS Code coding agent that connects **directly to a Dify Chatflow**. No Cline, Roo, Dify plugin, or external proxy is required.

## Features

- Native VS Code sidebar chat UI
- Direct Dify `/v1/chat-messages` connection
- Agent tool loop controlled by your Chatflow
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

Install the `.vsix` from VS Code:

1. Extensions
2. `...`
3. **Install from VSIX...**
4. Select `dify-for-vscode-0.1.0.vsix`

A **Dify** icon appears in the Activity Bar.

## Configure

Open the Dify sidebar and click **Configure**, or run:

```text
Dify for VS Code: Configure
```

Enter:

- Base URL, for example `http://dify.example.local/v1`
- Dify App API key, for example `app-xxxxxxxx`
- User ID

The API key is saved using VS Code SecretStorage.

## Dify Chatflow

See [`dify/chatflow-prompt.md`](dify/chatflow-prompt.md).

The Start node requires:

- `messages` (Paragraph)
- `tools` (Paragraph)

The LLM should return either a normal message object or a tool-calls object.

### Normal message

```json
{
  "type": "message",
  "content": "Done."
}
```

### Tool call

```json
{
  "type": "tool_calls",
  "tool_calls": [
    {
      "id": "call_001",
      "name": "read_file",
      "arguments": {
        "path": "src/main.ts"
      }
    }
  ]
}
```

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

Turn on **YOLO** in the sidebar to auto-approve all supported tools, including file writes and shell commands.

YOLO mode gives the model permission to modify workspace files and run commands without per-action confirmation. Use it only with a Chatflow/model you trust and preferably with source control enabled.

## Scope and safety

File tools are restricted to the currently opened workspace. `run_command` runs with the workspace root as its working directory. Shell commands can still affect resources outside the workspace if the command itself does so.

## Development

The extension intentionally has no runtime npm dependencies. `extension.js` is the source and runtime entry point.
