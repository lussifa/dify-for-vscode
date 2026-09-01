# Dify for VS Code

A Dify-powered VS Code **agent platform** that turns a Dify Chatflow into a practical local agent for coding, Office automation, browser work, MCP tools, semantic retrieval and multi-agent collaboration.

It combines:

- native VS Code chat UI
- local workspace/code/file tools
- shell and Git operations
- **PowerPoint, Excel and Word generation/editing**
- **Presentation Design Engine with design review**
- **task-aware Context Manager**
- Playwright browser automation
- MCP client with dynamic tool discovery
- local MCP bridge server
- semantic workspace indexing and long-term vector memory
- CrewAI-inspired multi-agent orchestration
- approval controls and YOLO auto-approval
- GitHub Release update checking

The extension talks **directly to your Dify Chatflow**. Roo Code, Cline, Continue, Claude Code, or another middle layer is not required.

> Current release: **v0.3.3**

---

# 1. Architecture at a glance

```text
User
  |
  v
VS Code / Dify for VS Code
  |
  +-- Context Manager
  +-- local workspace / code / shell / Git
  +-- Office: PPT / Excel / Word
  |     +-- Presentation Design Engine
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

The main design principle is:

```text
Dify = reasoning / orchestration
VS Code extension = local execution + context control
```

The model receives the current conversation context and exact dynamic tool list. The extension executes requested tools locally and sends real results back to Dify.

---

# 2. Quick start

## Step 1 — Install the VSIX

Download the latest release:

https://github.com/lussifa/dify-for-vscode/releases

Then in VS Code:

```text
Extensions
-> ...
-> Install from VSIX...
```

After installation, the **Dify** icon appears in the VS Code Activity Bar.

---

## Step 2 — Prepare the Dify Chatflow

The recommended method is to download the ready-made Dify Chatflow DSL from this repository and import it directly into Dify.

### Download the Chatflow DSL

GitHub file page:

https://github.com/lussifa/dify-for-vscode/blob/main/dify/coding-agent1.yml

Direct / raw download:

https://raw.githubusercontent.com/lussifa/dify-for-vscode/main/dify/coding-agent1.yml

File name:

```text
coding-agent1.yml
```

Import in Dify:

```text
Dify
-> Create App / Import DSL
-> Import DSL File
-> select coding-agent1.yml
```

Recommended topology:

```text
Start
  -> LLM
  -> Answer
```

The extension owns the tool-execution loop, so the Dify workflow itself does not need another tool loop.

### Required Start variables

| Variable | Type | Required | Description |
| --- | --- | ---: | --- |
| `messages_json` | Paragraph / long text | Yes | OpenAI-compatible conversation/tool context |
| `tools_json` | Paragraph / long text | Yes | Exact dynamic tool schemas supplied by the extension |
| `tool_choice_json` | Text | Recommended | Normally `"auto"` |
| `retry_feedback` | Text | Optional | Reserved compatibility feedback |

After changing the Chatflow, always click **Publish / Update** because API calls use the published application version.

Agent prompt reference:

```text
dify/chatflow-prompt.md
```

---

# 3. Recommended Dify LLM settings

For the main tool-calling Chatflow:

```text
Thinking / Reasoning: OFF
Temperature: 0.1 - 0.3
Tool choice: auto
Output: strict JSON
```

Normal final response:

```json
{
  "type": "message",
  "content": "Task completed.",
  "tool_calls": []
}
```

Tool request:

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

The extension strips common `<think>`, `<analysis>` and `<reasoning>` wrappers, but keeping Thinking disabled for the main execution model normally gives cleaner protocol output, lower latency and lower token use.

---

# 4. Configure the extension

Run:

```text
Dify for VS Code: Configure
```

Enter:

```text
Base URL: https://dify.example.com/v1
App API Key: app-xxxxxxxxxxxxxxxx
User ID: vscode-agent
```

If Dify documents:

```text
https://dify.example.com/v1/chat-messages
```

configure only:

```text
https://dify.example.com/v1
```

The extension appends `/chat-messages` itself. The API key is stored in VS Code SecretStorage.

---

# 5. Context Manager — v0.3.3

Before v0.3.3, if you did not click **+ New Chat**, the entire accumulated history — including old tool calls and large tool results — was sent to the LLM again on every new request.

v0.3.3 adds a task-aware Context Manager.

## How it works

Each top-level user Send is treated as a task boundary:

```text
Task 1
user request
assistant tool calls
large tool results
final answer

Task 2
...

Task 3 = current task
```

The Context Manager keeps recent tasks detailed, but older completed tasks become compact summaries:

```text
Old task
30,000+ characters of tool history
        |
        v
[Context Manager: previous task summaries]
Task: organize demo files
Outcome: 20 files renamed and archived
Tools: list_files, file_info, rename_file, move_file, excel_create
Artifacts: demo/file_manifest.xlsx
```

This preserves continuity without repeatedly sending large historical tool payloads.

## Important behavior

```text
Visible chat history != outbound LLM execution context
```

The sidebar still keeps the user/assistant conversation visible. Context compaction only affects the execution history sent to Dify.

## Recent tasks remain detailed

Default:

```text
contextRecentTasks = 2
```

This preserves follow-up workflows while older unrelated work is summarized.

## Context budget

Defaults:

```text
contextMaxChars                 120000
contextToolResultMaxChars        12000
contextStoredToolResultMaxChars   6000
contextSummaryMaxChars           16000
```

The Context Manager prioritizes keeping the current task and current tool-call/result cycle intact.

## Sidebar context indicator

The sidebar can show information similar to:

```text
context 42k/120k | 3 summarized
```

## Context settings

```json
{
  "difyForVscode.contextManagerEnabled": true,
  "difyForVscode.contextRecentTasks": 2,
  "difyForVscode.contextMaxChars": 120000,
  "difyForVscode.contextToolResultMaxChars": 12000,
  "difyForVscode.contextStoredToolResultMaxChars": 6000,
  "difyForVscode.contextSummaryMaxChars": 16000
}
```

If you need a completely clean conversation, **+ New Chat** still clears the context.

---

# 6. Office subsystem

Office capabilities are native platform tools:

```text
Dify for VS Code
  +-- PowerPoint (.pptx)
  +-- Excel (.xlsx)
  +-- Word (.docx)
```

The LLM does not need to generate Python, VBA, JavaScript or raw OOXML just to create an Office document.

For normal `.pptx`, `.xlsx` and `.docx` generation, Microsoft Office does **not** need to be installed.

Office tools can also be used by Crew sub-agents and exposed through the local MCP bridge.

---

# 7. Presentation Design Engine — v0.3.3

v0.3.2 could reliably generate PPTX files, but its visual language was intentionally limited. v0.3.3 upgrades PowerPoint generation into a **Presentation Design Engine**.

```text
story / design intent
        |
        v
visual slide archetype
        |
        v
typography + cards + spacing + hierarchy
        |
        v
PPTX
        |
        v
design review
        |
        v
optional revision
```

## PowerPoint tools

```text
ppt_create
ppt_update
ppt_inspect
ppt_design_review
office_render_pdf
```

## Built-in themes

```text
corporate-light
corporate-dark
minimal
training
executive
tech
editorial
consulting
```

Suggested use:

| Theme | Use |
| --- | --- |
| `consulting` | clean business / management / internal review |
| `executive` | executive narrative / strategy |
| `editorial` | polished report / storytelling |
| `tech` | dark technology / AI / architecture |
| `corporate-light` | general enterprise |
| `corporate-dark` | dark enterprise |
| `training` | approachable learning content |
| `minimal` | restrained, low-decoration deck |

## Design mode

```text
safe
polished
bold
```

Recommended default:

```text
polished
```

## Visual slide archetypes

Basic layouts:

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

Design-oriented archetypes:

```text
hero_statement
hero_number
kpi_cards
three_cards
comparison
before_after
process
timeline
matrix
data_story
chart_insight
closing
```

These use distinct typography, spatial composition, cards, metrics and hierarchy rather than only changing text placement.

## Archetype examples

### `hero_number`

Use for one dominant metric. Relevant fields:

```text
metric_value
metric_label
metric_detail
```

### `kpi_cards`

Use `metrics[]` with:

```text
value
label
detail
trend
```

### `process`

Use `steps[]` for a short visual workflow:

```text
Collect -> Analyze -> Execute -> Verify
```

### `comparison` / `before_after`

Use paired titles, short explanatory text and concise bullet groups.

### `data_story`

Combines a dominant metric with supporting KPI cards.

### `chart_insight`

Uses a large chart plus a separate key-insight panel so the slide communicates a conclusion instead of displaying a chart without interpretation.

---

# 8. PowerPoint design workflow

Recommended Agent flow:

```text
ppt_create
    |
    v
ppt_design_review
    |
    +-- excellent/good -> ppt_inspect -> finish
    |
    +-- revise/poor
          |
          v
       ppt_update weak slides
          |
          v
       ppt_design_review again
```

Normally stop after at most two design-revision cycles unless further refinement is requested.

## `ppt_design_review`

The reviewer returns:

```text
score
grade
findings
recommendations
archetype_count
visual_slide_count
```

It checks risks such as:

- excessive slide text
- too many bullets
- overlong titles
- repeated slide archetypes
- insufficient visual variety
- oversized tables
- charts with too many categories
- malformed four-quadrant matrix slides

Grades:

```text
90-100  excellent
80-89   good
70-79   revise
<70     poor
```

Important: `ppt_design_review` is currently a **structural/design heuristic**, not a multimodal screenshot critic.

For rendered preview use `office_render_pdf` when LibreOffice or compatible Microsoft Office automation is available locally.

## PPT update model

`ppt_create` writes:

```text
presentation.pptx
presentation.pptx.dify.json
```

Supported update actions:

```text
replace_slide
append_slide
delete_slide
set_title
set_theme
```

---

# 9. Recommended PPT prompt

```text
帮我做一份 8 页的《AI办公自动化》汇报 PPT。

要求：
- theme 使用 consulting
- design_mode 使用 polished
- 中文
- 面向管理层和普通办公室员工
- 每页只表达一个核心观点
- 不要连续使用三页相同布局
- 不要把内容全部做成 bullets
- 至少使用：hero_number、kpi_cards、process、comparison、chart_insight、closing
- 文案精炼，强调视觉层级和留白
- 保存为 reports/AI办公自动化.pptx
- 创建后必须执行 ppt_design_review
- 如果设计分低于 80 或 grade 为 revise/poor，按 findings 使用 ppt_update 改版，再 review 一次
- 最后使用 ppt_inspect 检查结构
```

---

# 10. Excel automation

Excel tools:

```text
excel_create
excel_inspect
excel_write_range
excel_append_rows
excel_format_range
```

Capabilities include multiple worksheets, styled headers, frozen rows, filters, widths, number formats, formulas, hyperlinks, dates and direct range edits.

Recommended existing-workbook pattern:

```text
excel_inspect
-> excel_write_range / excel_append_rows / excel_format_range
-> excel_inspect
```

Formula value example:

```json
{
  "formula": "SUM(B2:B20)",
  "result": 12345
}
```

---

# 11. Word automation

Word tools:

```text
word_create
word_update
word_inspect
```

Supported blocks:

```text
heading
paragraph
bullets
numbered
table
quote
page_break
```

Dify-generated Word files receive a `.docx.dify.json` sidecar for structured updates.

Supported actions:

```text
replace_block
append_block
delete_block
set_title
```

`word_inspect` can read text from arbitrary existing DOCX files. External DOCX files without sidecars should normally be inspected and rewritten to a new output rather than structurally edited in place.

---

# 12. Office PDF preview

`office_render_pdf` can render `.pptx`, `.xlsx` and `.docx`.

Renderer preference:

```text
1. LibreOffice
2. Microsoft Office COM fallback on Windows
```

Document generation itself does not depend on a renderer.

---

# 13. Office + multi-agent workflow

Example presentation Crew:

```text
Researcher
    |
    v
Content Planner
    |
    v
Presentation Designer
    |
    v
PPT Builder
    |
    v
Design Reviewer
```

Example:

```text
必须使用 run_crew 做季度业务复盘 PPT。

Researcher：读取 Excel 和相关资料，整理事实。
Content Planner：规划故事线，每页一个核心信息。
Presentation Designer：为每页选择合适的 PPT visual archetype。
PPT Builder：使用 ppt_create 创建 PPT。
Design Reviewer：执行 ppt_design_review；如果 grade 为 revise/poor，给出修改建议。
Builder 使用 ppt_update 修改，然后 Reviewer 再检查一次。
```

---

# 14. Core local tools

Read / inspect:

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

Edit / file management:

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

Execution / Git:

```text
run_command
git_status
git_diff
```

External / interaction:

```text
fetch_url
ask_user
```

---

# 15. Browser automation

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

Recommended pattern:

```text
browser_open
-> browser_snapshot
-> inspect stable refs
-> interact
-> browser_snapshot again
```

`playwright-core` is included, but the VSIX does not bundle a browser. Install Edge, Chrome or Chromium locally.

---

# 16. MCP client

Configure external MCP servers through:

```text
difyForVscode.mcpServers
```

The extension supports stdio, Streamable HTTP and SSE compatibility.

Useful commands:

```text
Dify for VS Code: Refresh MCP Servers
Dify for VS Code: Show MCP Status
```

Discovered tools use names similar to:

```text
mcp__filesystem__read_file
mcp__database__query
```

---

# 17. MCP bridge server

Start:

```text
Dify for VS Code: Start MCP Bridge Server
```

Default endpoint:

```text
http://127.0.0.1:8765/mcp
```

The bridge binds to localhost and uses a generated bearer token by default.

Copy configuration with:

```text
Dify for VS Code: Copy MCP Bridge Client Config
```

---

# 18. Semantic workspace index and memory

```text
semantic_index_build
semantic_search
semantic_index_status
semantic_index_clear
memory_save
memory_search
memory_clear
```

Configure embeddings with:

```text
Dify for VS Code: Configure Semantic Embeddings
```

Ollama example:

```text
Base URL: http://127.0.0.1:11434/v1
Model: nomic-embed-text
```

Without a configured embedding provider, the local code-aware feature-hash fallback is used.

---

# 19. Multi-agent Crew

Top-level tool:

```text
run_crew
```

Crews support sequential/hierarchical processing, planning, memory, task dependencies, async execution, per-agent tool allowlists and bounded reviewer FAIL -> fix -> recheck cycles.

---

# 20. YOLO mode

With YOLO OFF, mutating operations require approval. YOLO can auto-approve file writes, commands, browser side effects, Office writes, Crew mutations and potentially mutating MCP tools.

---

# 21. New Chat and history

`+ New Chat` still means a completely clean context.

Without New Chat in v0.3.3:

```text
recent tasks -> detailed
older completed tasks -> Context Manager summaries
visible chat -> retained separately
```

---

# 22. Configuration reference

| Setting | Default | Purpose |
| --- | ---: | --- |
| `difyForVscode.baseUrl` | `http://127.0.0.1/v1` | Dify API base URL |
| `difyForVscode.userId` | `vscode-agent` | Dify user identifier |
| `difyForVscode.yoloMode` | `false` | Auto-approve mutations |
| `difyForVscode.maxAgentSteps` | `40` | Top-level loop limit |
| `difyForVscode.contextManagerEnabled` | `true` | Enable task-aware context compaction |
| `difyForVscode.contextRecentTasks` | `2` | Recent detailed tasks |
| `difyForVscode.contextMaxChars` | `120000` | Approximate outbound context budget |
| `difyForVscode.contextToolResultMaxChars` | `12000` | Per-tool outbound result limit |
| `difyForVscode.contextStoredToolResultMaxChars` | `6000` | Tool result retained after persistent compaction |
| `difyForVscode.contextSummaryMaxChars` | `16000` | Old-task summary budget |
| `difyForVscode.commandTimeoutMs` | `120000` | Shell/patch/Git timeout |
| `difyForVscode.browserChannel` | `auto` | Browser channel |
| `difyForVscode.browserHeadless` | `false` | Headless browser mode |
| `difyForVscode.mcpServers` | `{}` | External MCP servers |
| `difyForVscode.mcpBridgeEnabled` | `false` | Auto-start MCP bridge |
| `difyForVscode.mcpBridgePort` | `8765` | MCP bridge port |
| `difyForVscode.semanticEmbeddingBaseUrl` | empty | Embedding endpoint |
| `difyForVscode.semanticEmbeddingModel` | empty | Embedding model |
| `difyForVscode.crewTaskMaxSteps` | `14` | Default Crew task budget |
| `difyForVscode.crewMaxParallelTasks` | `3` | Parallel async Crew tasks |
| `difyForVscode.crewMaxReviewCycles` | `2` | Automatic review/fix cycles |

---

# 23. Recommended acceptance tests

## Context Manager

Run several unrelated tool-heavy tasks without clicking New Chat. Old user/assistant messages should remain visible while the sidebar starts showing summarized context usage.

## Presentation Design Engine

```text
制作一份 8 页 AI 办公自动化 PPT。
使用 consulting + polished。
至少使用 hero_number、kpi_cards、process、comparison、data_story、chart_insight、closing。
创建后执行 ppt_design_review；低于80自动修改一次。
```

Expected flow:

```text
ppt_create
ppt_design_review
optional ppt_update
ppt_design_review
ppt_inspect
```

---

# 24. Troubleshooting

## `messages_json is required in input form`

Verify the imported/published Chatflow Start variables and publish again.

## PPT still looks too text-heavy

Use explicit visual-archetype requirements and run `ppt_design_review`. "Make it beautiful" alone is less precise than specifying the desired design language.

## Context misses an old exact tool detail

That low-level detail may have been summarized. Ask the Agent to inspect the current workspace/file again.

## `office_render_pdf` fails

Install LibreOffice or use compatible Microsoft Office automation. Office document generation itself can still succeed.

---

# 25. Architecture

```text
platform-entry.js
  |
  +-- compat.js
  +-- extension.js
  |     top-level chat / agent loop / display history
  +-- contextManager.js
  |     task summaries / tool trimming / context budget
  +-- agentRuntime.js
  +-- tools.js / localTools.js
  +-- office.js
  |     Office schemas/router
  +-- officePptDesign.js
  |     visual archetypes / typography / design review
  +-- officeExcel.js
  +-- officeWord.js
  +-- officeCommon.js
  +-- browser.js
  +-- semantic.js
  +-- crew.js
  +-- mcp.js
  +-- mcpServer.js
  +-- platform.js
```

---

# 26. Development

```text
Node.js 22 recommended
VS Code 1.90+
```

```bash
npm install
npm run check
npm run package
```

GitHub Actions validates syntax/runtime exports, the Context Manager, native Office round-trips and a multi-archetype designed PPT before a VSIX release is produced.
