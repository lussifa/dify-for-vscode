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
- GitHub Release update check

## Install

Download the latest `.vsix` from the GitHub Releases page, then in VS Code open:

```text
Extensions
-> ...
-> Install from VSIX...
```

Select the downloaded `dify-for-vscode-x.y.z.vsix` file.

## Quick start

You need two things before configuring the VS Code extension:

1. A Dify **Chatflow** configured with the input/output contract below.
2. The Dify App **API Base URL** and **API Key** for that Chatflow.

## Configure the Dify Chatflow

The easiest option is to import the Chatflow DSL included with this repository and then publish it in Dify.

If you build the Chatflow manually, the Start node must contain these input variables:

| Variable | Type | Required | Purpose |
| --- | --- | --- | --- |
| `messages_json` | Paragraph / long text | Yes | Complete OpenAI-compatible conversation history serialized as JSON |
| `tools_json` | Paragraph / long text | Recommended | OpenAI-compatible tool definitions serialized as JSON |
| `tool_choice_json` | Paragraph / text | Recommended | Tool choice mode. The extension currently sends `"auto"` |
| `retry_feedback` | Paragraph / text | Optional | Reserved for retry/validation feedback; currently sent as an empty string |

The extension sends the complete conversation on every request and intentionally does **not** depend on Dify conversation memory.

### Chatflow response format

Your final Answer node must return the LLM output verbatim as JSON text.

For a normal assistant answer:

```json
{
  "type": "message",
  "content": "Done.",
  "tool_calls": []
}
```

For a tool call:

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

`function.arguments` must be a JSON **string**, matching the OpenAI Chat Completions tool-call format.

See [`dify/chatflow-prompt.md`](dify/chatflow-prompt.md) for the exact request/response contract.

## Publish the Chatflow in Dify

After editing the Chatflow, publish it before using the API.

Typical flow in Dify:

```text
Open your Chatflow application
-> verify the workflow runs successfully
-> Publish / Update
```

The API uses the published version of the application, so changes made only in the editor may not be visible to the VS Code extension until you publish again.

## Find the Dify API address and API key

Open the Chatflow application in Dify and locate its API access/API reference page. Depending on the Dify version, the entry may be named **API Access**, **Access API**, or **API Reference**.

That page shows both the API endpoint examples and the application's API keys.

### API Base URL

For this extension, configure the base URL only up to `/v1`.

For example, if Dify shows a Chatflow request URL like:

```text
https://dify.example.com/v1/chat-messages
```

enter this in the extension:

```text
https://dify.example.com/v1
```

Do **not** include `/chat-messages` because the extension appends that path automatically.

For a self-hosted Dify instance the value may look like:

```text
http://10.0.0.20/v1
```

or:

```text
https://dify.company.local/v1
```

### API Key

On the same API access page, create or copy an App API key. Dify application keys normally look like:

```text
app-xxxxxxxxxxxxxxxx
```

Keep this key private. Do not commit it to GitHub or store it in workspace files.

The VS Code extension stores the key in VS Code `SecretStorage`, not in `settings.json`.

## Configure the VS Code extension

In VS Code run:

```text
Dify for VS Code: Configure
```

Then enter:

### Base URL

```text
https://dify.example.com/v1
```

### App API Key

```text
app-xxxxxxxxxxxxxxxx
```

### User ID

Any stable identifier is acceptable, for example:

```text
vscode-agent
```

The extension sends requests to:

```text
POST {Base URL}/chat-messages
```

Example:

```text
POST https://dify.example.com/v1/chat-messages
```

## Verify the connection

After configuring the extension, open the Dify sidebar in VS Code and try:

```text
ping
```

Then try a workspace-aware request:

```text
Inspect this project and tell me what it does.
```

To verify tool execution, try:

```text
Read package.json and tell me the current extension version.
```

If Dify returns an error such as:

```text
messages_json is required in input form
```

check that the Chatflow Start node contains the exact variable names documented above and that the latest Chatflow version has been published.

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

Turn on **YOLO** in the sidebar to auto-approve supported file writes and shell commands.

With YOLO enabled, the model can modify files and run shell commands without per-action confirmation. Prefer using it in a Git-controlled workspace so changes can be reviewed or reverted easily.

## Updates

The extension can check the GitHub Releases page for newer versions.

It checks once after startup by default. You can also run:

```text
Dify for VS Code: Check for Updates
```

If a newer version exists, VS Code shows a notification with a link to the corresponding GitHub Release.

## Development

The extension intentionally has no runtime npm dependencies. `extension.js` contains the stable runtime, while `compat.js` adapts it to the current Dify Chatflow contract.
