const vscode = require('vscode');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { getSkillCatalog, invalidateSkillCache } = require('./skills');

const DEFAULT_GLOBAL_DIRS = ['~/.dify-for-vscode/skills', '~/.agents/skills', '~/.claude/skills'];
const MAX_SKILL_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_ZIP_ENTRIES = 2000;
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
    { label: '$(cloud-download) Install Skill from ZIP', description: 'Install one standard skill.zip into a workspace or global skill directory', action: 'install' },
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
  if (picked.action === 'install') return installSkillFromZip();
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

function skillLocations() {
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
  return choices;
}

async function chooseSkillLocation(title) {
  const choices = skillLocations();
  if (!choices.length) {
    vscode.window.showWarningMessage('No workspace or global skill location is available. Open a folder or enable global skills.');
    return null;
  }
  return vscode.window.showQuickPick(choices, { title, placeHolder: 'Choose where the skill should be stored', ignoreFocusOut: true });
}

async function createSkill() {
  const location = await chooseSkillLocation('Create Skill — Location');
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

function normalizedZipPath(value) {
  let text = String(value || '').replace(/\\/g, '/');
  while (text.startsWith('./')) text = text.slice(2);
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text) || text.includes('\0')) throw new Error(`Unsafe ZIP path: ${value}`);
  const parts = text.split('/').filter(Boolean);
  if (parts.some(part => part === '..')) throw new Error(`Unsafe ZIP path traversal: ${value}`);
  return parts.join('/');
}

function isIgnoredZipEntry(name) {
  return name === '__MACOSX' || name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store') || name === '.DS_Store';
}

function frontmatterSkillName(markdown) {
  const text = String(markdown || '');
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return '';
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s*name\s*:\s*(.+?)\s*$/i);
    if (!item) continue;
    return item[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function inspectSkillZip(buffer, fileName) {
  if (buffer.length > MAX_SKILL_ZIP_BYTES) throw new Error('Skill ZIP is larger than 25 MB.');
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(entry => {
    const normalized = normalizedZipPath(entry.entryName);
    return normalized && !isIgnoredZipEntry(normalized);
  });
  if (!entries.length) throw new Error('Skill ZIP is empty.');
  if (entries.length > MAX_SKILL_ZIP_ENTRIES) throw new Error(`Skill ZIP contains too many entries (${entries.length}; max ${MAX_SKILL_ZIP_ENTRIES}).`);

  let declaredBytes = 0;
  const normalizedEntries = entries.map(entry => {
    const name = normalizedZipPath(entry.entryName);
    if (!entry.isDirectory) declaredBytes += Number(entry.header?.size || 0);
    return { entry, name };
  });
  if (declaredBytes > MAX_SKILL_UNPACKED_BYTES) throw new Error('Skill ZIP expands beyond the 100 MB safety limit.');

  const skillFiles = normalizedEntries.filter(item => !item.entry.isDirectory && /(^|\/)skill\.md$/i.test(item.name));
  if (skillFiles.length !== 1) throw new Error(`Expected exactly one SKILL.md entrypoint, found ${skillFiles.length}.`);
  const skillItem = skillFiles[0];
  const root = path.posix.dirname(skillItem.name) === '.' ? '' : path.posix.dirname(skillItem.name);

  const files = [];
  for (const item of normalizedEntries) {
    if (item.entry.isDirectory) continue;
    if (root && !(item.name === root || item.name.startsWith(`${root}/`))) {
      throw new Error(`ZIP contains files outside the skill root: ${item.name}`);
    }
    const relative = root ? item.name.slice(root.length + 1) : item.name;
    if (!relative) continue;
    files.push({ entry: item.entry, relative });
  }

  const skillMarkdown = skillItem.entry.getData().toString('utf8');
  const archiveBase = path.basename(String(fileName || 'skill.zip'), path.extname(String(fileName || 'skill.zip')));
  const rootBase = root ? path.posix.basename(root) : archiveBase;
  const rawName = frontmatterSkillName(skillMarkdown) || rootBase;
  const name = slugify(rawName);
  if (!name) throw new Error('Could not determine a valid skill name from SKILL.md or the ZIP folder name.');
  return { name, rawName, files, skillRelativePath: root ? skillItem.name.slice(root.length + 1) : skillItem.name };
}

async function installSkillFromZip() {
  const picked = await vscode.window.showOpenDialog({
    title: 'Install Skill from ZIP',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'Skill ZIP': ['zip'] },
    openLabel: 'Select Skill ZIP'
  });
  if (!picked || !picked.length) return;

  try {
    const zipUri = picked[0];
    const zipBytes = Buffer.from(await vscode.workspace.fs.readFile(zipUri));
    const inspected = inspectSkillZip(zipBytes, path.basename(zipUri.fsPath));
    const location = await chooseSkillLocation(`Install Skill — ${inspected.name}`);
    if (!location) return;

    const skillDir = vscode.Uri.joinPath(location.root, inspected.name);
    let exists = false;
    try { await vscode.workspace.fs.stat(skillDir); exists = true; } catch {}
    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `Skill already exists in this location: ${inspected.name}`,
        { modal: true, detail: `Installing will replace the existing skill folder at ${skillDir.fsPath}.` },
        'Replace Skill'
      );
      if (choice !== 'Replace Skill') return;
      await vscode.workspace.fs.delete(skillDir, { recursive: true, useTrash: false });
    }

    await vscode.workspace.fs.createDirectory(skillDir);
    let writtenBytes = 0;
    for (const file of inspected.files) {
      const data = file.entry.getData();
      writtenBytes += data.length;
      if (writtenBytes > MAX_SKILL_UNPACKED_BYTES) throw new Error('Skill ZIP exceeded the 100 MB unpacked safety limit while extracting.');
      const relativeParts = file.relative.split('/').filter(Boolean);
      const target = vscode.Uri.joinPath(skillDir, ...relativeParts);
      const parentParts = relativeParts.slice(0, -1);
      if (parentParts.length) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(skillDir, ...parentParts));
      await vscode.workspace.fs.writeFile(target, data);
    }

    const installedSkillFile = vscode.Uri.joinPath(skillDir, ...inspected.skillRelativePath.split('/').filter(Boolean));
    await vscode.workspace.fs.stat(installedSkillFile);
    invalidateSkillCache();
    const action = await vscode.window.showInformationMessage(`Installed ${location.scope} skill: ${inspected.name}`, 'Open SKILL.md', 'Manage Skills');
    if (action === 'Open SKILL.md') {
      const doc = await vscode.workspace.openTextDocument(installedSkillFile);
      await vscode.window.showTextDocument(doc, { preview: false });
    } else if (action === 'Manage Skills') {
      return showSkillManager();
    }
    return { name: inspected.name, source: location.scope, path: skillDir.fsPath, files: inspected.files.length };
  } catch (error) {
    vscode.window.showErrorMessage(`Skill installation failed: ${error instanceof Error ? error.message : String(error)}`, { modal: true });
    return null;
  }
}

module.exports = { initializeSkillManager, showSkillManager, createSkill, installSkillFromZip, inspectSkillZip };
