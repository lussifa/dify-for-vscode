# Dify Chatflow setup

This repository is aligned to the user's real `coding agent1` Chatflow contract.

## Required Start variables

- `messages_json` — text input, required. Complete OpenAI-compatible messages array serialized as JSON.
- `tools_json` — text input. OpenAI tools array serialized as JSON.
- `tool_choice_json` — text input. The extension currently sends `"auto"` as a JSON string.
- `retry_feedback` — text input. Currently sent as an empty string.

The VS Code extension sends the Dify App API request in this shape:

```json
{
  "inputs": {
    "messages_json": "<complete OpenAI messages JSON>",
    "tools_json": "<OpenAI tools JSON>",
    "tool_choice_json": "\"auto\"",
    "retry_feedback": ""
  },
  "query": "<current user/continuation query>",
  "response_mode": "blocking",
  "user": "vscode-agent"
}
```

## Output contract

The Answer node returns the LLM text verbatim. The LLM must return exactly one JSON object with:

```json
{
  "type": "message",
  "content": "assistant response",
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

`function.arguments` is a JSON string, not an object.

The compatibility layer in `compat.js` translates between this Chatflow contract and the stable extension runtime. It also normalizes older stored assistant tool-call history into OpenAI-compatible `tool_calls` before each Dify request.
