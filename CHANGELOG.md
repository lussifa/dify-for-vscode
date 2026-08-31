# Changelog

## 0.3.2

- Add native Office subsystem to the existing Dify agent platform
- Add declarative PowerPoint generation with built-in themes and title/section/bullets/two-column/table/chart/quote/blank slide layouts
- Add PowerPoint chart support for bar, column, line, pie and doughnut charts
- Add `ppt_create`, `ppt_update` and `ppt_inspect`
- Persist editable `.pptx.dify.json` sidecars so Agent-generated presentations can be rebuilt and updated reliably
- Add Excel workbook creation with multiple sheets, styled headers, freeze panes, filters, widths, number formats, formulas, hyperlinks and dates
- Add `excel_create`, `excel_inspect`, `excel_write_range`, `excel_append_rows` and `excel_format_range`
- Add declarative Word generation with headings, paragraphs, bullets, numbered lists, tables, quotes and page breaks
- Add `word_create`, `word_update` and `word_inspect`; arbitrary DOCX files can be text-inspected with Mammoth
- Persist editable `.docx.dify.json` sidecars for reliable structured updates to Agent-generated Word documents
- Add `office_render_pdf` with LibreOffice-first rendering and Microsoft Office COM fallback on Windows
- Make Office tools available to top-level Dify agents, Crew sub-agents and the local MCP bridge
- Treat Office writes/rendering as approval-gated mutations unless YOLO is enabled
- Add PptxGenJS, ExcelJS, docx and Mammoth runtime dependencies
- Extend CI with real PPTX/XLSX/DOCX generation smoke tests and Excel/Word round-trip validation
- Add pull-request CI before merging/releasing changes
- Keep MCP bridge server version synchronized automatically with `package.json`
- Expand README and Dify agent guidance for Office-native workflows

## 0.3.1

- Add sub-agent execution-budget hints so agents know when they must finish
- Detect and block repeated identical tool calls inside Crew sub-agents
- Force a final tool-free summary when a sub-agent reaches its step budget
- Return partial sub-agent results instead of failing the entire Crew on max-step exhaustion
- Add bounded reviewer FAIL -> implementation fix -> reviewer recheck cycles
- Add `difyForVscode.crewMaxReviewCycles` setting (default 2)
- Preserve failed/partial task status and warnings for manager synthesis instead of hiding incomplete work
- Add active Send-button spinner, `Working` label, running status pulse, and proper reset on completion/error/new chat
- Align the top-level runtime fallback with the configured 40-step default

## 0.3.0

- Upgrade from single coding agent to an agent-platform architecture
- Add Playwright Core browser automation with DOM snapshots and stable element refs
- Add MCP v2 client support for stdio and Streamable HTTP plus SSE compatibility
- Dynamically discover MCP tools and expose them directly to Dify
- Add local authenticated MCP bridge server on 127.0.0.1
- Add OpenAI-compatible semantic embeddings and persisted workspace vector index
- Add offline code-aware feature-hash vector fallback
- Add long-term vector memory tools
- Add CrewAI-inspired Agent / Task / Crew orchestration
- Add sequential and hierarchical crew processes, planning, task dependencies/context and async task waves
- Serialize mutating tool calls across parallel sub-agents
- Preserve workspace tools, YOLO approvals, Dify protocol adapter and GitHub update checks

## 0.2.0

- Expand local coding/automation tool surface to 23 tools
- Add file metadata, batch reads, code definitions, patching, file move/rename/copy/delete, Git tools, web fetch and user questions
- Refactor local tool schemas/executors into `tools.js`

## 0.1.4

- Harden reasoning/protocol parsing
- Add explicit New Chat controls

## 0.1.0

- Native VS Code sidebar chat UI
- Direct Dify Chatflow API integration
- Agent tool loop
- Workspace read/list/search/write/replace tools
- Shell command execution
- VS Code diagnostics tool
- Per-action approval mode
- YOLO auto-approval mode
- SecretStorage for Dify API key
