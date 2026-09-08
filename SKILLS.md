# Skills

Dify for VS Code can discover reusable agent instructions from `SKILL.md` or `skill.md` files in both the current VS Code workspace and user-level global skill directories.

## Workspace skills

Common project layouts work without extra configuration:

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

Workspace discovery scans the whole open workspace while excluding common generated/vendor directories.

## Global skills

Global skills are enabled by default. The extension recursively scans:

```text
~/.dify-for-vscode/skills
~/.agents/skills
~/.claude/skills
```

You can change the list with `difyForVscode.skillsGlobalDirectories`.

Example:

```json
{
  "difyForVscode.skillsGlobalDirectories": [
    "~/.dify-for-vscode/skills",
    "D:/ai/shared-skills"
  ]
}
```

Paths beginning with `~` are expanded to the current user's home directory. Absolute paths are also supported.

If a workspace skill and a global skill have the same `name`, the **workspace skill wins**. This lets a project override a shared global workflow without changing the global copy.

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

The extension discovers only skill metadata first and injects a compact catalog into the Dify agent context. Complete skill instructions are loaded only when the model determines that a skill matches the current task.

Three read-only tools are exposed to the model:

- `skills_list` — rediscover and list workspace and global skills, including their source.
- `skills_read` — load the complete `SKILL.md` instructions for one skill.
- `skills_read_resource` — load a UTF-8 text resource inside that skill directory.

Skill resources are sandboxed to their owning skill directory; `../` traversal is rejected. Global directory traversal also skips symbolic links, preventing recursive symlink loops or accidental traversal into unrelated trees.

## Skill manager UI

Open the Command Palette and run **Dify for VS Code: Manage Skills**.

The manager shows workspace and global skills together and provides these actions:

- **Create Skill** — create a new workspace or global skill.
- **Install Skill from ZIP** — choose and install a standard single-skill `.zip` package.
- **Refresh Skills** — invalidate discovery metadata and rescan immediately.
- **Skill Settings** — open the extension settings filtered to skill options.
- **Open SKILL.md** — open a skill definition for editing.
- **Reveal Skill Folder** — show the skill in the operating system file manager.
- **Copy Skill ID** — copy the exact skill identifier used by `skills_read`.

There are also dedicated **Dify for VS Code: Create Skill** and **Dify for VS Code: Install Skill from ZIP** commands. Both **Manage Skills** and **Install Skill from ZIP** are available from the Dify sidebar title toolbar.

## Installing a skill ZIP

Use **Dify for VS Code: Install Skill from ZIP** from the Command Palette, the Dify sidebar title toolbar, or the Skill Manager.

The installer accepts a standard ZIP containing exactly one skill entrypoint:

```text
my-skill.zip
  my-skill/
    SKILL.md
    agents/
      openai.yaml
    scripts/
    references/
    assets/
```

A ZIP with the skill files directly at archive root is also supported:

```text
skill.zip
  SKILL.md
  agents/
  scripts/
  references/
  assets/
```

Installation flow:

1. Select the local `.zip` file.
2. The extension validates the archive before writing anything.
3. Choose a workspace or configured global skill location.
4. If the same skill already exists there, explicitly confirm replacement.
5. The complete skill bundle is extracted and the skill catalog is refreshed immediately.

The install name comes from `name:` in the `SKILL.md` frontmatter when available. Otherwise it falls back to the skill folder or ZIP filename and is normalized to lowercase slug form.

Safety checks include:

- Exactly one `SKILL.md` / `skill.md` entrypoint per ZIP.
- Maximum compressed ZIP size: 25 MB.
- Maximum declared/extracted content size: 100 MB.
- Maximum ZIP entries: 2000.
- Reject absolute paths and `..` path traversal.
- Reject archive files outside the detected single-skill root.
- Ignore common macOS packaging metadata such as `__MACOSX` and `.DS_Store`.
- Files are written as normal files rather than restoring ZIP symlink metadata.

## Creating a skill

The Create Skill flow asks for:

1. A storage location.
2. A short skill name.
3. A description explaining when the agent should use it.

Workspace skills created by the UI are placed under:

```text
<workspace>/.agents/skills/<skill-name>/SKILL.md
```

Global skills can be created under any directory listed in `difyForVscode.skillsGlobalDirectories`.

The generated file contains frontmatter plus a small starter workflow and rules section. It is opened immediately after creation so you can refine the instructions.

Names are normalized to lowercase slug form, for example:

```text
PowerPoint Maker -> powerpoint-maker
Code Review     -> code-review
```

Creation refuses to overwrite an existing `SKILL.md` with the same name/location.

## Automatic refresh

Workspace skills use a VS Code file-system watcher. Creating, editing, renaming, or deleting `SKILL.md` / `skill.md` files invalidates the skill catalog immediately.

Global skills live outside the workspace, so their metadata cache is invalidated periodically. The next agent request or manager refresh then rescans the configured global directories.

The interval is controlled by:

```text
difyForVscode.skillsAutoRefreshMs
```

Default: `5000` ms. Minimum: `2000` ms.

Skill-related setting changes and workspace-folder changes also invalidate the catalog automatically.

## Settings

- `difyForVscode.skillsEnabled` — master skill support switch. Default: `true`.
- `difyForVscode.skillsGlobalEnabled` — enable user-level global skill discovery. Default: `true`.
- `difyForVscode.skillsGlobalDirectories` — global directories to scan. Default: `~/.dify-for-vscode/skills`, `~/.agents/skills`, `~/.claude/skills`.
- `difyForVscode.skillsAutoRefreshMs` — global-skill refresh interval. Default: `5000`.
- `difyForVscode.skillsMaxFiles` — maximum workspace + global skill files discovered in total. Default: `200`.
- `difyForVscode.skillsMaxReadChars` — maximum characters returned from one skill/resource read. Default: `120000`.

## Precedence and IDs

Each discovered skill exposes a stable-ish ID prefixed by its source:

```text
workspace:my-project:.agents/skills/release-helper/SKILL.md
global:~/.agents/skills:release-helper/SKILL.md
```

The model can address a skill by ID, exact name, or path. Workspace skills are placed before global skills and override global skills with the same name.

## Notes

- Workspace discovery excludes `node_modules`, `.git`, `.svn`, `.hg`, `dist`, `out`, `build`, `coverage`, and `vendor`.
- Global discovery skips those directories as well and does not follow symbolic links.
- Skills remain read-only guidance from the model's perspective. Creating or installing a skill is an explicit user command in the VS Code UI; other mutations still go through the extension's normal local/platform tools and YOLO/approval policy.
- The skill catalog is cached briefly for request efficiency and automatically invalidated by workspace skill changes, settings changes, workspace-folder changes, the global refresh timer, and successful ZIP installs.
