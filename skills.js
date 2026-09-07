const vscode = require('vscode');
const path = require('path');
const fs = require('fs/promises');

const SKILL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'skills_list',
      description: 'List reusable workspace skills discovered from SKILL.md/skill.md files. Use this before starting work when a reusable skill may apply.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skills_read',
      description: 'Load the full instructions for one discovered skill by id, name, or path. Read a matching skill before following it.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill id, name, or SKILL.md path returned by skills_list.' }
        },
        required: ['skill'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skills_read_resource',
      description: 'Read a UTF-8 text resource located inside a discovered skill directory, for example a template, prompt, README, or script source referenced by SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill id, name, or path returned by skills_list.' },
          resource: { type: 'string', description: 'Relative path inside the skill directory.' }
        },
        required: ['skill', 'resource'],
        additionalProperties: false
      }
    }
  }
];

const SKILL_NAMES = new Set(SKILL_TOOLS.map(t => t.function.name));
const MAX_SKILLS = 200;
const DEFAULT_MAX_CHARS = 120000;
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
function workspaceKey(config) {
  const roots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).sort();
  return JSON.stringify({ roots, enabled: config.get('skillsEnabled', true), max: config.get('skillsMaxFiles', MAX_SKILLS) });
}

async function discoverSkills(config, force = false) {
  if (!config.get('skillsEnabled', true)) return [];
  const key = workspaceKey(config);
  if (!force && cache.key === key && Date.now() - cache.at < 5000) return cache.skills;
  const max = Math.max(1, Math.min(1000, Number(config.get('skillsMaxFiles', MAX_SKILLS) || MAX_SKILLS)));
  const exclude = '**/{node_modules,.git,.svn,.hg,dist,out,build,coverage,vendor}/**';
  const uris = await vscode.workspace.findFiles('**/{SKILL.md,skill.md}', exclude, max);
  const skills = [];
  for (const uri of uris) {
    try {
      const raw = await fs.readFile(uri.fsPath, 'utf8');
      const meta = parseFrontmatter(raw);
      const folder = path.dirname(uri.fsPath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const relative = workspaceFolder ? normalizeSlash(path.relative(workspaceFolder.uri.fsPath, uri.fsPath)) : normalizeSlash(uri.fsPath);
      const folderName = path.basename(folder);
      const name = meta.name || firstHeading(raw) || folderName || path.basename(uri.fsPath);
      const description = meta.description || firstParagraph(raw).slice(0, 500);
      skills.push({
        id: relative.toLowerCase(),
        name,
        description,
        path: relative,
        absolutePath: uri.fsPath,
        directory: folder,
        workspace: workspaceFolder?.name || '',
        size: Buffer.byteLength(raw, 'utf8')
      });
    } catch {}
  }
  skills.sort((a, b) => a.path.localeCompare(b.path));
  cache = { at: Date.now(), key, skills };
  return skills;
}

function publicSkill(skill) {
  return { id: skill.id, name: skill.name, description: skill.description, path: skill.path, workspace: skill.workspace, size: skill.size };
}
function matchesSkill(skill, query) {
  const q = String(query || '').trim().toLowerCase();
  return q && [skill.id, skill.name, skill.path].some(v => String(v || '').toLowerCase() === q);
}
async function resolveSkill(config, query) {
  const skills = await discoverSkills(config);
  const exact = skills.find(s => matchesSkill(s, query));
  if (exact) return exact;
  const q = String(query || '').trim().toLowerCase();
  const partial = skills.filter(s => [s.name, s.path, s.id].some(v => String(v || '').toLowerCase().includes(q)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Skill reference is ambiguous: ${partial.slice(0, 8).map(s => `${s.name} (${s.path})`).join(', ')}`);
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
    return { success: true, count: skills.length, skills: skills.map(publicSkill) };
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

async function getSkillCatalog(config) {
  const skills = await discoverSkills(config);
  return skills.map(publicSkill);
}
async function getSkillContext(config) {
  const skills = await getSkillCatalog(config);
  if (!skills.length) return '';
  const lines = skills.map(s => `- ${s.name}: ${s.description || '(no description)'} [${s.path}]`);
  return [
    'Reusable workspace skills are available.',
    'Before doing substantial work, check whether one of these skills clearly matches the request. If it does, call skills_read and follow that skill. Do not claim to have used a skill you did not read.',
    ...lines
  ].join('\n');
}
function invalidateSkillCache() { cache = { at: 0, key: '', skills: [] }; }

module.exports = {
  SKILL_TOOLS, SKILL_NAMES, discoverSkills, getSkillCatalog, getSkillContext,
  executeSkillTool, invalidateSkillCache
};
