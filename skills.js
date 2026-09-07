const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');

const SKILL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'skills_list',
      description: 'List reusable workspace and global skills discovered from SKILL.md/skill.md files. Use this before starting work when a reusable skill may apply.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skills_read',
      description: 'Load the full instructions for one discovered skill by id, name, or path. Read a matching skill before following it.',
      parameters: {
        type: 'object',
        properties: { skill: { type: 'string', description: 'Skill id, name, or SKILL.md path returned by skills_list.' } },
        required: ['skill'], additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skills_read_resource',
      description: 'Read a UTF-8 text resource inside a discovered skill directory, such as a template, prompt, README, or script source referenced by SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill id, name, or path returned by skills_list.' },
          resource: { type: 'string', description: 'Relative path inside the skill directory.' }
        },
        required: ['skill', 'resource'], additionalProperties: false
      }
    }
  }
];

const SKILL_NAMES = new Set(SKILL_TOOLS.map(t => t.function.name));
const MAX_SKILLS = 200;
const DEFAULT_MAX_CHARS = 120000;
const DEFAULT_GLOBAL_DIRS = ['~/.dify-for-vscode/skills', '~/.agents/skills', '~/.claude/skills'];
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', 'coverage', 'vendor']);
let cache = { at: 0, key: '', skills: [] };

function normalizeSlash(value) { return String(value || '').replace(/\\/g, '/'); }
function cleanScalar(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text;
}
function parseFrontmatter(content) {
  const text = String(content || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = text.slice(3, end).split(/\r?\n/);
  const out = {};
  for (const line of block) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) out[match[1].toLowerCase()] = cleanScalar(match[2]);
  }
  return out;
}
function firstHeading(content) {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}
function firstParagraph(content) {
  const body = String(content || '').replace(/^---[\s\S]*?\n---\s*/m, '').replace(/^#.*$/gm, '').trim();
  return body.split(/\n\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
}
function expandHome(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}
function configuredGlobalDirs(config) {
  const raw = config.get('skillsGlobalDirectories', DEFAULT_GLOBAL_DIRS);
  const values = Array.isArray(raw) ? raw : DEFAULT_GLOBAL_DIRS;
  return [...new Set(values.map(expandHome).filter(Boolean))];
}
function cacheKey(config) {
  const roots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).sort();
  return JSON.stringify({
    roots,
    enabled: config.get('skillsEnabled', true),
    globalEnabled: config.get('skillsGlobalEnabled', true),
    globalDirs: configuredGlobalDirs(config),
    max: config.get('skillsMaxFiles', MAX_SKILLS)
  });
}
async function skillFromFile(filePath, metaInfo = {}) {
  const raw = await fs.readFile(filePath, 'utf8');
  const meta = parseFrontmatter(raw);
  const folder = path.dirname(filePath);
  const folderName = path.basename(folder);
  const name = meta.name || firstHeading(raw) || folderName || path.basename(filePath);
  const description = meta.description || firstParagraph(raw).slice(0, 500);
  return {
    id: metaInfo.id,
    name,
    description,
    path: metaInfo.displayPath,
    absolutePath: filePath,
    directory: folder,
    workspace: metaInfo.workspace || '',
    source: metaInfo.source,
    root: metaInfo.root || '',
    size: Buffer.byteLength(raw, 'utf8')
  };
}
async function discoverWorkspaceSkills(max) {
  const exclude = '**/{node_modules,.git,.svn,.hg,dist,out,build,coverage,vendor}/**';
  const uris = await vscode.workspace.findFiles('**/{SKILL.md,skill.md}', exclude, max);
  const skills = [];
  for (const uri of uris) {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const relative = workspaceFolder ? normalizeSlash(path.relative(workspaceFolder.uri.fsPath, uri.fsPath)) : normalizeSlash(uri.fsPath);
      skills.push(await skillFromFile(uri.fsPath, {
        id: `workspace:${(workspaceFolder?.name || '')}:${relative}`.toLowerCase(),
        displayPath: relative,
        workspace: workspaceFolder?.name || '',
        source: 'workspace',
        root: workspaceFolder?.uri.fsPath || ''
      }));
    } catch {}
  }
  return skills;
}
async function walkSkillFiles(root, remaining) {
  const found = [];
  async function walk(dir) {
    if (found.length >= remaining) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= remaining) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /^(skill\.md)$/i.test(entry.name)) found.push(full);
      else if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) await walk(full);
    }
  }
  await walk(root);
  return found;
}
async function discoverGlobalSkills(config, max) {
  if (!config.get('skillsGlobalEnabled', true)) return [];
  const roots = configuredGlobalDirs(config);
  const skills = [];
  for (const root of roots) {
    if (skills.length >= max) break;
    const files = await walkSkillFiles(root, max - skills.length);
    for (const filePath of files) {
      try {
        const relative = normalizeSlash(path.relative(root, filePath));
        const rootLabel = normalizeSlash(root.replace(os.homedir(), '~'));
        skills.push(await skillFromFile(filePath, {
          id: `global:${rootLabel}:${relative}`.toLowerCase(),
          displayPath: `${rootLabel}/${relative}`.replace(/\/+/g, '/'),
          source: 'global',
          root
        }));
      } catch {}
    }
  }
  return skills;
}

async function discoverSkills(config, force = false) {
  if (!config.get('skillsEnabled', true)) return [];
  const key = cacheKey(config);
  if (!force && cache.key === key && Date.now() - cache.at < 5000) return cache.skills;
  const max = Math.max(1, Math.min(1000, Number(config.get('skillsMaxFiles', MAX_SKILLS) || MAX_SKILLS)));
  const workspace = await discoverWorkspaceSkills(max);
  const global = await discoverGlobalSkills(config, Math.max(0, max - workspace.length));

  // Workspace definitions take precedence over global definitions with the same name.
  const workspaceNames = new Set(workspace.map(s => s.name.toLowerCase()));
  const merged = [...workspace, ...global.filter(s => !workspaceNames.has(s.name.toLowerCase()))];
  merged.sort((a, b) => (a.source === b.source ? a.path.localeCompare(b.path) : a.source === 'workspace' ? -1 : 1));
  cache = { at: Date.now(), key, skills: merged };
  return merged;
}

function publicSkill(skill) {
  return { id: skill.id, name: skill.name, description: skill.description, path: skill.path, workspace: skill.workspace, source: skill.source, size: skill.size };
}
function matchesSkill(skill, query) {
  const q = String(query || '').trim().toLowerCase();
  return q && [skill.id, skill.name, skill.path].some(v => String(v || '').toLowerCase() === q);
}
async function resolveSkill(config, query) {
  const skills = await discoverSkills(config);
  const exact = skills.filter(s => matchesSkill(s, query));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const workspace = exact.find(s => s.source === 'workspace');
    if (workspace) return workspace;
  }
  const q = String(query || '').trim().toLowerCase();
  const partial = skills.filter(s => [s.name, s.path, s.id].some(v => String(v || '').toLowerCase().includes(q)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Skill reference is ambiguous: ${partial.slice(0, 8).map(s => `${s.name} (${s.source}: ${s.path})`).join(', ')}`);
  throw new Error(`Skill not found: ${query}`);
}
function ensureInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
async function readTextFile(filePath, maxChars) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Resource is not a file.');
  const raw = await fs.readFile(filePath, 'utf8');
  if (raw.length > maxChars) return { content: raw.slice(0, maxChars), truncated: true, chars: raw.length };
  return { content: raw, truncated: false, chars: raw.length };
}

async function executeSkillTool(name, args, config) {
  const maxChars = Math.max(4000, Math.min(500000, Number(config.get('skillsMaxReadChars', DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS)));
  if (name === 'skills_list') {
    const skills = await discoverSkills(config, true);
    return { success: true, count: skills.length, workspace_count: skills.filter(s => s.source === 'workspace').length, global_count: skills.filter(s => s.source === 'global').length, skills: skills.map(publicSkill) };
  }
  if (name === 'skills_read') {
    const skill = await resolveSkill(config, args?.skill);
    const data = await readTextFile(skill.absolutePath, maxChars);
    return { success: true, skill: publicSkill(skill), ...data };
  }
  if (name === 'skills_read_resource') {
    const skill = await resolveSkill(config, args?.skill);
    const requested = String(args?.resource || '').trim();
    if (!requested) throw new Error('resource is required.');
    const target = path.resolve(skill.directory, requested);
    if (!ensureInside(skill.directory, target)) throw new Error('Resource path must stay inside the skill directory.');
    const data = await readTextFile(target, maxChars);
    return { success: true, skill: publicSkill(skill), resource: normalizeSlash(path.relative(skill.directory, target)), ...data };
  }
  return { success: false, error: `Unknown skill tool: ${name}` };
}

async function getSkillCatalog(config) { return (await discoverSkills(config)).map(publicSkill); }
async function getSkillContext(config) {
  const skills = await getSkillCatalog(config);
  if (!skills.length) return '';
  const lines = skills.map(s => `- ${s.name}: ${s.description || '(no description)'} [${s.source}: ${s.path}]`);
  return [
    'Reusable workspace/global skills are available. Workspace skills override global skills with the same name.',
    'Before doing substantial work, check whether one of these skills clearly matches the request. If it does, call skills_read and follow that skill. Do not claim to have used a skill you did not read.',
    ...lines
  ].join('\n');
}
function invalidateSkillCache() { cache = { at: 0, key: '', skills: [] }; }

module.exports = {
  SKILL_TOOLS, SKILL_NAMES, discoverSkills, getSkillCatalog, getSkillContext,
  executeSkillTool, invalidateSkillCache
};
