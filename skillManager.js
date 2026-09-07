const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { getSkillCatalog, invalidateSkillCache } = require('./skills');

const DEFAULT_GLOBAL_DIRS = ['~/.dify-for-vscode/skills', '~/.agents/skills', '~/.claude/skills'];
let refreshTimer;

function config() { return vscode.workspace.getConfiguration('difyForVscode'); }
function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}
function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
function escapeFrontmatter(value) { return String(value || '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"').trim(); }
function skillTemplate(name, description) {
  return `---\nname: ${name}\ndescription: "${escapeFrontmatter(description)}"\n---\n\n# ${name}\n\n## Purpose\n\n${description || 'Describe when this skill should be used.'}\n\n## Workflow\n\n1. Understand the user request and confirm this skill applies.\n2. Gather the required context and use available tools when needed.\n3. Produce the requested result and verify important outputs.\n\n## Rules\n\n- Do not invent tool results.\n- Keep changes scoped to the user request.\n- Reuse existing project conventions where possible.\n`;
}

function initializeSkillManager(context) {
  const watcher = vscode.workspace.createFileSystemWatcher('**/{SKILL.md,skill.md}');
  const onWorkspaceSkillChange = () => invalidateSkillCache();
  watcher.onDidCreate(onWorkspaceSkillChange, null, context.subscriptions);
  watcher.onDidChange(onWorkspaceSkillChange, null, context.subscriptions);
  watcher.onDidDelete(onWorkspaceSkillChange, null, context.subscriptions);
  context.subscriptions.push(watcher);

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => invalidateSkillCache()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('difyForVscode.skillsEnabled') ||
        event.affectsConfiguration('difyForVscode.skillsGlobalEnabled') ||
        event.affectsConfiguration('difyForVscode.skillsGlobalDirectories') ||
        event.affectsConfiguration('difyForVscode.skillsMaxFiles') ||
        event.affectsConfiguration('difyForVscode.skillsMaxReadChars')) invalidateSkillCache();
  }));

  // Global skill folders are outside the VS Code workspace and cannot use createFileSystemWatcher.
  // Invalidating the lightweight metadata cache periodically makes external edits visible on the next agent request.
  const interval = Math.max(2000, Number(config().get('skillsAutoRefreshMs', 5000) || 5000));
  refreshTimer = setInterval(() => invalidateSkillCache(), interval);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  context.subscriptions.push({ dispose() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = undefined; } });
}

async function showSkillManager() {
  invalidateSkillCache();
  const skills = await getSkillCatalog(config());
  const items = [
    { label: '$(add) Create Skill', description: 'Create a workspace or global SKILL.md', action: 'create' },
    { label: '$(refresh) Refresh Skills', description: `${skills.length} skill(s) currently discovered`, action: 'refresh' },
    { label: '$(settings-gear) Skill Settings', description: 'Open Dify for VS Code skill settings', action: 'settings' },
    ...skills.map(skill => ({
      label: `${skill.source === 'workspace' ? '$(repo)' : '$(globe)'} ${skill.name}`,
      description: `${skill.source} · ${skill.path}`,
      detail: skill.description || '(no description)',
      action: 'skill', skill
    }))
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: `Dify Skills — ${skills.filter(s => s.source === 'workspace').length} workspace / ${skills.filter(s => s.source === 'global').length} global`,
    placeHolder: 'Select a skill or management action',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true
  });
  if (!picked) return;
  if (picked.action === 'create') return createSkill();
  if (picked.action === 'refresh') {
    invalidateSkillCache();
    const refreshed = await getSkillCatalog(config());
    vscode.window.showInformationMessage(`Skills refreshed: ${refreshed.length} discovered.`);
    return refreshed;
  }
  if (picked.action === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lussifa.dify-for-vscode skills');
  if (picked.action === 'skill') return showSkillActions(picked.skill);
}

async function showSkillActions(skill) {
  const action = await vscode.window.showQuickPick([
    { label: '$(file-code) Open SKILL.md', value: 'open' },
    { label: '$(folder-opened) Reveal Skill Folder', value: 'reveal' },
    { label: '$(copy) Copy Skill ID', value: 'copy' }
  ], { title: skill.name, placeHolder: skill.description || skill.path, ignoreFocusOut: true });
  if (!action) return;
  if (action.value === 'open') {
    const uri = await resolveSkillUri(skill);
    if (uri) return vscode.window.showTextDocument(uri, { preview: false });
  }
  if (action.value === 'reveal') {
    const uri = await resolveSkillUri(skill);
    if (uri) return vscode.commands.executeCommand('revealFileInOS', uri);
  }
  if (action.value === 'copy') {
    await vscode.env.clipboard.writeText(skill.id);
    vscode.window.showInformationMessage(`Copied skill id: ${skill.id}`);
  }
}

async function resolveSkillUri(skill) {
  if (skill.source === 'workspace') {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const candidate = vscode.Uri.joinPath(folder.uri, ...String(skill.path).split('/'));
      try { await vscode.workspace.fs.stat(candidate); return candidate; } catch {}
    }
    vscode.window.showErrorMessage(`Skill file not found: ${skill.path}`);
    return null;
  }
  const rawPath = String(skill.path || '');
  const expanded = rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  const uri = vscode.Uri.file(expanded);
  try { await vscode.workspace.fs.stat(uri); return uri; } catch {
    vscode.window.showErrorMessage(`Skill file not found: ${skill.path}`);
    return null;
  }
}

async function createSkill() {
  const choices = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    choices.push({ label: `$(repo) Workspace: ${folder.name}`, description: `${folder.uri.fsPath}/.agents/skills`, scope: 'workspace', root: vscode.Uri.joinPath(folder.uri, '.agents', 'skills') });
  }
  if (config().get('skillsGlobalEnabled', true)) {
    const dirs = config().get('skillsGlobalDirectories', DEFAULT_GLOBAL_DIRS);
    for (const raw of Array.isArray(dirs) ? dirs : DEFAULT_GLOBAL_DIRS) {
      const expanded = expandHome(raw);
      choices.push({ label: `$(globe) Global: ${raw}`, description: expanded, scope: 'global', root: vscode.Uri.file(expanded) });
    }
  }
  if (!choices.length) {
    vscode.window.showWarningMessage('No workspace or global skill location is available. Open a folder or enable global skills.');
    return;
  }
  const location = await vscode.window.showQuickPick(choices, { title: 'Create Skill — Location', placeHolder: 'Choose where the skill should be stored', ignoreFocusOut: true });
  if (!location) return;

  const enteredName = await vscode.window.showInputBox({ title: 'Create Skill — Name', prompt: 'Use a short reusable name, e.g. code-review or ppt-maker', validateInput: value => slugify(value) ? undefined : 'Enter a valid skill name.', ignoreFocusOut: true });
  if (enteredName === undefined) return;
  const name = slugify(enteredName);
  const description = await vscode.window.showInputBox({ title: 'Create Skill — Description', prompt: 'Describe when the agent should use this skill.', ignoreFocusOut: true });
  if (description === undefined) return;

  const skillDir = vscode.Uri.joinPath(location.root, name);
  const skillFile = vscode.Uri.joinPath(skillDir, 'SKILL.md');
  try {
    await vscode.workspace.fs.stat(skillFile);
    vscode.window.showErrorMessage(`Skill already exists: ${name}`);
    return;
  } catch {}

  await vscode.workspace.fs.createDirectory(skillDir);
  await vscode.workspace.fs.writeFile(skillFile, Buffer.from(skillTemplate(name, description), 'utf8'));
  invalidateSkillCache();
  const doc = await vscode.workspace.openTextDocument(skillFile);
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage(`Created ${location.scope} skill: ${name}`);
  return { name, source: location.scope, path: skillFile.fsPath };
}

module.exports = { initializeSkillManager, showSkillManager, createSkill };
