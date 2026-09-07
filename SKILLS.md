# Workspace Skills

Dify for VS Code can discover reusable agent instructions from `SKILL.md` or `skill.md` files anywhere inside the current VS Code workspace.

Common layouts are supported without extra configuration:

```text
project/
  .claude/
    skills/
      code-review/
        SKILL.md
        checklist.md

project/
  .agents/
    skills/
      release-helper/
        SKILL.md

project/
  skills/
    powerpoint/
      SKILL.md
```

## Skill format

A skill is a directory containing a `SKILL.md` (or `skill.md`) file. YAML-style frontmatter is optional but recommended:

```markdown
---
name: code-review
description: Review changes for correctness, regressions, security issues and missing tests.
---

# Code Review

Follow this workflow when reviewing code...
```

If `name` is omitted, the first Markdown H1 heading or directory name is used. If `description` is omitted, the first body paragraph is used.

## How it works

The extension discovers skill metadata and injects a compact catalog into the Dify agent context. The complete skill instructions are loaded only when the model decides that a skill matches the current task.

Three read-only tools are exposed to the model:

- `skills_list` — rediscover and list workspace skills.
- `skills_read` — load the complete `SKILL.md` instructions for one skill.
- `skills_read_resource` — load a UTF-8 text resource inside that skill directory.

Skill resources are sandboxed to their owning skill directory; `../` traversal is rejected.

You can inspect discovery manually from the Command Palette with **Dify for VS Code: Show Workspace Skills**.

## Settings

- `difyForVscode.skillsEnabled` — enable/disable workspace skill support. Default: `true`.
- `difyForVscode.skillsMaxFiles` — maximum discovered skill files. Default: `200`.
- `difyForVscode.skillsMaxReadChars` — maximum characters returned from one skill/resource read. Default: `120000`.

## Notes

- `node_modules`, `.git`, `.svn`, `.hg`, `dist`, `out`, `build`, `coverage`, and `vendor` are excluded from discovery.
- Skills are read-only. Mutating actions still go through the extension's normal local/platform tools and existing YOLO/approval policy.
- The skill catalog is refreshed on demand and when workspace folders change.
