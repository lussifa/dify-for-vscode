# Dify for VS Code

A Dify-powered VS Code **agent platform** that turns a Dify Chatflow into a practical local agent for coding, Office automation, browser work, MCP tools, semantic retrieval and multi-agent collaboration.

It combines:

- native VS Code chat UI
- local workspace/code/file tools
- shell and Git operations
- **PowerPoint, Excel and Word generation/editing**
- Playwright browser automation
- MCP client with dynamic tool discovery
- local MCP bridge server
- semantic workspace indexing and long-term vector memory
- CrewAI-inspired multi-agent orchestration
- approval controls and YOLO auto-approval
- GitHub Release update checking

The extension talks **directly to your Dify Chatflow**. Roo Code, Cline, Continue, Claude Code, or another middle layer is not required.

> Current release: **v0.3.2**

---

# 1. Architecture at a glance

```text
User
  |
  v
VS Code / Dify for VS Code
  |
  +-- local workspace / code / shell / Git
  +-- Office: PPT / Excel / Word
  +-- Browser: Playwright
  +-- Semantic index / memory
  +-- MCP client + MCP bridge
  +-- Multi-agent Crew
  |
  v
Dify Chatflow
  |
  v
LLM decides the next tool call
```

The important design principle is:

```text
Dify = reasoning / orchestration
VS Code extension = local execution
```

The model receives the exact tool list dynamically. It decides what should happen next; the extension executes the requested tool locally and sends the real result back to Dify.

---

# 2. Quick start

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

**GitHub file page**

https://github.com/lussifa/dify-for-vscode/blob/main/dify/coding-agent1.yml

**Direct download / Raw file**

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

After importing, verify the topology is essentially:

```text
Start
  -> LLM
  -> Answer
```

The extension owns the tool-execution loop. The Dify workflow itself does not need to create another loop.

### Required Start variables

| Variable | Type | Required | Description |
| --- | --- | ---: | --- |
| `messages_json` | Paragraph / long text | Yes | Complete OpenAI-compatible conversation/tool history |
| `tools_json` | Paragraph / long text | Yes | Exact dynamic tool schemas supplied by the extension |
| `tool_choice_json` | Text | Recommended | Normally `"auto"` |
| `retry_feedback` | Text | Optional | Reserved compatibility feedback |

The extension sends the complete history on every call. It does not rely on Dify conversation memory as the authoritative state.

### After importing the DSL

You may replace the sample LLM provider/model with your own model. Keep the Start variables and output protocol intact.

For the latest agent guidance see:

```text
dify/chatflow-prompt.md
```

After changing the Chatflow, always click:

```text
Publish / Update
```

because API calls use the published application version.

---

# 3. Recommended Dify LLM settings

For the main tool-calling Chatflow:

```text
Thinking / Reasoning: OFF
Temperature: 0.1 - 0.3
Tool choice: auto
Output: strict JSON
```

The model must return either a normal message:

```json
{
  "type": "message",
  "content": "Task completed.",
  "tool_calls": []
}
```

or one/more tool calls:

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

`function.arguments` must be a JSON **string**.

The extension removes common `<think>`, `<analysis>` and `<reasoning>` wrappers, but disabling Thinking for the main execution model normally gives cleaner tool calls, lower latency and lower token use.

---

# 4. Configure the VS Code extension

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

If Dify documents the endpoint as:

```text
https://dify.example.com/v1/chat-messages
```

configure only:

```text
https://dify.example.com/v1
```

The extension appends `/chat-messages` itself.

The Dify API key is kept in VS Code SecretStorage.

Then click **+ New Chat** and test:

```text
ping
```

Follow with a real workspace task:

```text
Read package.json and tell me the current extension version.
```

---

# 5. v0.3.2 Office subsystem

v0.3.2 adds native Office capabilities directly to the existing agent platform.

```text
Dify for VS Code
  +-- PowerPoint (.pptx)
  +-- Excel (.xlsx)
  +-- Word (.docx)
```

These are **native agent tools**. The LLM does not need to generate Python, VBA, JavaScript or raw Office XML just to create an Office document.

For normal `.pptx`, `.xlsx` and `.docx` generation, **Microsoft Office does not need to be installed**.

The generated files are stored inside the opened VS Code workspace and therefore work naturally with the existing workspace, Crew and approval systems.

## Office tool list

### PowerPoint

```text
ppt_create
ppt_update
ppt_inspect
```

### Excel

```text
excel_create
excel_inspect
excel_write_range
excel_append_rows
excel_format_range
```

### Word

```text
word_create
word_update
word_inspect
```

### Preview / review

```text
office_render_pdf
```

The Office tools are also available to Crew sub-agents and are exposed through the local MCP bridge when the bridge is enabled.

---

# 6. PowerPoint generation

## Design principle

The PowerPoint engine is **declarative**.

Instead of asking the model to calculate dozens of absolute X/Y coordinates, the model describes the intended slide structure and the extension performs the layout.

Conceptually:

```text
AI content/structure
      |
      v
Declarative Presentation Spec
      |
      v
Office PPT engine
      |
      v
.pptx
```

This is intentionally more stable than exposing hundreds of low-level PowerPoint shape operations.

## Built-in themes

```text
corporate-light
corporate-dark
minimal
training
```

Default font:

```text
Microsoft YaHei
```

You can override the font family in `ppt_create`.

## Supported slide layouts

```text
title
section
bullets
two_column
table
chart
quote
blank
```

## Supported chart types

```text
bar
column
line
pie
doughnut
```

## Example prompt

```text
帮我做一份 8 页的 AI 办公自动化培训 PPT。

要求：
- corporate-light 风格
- 中文
- 包含封面、当前痛点、解决方案、工作流程、部门案例、数据图表、实施建议、总结
- 风格简洁，不要每页堆很多文字
- 保存为 reports/AI办公自动化培训.pptx
- 创建完成后用 ppt_inspect 检查结构
```

A typical Agent flow is:

```text
ppt_create
-> ppt_inspect
-> optional ppt_update
-> final answer
```

## PPT update model

When `ppt_create` generates a presentation, the extension also stores an editable sidecar:

```text
AI办公自动化培训.pptx
AI办公自动化培训.pptx.dify.json
```

The `.pptx` is the actual PowerPoint file. The `.dify.json` sidecar contains the declarative presentation structure used by the Agent.

This lets `ppt_update` reliably:

```text
replace_slide
append_slide
delete_slide
set_title
```

without reverse-engineering the OOXML file every time.

For an arbitrary external PowerPoint not created by this subsystem, `ppt_inspect` can confirm the file exists, but structured `ppt_update` requires the Dify sidecar.

---

# 7. Excel automation

Excel is implemented as a real workbook engine rather than CSV-only automation.

## `excel_create`

Creates `.xlsx` workbooks with:

- multiple worksheets
- headers and data rows
- styled headers
- automatic or explicit column widths
- frozen header rows
- AutoFilter
- number formats
- formulas
- hyperlinks
- date values

Example prompt:

```text
创建 reports/部门汇总.xlsx。

建立两个 Sheet：
1. Summary：部门、提交数量、总金额、完成率
2. Detail：日期、部门、项目、负责人、金额、状态

Summary 第一行使用表头样式，冻结首行并开启筛选。
完成后用 excel_inspect 检查工作簿。
```

## Formula cells

The tool schema supports formula objects conceptually like:

```json
{
  "formula": "SUM(B2:B20)",
  "result": 12345
}
```

## Existing workbook operations

Inspect first:

```text
excel_inspect
```

Then use:

```text
excel_write_range
excel_append_rows
excel_format_range
```

Examples:

```text
把 Sheet1 的 B2:D20 更新成新的数据
```

```text
把 20 行新记录追加到 Detail Sheet
```

```text
将 A1:F1 设置为粗体、居中、蓝色背景，并给 C2:C100 设置金额格式
```

All edits are saved directly back into the requested workbook inside the workspace.

---

# 8. Word document generation

Word also uses a declarative document model.

## Supported content blocks

```text
heading
paragraph
bullets
numbered
table
quote
page_break
```

Example prompt:

```text
帮我生成一份 Word 报告：reports/AI工具试点总结.docx

结构：
- 标题
- 项目背景
- 试点范围
- 关键成果
- 问题和风险
- 下一步计划
- 附表

使用正式商务中文，层级清晰。
生成后用 word_inspect 检查正文内容。
```

Like PowerPoint, `word_create` stores a sidecar:

```text
AI工具试点总结.docx.dify.json
```

For Dify-generated documents, `word_update` can:

```text
replace_block
append_block
delete_block
set_title
```

`word_inspect` can also extract readable text from an **existing external `.docx`** even when no sidecar exists.

For an external Word file without a sidecar, the safe pattern is:

```text
word_inspect existing.docx
-> understand content
-> word_create revised.docx
```

rather than pretending arbitrary DOCX structure can be safely rewritten.

---

# 9. Office PDF rendering / preview

`office_render_pdf` can convert:

```text
.pptx
.xlsx
.docx
```

to a PDF inside the workspace for review.

Renderer order:

```text
1. LibreOffice, when available
2. Microsoft Office COM fallback on Windows
```

Therefore:

- Office generation itself requires **no Office installation**
- PDF rendering is **optional** and requires a supported local renderer

If the machine has neither LibreOffice nor compatible Microsoft Office automation, the Office file can still be generated successfully; only PDF preview is unavailable.

Example:

```text
生成 PPT 后把它渲染成 PDF，保存到 office-preview，并检查生成结果。
```

---

# 10. Office + multi-agent workflow

Office tools can be placed in Crew allowlists just like coding tools.

A useful presentation Crew can look like:

```text
Researcher
   |
   v
Content Planner
   |
   v
PPT Builder
   |
   v
Reviewer
```

Example user prompt:

```text
必须使用 run_crew 完成一份季度业务复盘 PPT。

Researcher：读取 workspace 中的 Excel 和相关资料，整理关键事实。
Content Planner：规划 10 页故事线和每页核心信息。
PPT Builder：使用 ppt_create 创建 PPT。
Reviewer：使用 ppt_inspect 检查页数、结构、内容密度；发现明显问题时给出 FAIL 和修改建议。
最终输出 reports/Q3业务复盘.pptx。
```

For a data-report workflow:

```text
Excel data
   |
   +-> excel_inspect
   |
   v
Analysis Agent
   |
   v
Presentation Planner
   |
   v
ppt_create
```

This makes Office creation part of the same general Agent framework rather than a separate extension.

---

# 11. Core local coding/workspace tools

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

## Edit / file management

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

The actual tool count is dynamic because Office and MCP capabilities are injected at runtime.

---

# 12. Browser automation

The extension uses **Playwright Core** and an already installed browser.

Supported tools:

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

Recommended interaction pattern:

```text
browser_open
-> browser_snapshot
-> inspect stable refs
-> browser_click / browser_fill
-> browser_snapshot again
```

`browser_snapshot` creates selectors such as:

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

`playwright-core` is bundled as a dependency, but the VSIX does not download its own browser. Install Edge/Chrome/Chromium on the machine.

---

# 13. MCP client

Configure external MCP servers through:

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

Environment interpolation:

```text
${env:VARIABLE_NAME}
```

Commands:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

Discovered tools appear dynamically as:

```text
mcp__server__tool
```

---

# 14. MCP bridge server

The extension can expose its own local tools—including Office tools—to other MCP-capable agents.

Start:

```text
Dify for VS Code: Start MCP Bridge Server
```

Default endpoint:

```text
http://127.0.0.1:8765/mcp
```

By default the server:

- binds to `127.0.0.1` only
- requires a bearer token
- stores the token in SecretStorage

Copy a ready-to-use client config with:

```text
Dify for VS Code: Copy MCP Bridge Client Config
```

---

# 15. Semantic workspace index

Tools:

```text
semantic_index_build
semantic_search
semantic_index_status
semantic_index_clear
```

Configure an OpenAI-compatible embedding endpoint:

```text
Dify for VS Code: Configure Semantic Embeddings
```

Example with Ollama:

```text
Base URL: http://127.0.0.1:11434/v1
Model: nomic-embed-text
```

Then:

```text
Dify for VS Code: Build Semantic Workspace Index
```

If no embedding model is configured, the extension uses an offline code-aware feature-hash vector fallback. The fallback works, but a real embedding model produces substantially better concept-level retrieval.

---

# 16. Long-term vector memory

Tools:

```text
memory_save
memory_search
memory_clear
```

Use cases include:

- architecture decisions
- investigation findings
- project conventions
- Crew task results
- reusable research/context

This is separate from normal conversation history.

---

# 17. Multi-agent Crews

The top-level Dify agent can call:

```text
run_crew
```

Each sub-agent has its own:

- role
- goal
- backstory
- conversation history
- tool allowlist
- step budget

Processes:

```text
sequential
hierarchical
```

Dependency-ready tasks may use:

```text
async_execution: true
```

v0.3.1+ also contains Crew resilience features:

- remaining-step budget reminders
- duplicate tool-call suppression
- forced finalization near the step limit
- partial-result fallback instead of killing the entire Crew
- Reviewer `PASS / FAIL` discipline
- bounded Coder Fix -> Reviewer Recheck loops

Maximum automatic review/fix cycles:

```text
difyForVscode.crewMaxReviewCycles
```

Default:

```text
2
```

---

# 18. YOLO mode and approvals

With YOLO OFF, potentially mutating actions ask for approval.

This includes:

- file writes/moves/deletes
- shell commands
- browser actions with side effects
- potentially mutating MCP tools
- Crew sub-agent mutations
- Office creation/modification
- Office PDF rendering

Toggle:

```text
Dify for VS Code: Toggle YOLO Mode
```

For autonomous work on a trusted workspace, YOLO can reduce interruptions. For important coding projects, commit to Git before large autonomous tasks.

---

# 19. Running state in the chat UI

When a task is running, the Send button changes from:

```text
Send
```

to a visible spinner / working state:

```text
Working
```

The status area also shows the current top-level Agent step, for example:

```text
Dify thinking - step 3/40
```

The UI returns to normal after completion or error.

---

# 20. Recommended acceptance tests

After installing a new VSIX, test in this order.

## A — Dify protocol

```text
ping
```

## B — Local workspace tools

```text
Read package.json and tell me the current extension version.
```

## C — PowerPoint

```text
创建一个 5 页的 corporate-light 中文测试 PPT，介绍 Dify for VS Code 的能力，保存为 office-test/demo.pptx，然后用 ppt_inspect 检查。
```

Expected primary tools:

```text
ppt_create
ppt_inspect
```

## D — Excel

```text
创建 office-test/demo.xlsx，包含 Summary 和 Detail 两个 Sheet，填入一些演示数据，冻结表头并启用筛选，之后用 excel_inspect 检查。
```

Expected:

```text
excel_create
excel_inspect
```

## E — Word

```text
创建 office-test/demo.docx，写一份结构化测试报告，包含标题、二级标题、项目符号和表格，然后用 word_inspect 检查。
```

Expected:

```text
word_create
word_inspect
```

## F — Office edit

```text
把刚才 PPT 的第二页改成两栏布局；Excel 追加两行；Word 最后追加一个“下一步”章节。
```

Expected tools include:

```text
ppt_update
excel_append_rows
word_update
```

## G — Browser

```text
Open https://example.com, inspect it and tell me the visible heading.
```

## H — Crew

```text
必须使用 run_crew，让 architect、coder、reviewer 分工分析当前项目并完成一个小改进。
```

---

# 21. Configuration reference

| Setting | Default | Purpose |
| --- | --- | --- |
| `difyForVscode.baseUrl` | `http://127.0.0.1/v1` | Dify API base URL |
| `difyForVscode.userId` | `vscode-agent` | Dify user identifier |
| `difyForVscode.yoloMode` | `false` | Auto-approve mutating operations |
| `difyForVscode.maxAgentSteps` | `40` | Maximum top-level Dify/tool loop steps |
| `difyForVscode.commandTimeoutMs` | `120000` | Shell/patch/Git timeout |
| `difyForVscode.checkUpdatesOnStartup` | `true` | Check GitHub Releases on startup |
| `difyForVscode.browserChannel` | `auto` | Browser channel |
| `difyForVscode.browserExecutablePath` | empty | Explicit browser executable |
| `difyForVscode.browserHeadless` | `false` | Headless browser mode |
| `difyForVscode.browserIgnoreHTTPSErrors` | `false` | Ignore browser TLS errors |
| `difyForVscode.mcpServers` | `{}` | External MCP servers |
| `difyForVscode.mcpBridgeEnabled` | `false` | Auto-start MCP bridge |
| `difyForVscode.mcpBridgePort` | `8765` | MCP bridge port |
| `difyForVscode.mcpBridgeRequireToken` | `true` | Require bridge bearer token |
| `difyForVscode.semanticEmbeddingBaseUrl` | empty | Embedding endpoint |
| `difyForVscode.semanticEmbeddingModel` | empty | Embedding model |
| `difyForVscode.semanticIndexMaxFiles` | `2500` | Max indexed files |
| `difyForVscode.semanticChunkChars` | `3500` | Semantic chunk size |
| `difyForVscode.semanticChunkOverlapChars` | `500` | Semantic overlap |
| `difyForVscode.crewTaskMaxSteps` | `14` | Default steps per Crew task |
| `difyForVscode.crewMaxParallelTasks` | `3` | Parallel async Crew tasks |
| `difyForVscode.crewMaxReviewCycles` | `2` | Max automatic fix/re-review cycles |

Office generation has no mandatory external configuration.

---

# 22. Troubleshooting

## `messages_json is required in input form`

The published Dify Start node does not match the required contract. Import the repository DSL or verify the Start variable names, then publish again.

## Raw `<think>` or protocol JSON appears in the chat

Recommended actions:

1. Disable Thinking/Reasoning in the main Dify LLM.
2. Use the latest extension release.
3. Click **+ New Chat**.
4. Confirm the Dify LLM returns the strict protocol object.

## Office tool is not selected by the model

Make sure:

- the VSIX is v0.3.2+
- the Chatflow is using the latest recommended prompt guidance
- the Chatflow was published after changes
- the task explicitly asks for `.pptx`, `.xlsx` or `.docx` when appropriate

The Office schemas are dynamically injected into `tools_json`.

## `ppt_update` says there is no Dify editable sidecar

`ppt_update` is for PPT files originally generated with `ppt_create`.

Keep both:

```text
file.pptx
file.pptx.dify.json
```

For a third-party PowerPoint, create a new declarative presentation rather than attempting an unsafe structural rewrite.

## `word_update` says there is no Dify editable sidecar

Same concept as PowerPoint. `word_inspect` can read text from arbitrary DOCX files, but structured in-place `word_update` requires the sidecar generated by `word_create`.

## `office_render_pdf` fails

Install one of:

```text
LibreOffice
```

or, on Windows, use an installed Microsoft Office environment that supports PowerPoint/Word/Excel COM automation.

The original `.pptx`, `.xlsx` or `.docx` generation may still be completely valid even when PDF rendering is unavailable.

## Browser does not start

Try:

```json
{
  "difyForVscode.browserChannel": "msedge"
}
```

or set `browserExecutablePath` explicitly.

## MCP tools do not appear

Run:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

## Semantic search is weak

Configure a real embedding model and rebuild the workspace index.

---

# 23. Architecture

```text
VS Code UI
   |
   v
platform-entry.js
   |  lifecycle + dynamic Dify tool injection
   |
   +-- compat.js
   |     Dify protocol adapter
   |     reasoning cleanup
   |     update checks
   |
   +-- extension.js
   |     chat UI
   |     top-level agent loop
   |     approval / YOLO
   |     running-state UI
   |
   +-- agentRuntime.js
   |     Crew sub-agent loops
   |     step budgets / duplicate-call protection
   |
   +-- tools.js
   |     platform-aware execution router
   |
   +-- localTools.js
   |     workspace / files / Git / shell
   |
   +-- office.js
   |     Office tool schemas + router
   |
   +-- officePpt.js
   |     declarative PowerPoint engine
   |
   +-- officeExcel.js
   |     Excel workbook engine
   |
   +-- officeWord.js
   |     Word document engine
   |
   +-- officeCommon.js
   |     workspace safety / sidecars / PDF rendering
   |
   +-- browser.js
   |     Playwright browser automation
   |
   +-- semantic.js
   |     embeddings / vector index / memory
   |
   +-- crew.js
   |     Agent / Task / Crew orchestration
   |
   +-- mcp.js
   |     MCP client + dynamic tool discovery
   |
   +-- mcpServer.js
   |     localhost MCP bridge
   |
   +-- platform.js
         capability registry / execution routing
```

---

# 24. Development

Recommended:

```text
Node.js 22
VS Code 1.90+
```

Install:

```bash
npm install
```

Validate syntax:

```bash
npm run check
```

Build:

```bash
npm run package
```

Main runtime dependencies include:

```text
playwright-core
@modelcontextprotocol/client
@modelcontextprotocol/server
@modelcontextprotocol/node
pptxgenjs
exceljs
docx
mammoth
```

The GitHub Actions pipeline also performs actual Office smoke tests by generating PPTX/XLSX/DOCX files and reading Excel/Word back before a release is produced.

---

# 25. Recommended operating model

```text
Main Dify tool-calling LLM
  Thinking: OFF
  Temperature: 0.1 - 0.3

VS Code Agent
  YOLO: OFF for unfamiliar repositories/files
  YOLO: ON for trusted autonomous workflows

Office tasks
  Prefer native ppt_ / excel_ / word_ tools
  Inspect after generation
  Render to PDF when a local renderer exists and visual review matters

Large codebases
  Build semantic index
  Prefer a real embedding model

Complex tasks
  Let the top-level Agent invoke a Crew
  Researcher / Planner / Builder / Reviewer as needed

Before major autonomous code edits
  Commit current Git state
```

The goal is one local Agent platform that can move naturally between code, files, Office documents, web interaction, external MCP capabilities and coordinated multi-agent work.
