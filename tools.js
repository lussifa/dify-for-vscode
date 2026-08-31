const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { exec } = require('child_process');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_IGNORES = '**/{.git,node_modules,.venv,venv,__pycache__,.next,dist,build}/**';

const TOOLS = [
  tool('get_workspace_info', 'Get workspace root, top-level entries, open files, and active editor.', obj({})),
  tool('file_info', 'Get metadata for a workspace file or directory.', obj({ path: str('Workspace-relative path.') }, ['path'])),
  tool('read_file', 'Read a UTF-8 text file. Optionally read a line range.', obj({ path: str(), start_line: int(1), end_line: int(1) }, ['path'])),
  tool('read_files', 'Read multiple UTF-8 text files in one call (max 20).', obj({ paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, ['paths'])),
  tool('list_files', 'List workspace files/directories recursively.', obj({ path: str('Directory; empty means workspace root.'), max_depth: int(0, 8), include_hidden: bool() })),
  tool('search_files', 'Regex search across workspace text files.', obj({ regex: str(), path: str('Directory scope; empty means workspace root.'), file_pattern: str('Glob such as **/*.ts.'), max_results: int(1, 300), case_sensitive: bool() }, ['regex'])),
  tool('list_code_definitions', 'List classes, functions, methods, variables and other document symbols.', obj({ path: str('File or directory path.'), max_files: int(1, 100) }, ['path'])),
  tool('write_file', 'Create or completely overwrite a UTF-8 text file.', obj({ path: str(), content: str() }, ['path', 'content'])),
  tool('replace_text', 'Replace exact text in a UTF-8 file.', obj({ path: str(), old_text: str(), new_text: str(), replace_all: bool() }, ['path', 'old_text', 'new_text'])),
  tool('insert_text', 'Insert UTF-8 text before a 1-based line number, or append with line=0.', obj({ path: str(), line: int(0), content: str() }, ['path', 'line', 'content'])),
  tool('apply_patch', 'Apply a unified diff patch to workspace files. Uses git apply; paths must stay inside workspace.', obj({ patch: str('Unified diff text.') }, ['patch'])),
  tool('create_directory', 'Create a directory recursively inside the workspace.', obj({ path: str() }, ['path'])),
  tool('move_file', 'Move a file or directory inside the workspace.', obj({ source: str(), destination: str(), overwrite: bool() }, ['source', 'destination'])),
  tool('rename_file', 'Rename a file or directory inside the workspace.', obj({ path: str(), new_name: str('New base name only, not a path.'), overwrite: bool() }, ['path', 'new_name'])),
  tool('copy_file', 'Copy a file or directory inside the workspace.', obj({ source: str(), destination: str(), overwrite: bool() }, ['source', 'destination'])),
  tool('delete_file', 'Delete a workspace file or directory. Directories require recursive=true when non-empty.', obj({ path: str(), recursive: bool(), use_trash: bool() }, ['path'])),
  tool('open_file', 'Open a workspace file in the VS Code editor, optionally at a line.', obj({ path: str(), line: int(1) }, ['path'])),
  tool('run_command', 'Run a shell command with workspace root as default cwd.', obj({ command: str(), cwd: str('Workspace-relative cwd.'), timeout_ms: int(1000, 600000) }, ['command'])),
  tool('git_status', 'Return concise git status for the workspace.', obj({})),
  tool('git_diff', 'Return git diff. Set staged=true for --cached.', obj({ staged: bool(), path: str('Optional workspace-relative path.') })),
  tool('get_diagnostics', 'Get VS Code diagnostics for one file or the whole workspace.', obj({ path: str() })),
  tool('fetch_url', 'HTTP GET a URL and return text content (max 1 MiB).', obj({ url: str(), max_chars: int(1000, 200000) }, ['url'])),
  tool('ask_user', 'Ask the user for a short answer and continue the agent loop.', obj({ question: str(), placeholder: str(), password: bool() }, ['question']))
];

const MUTATING_TOOLS = new Set([
  'write_file','replace_text','insert_text','apply_patch','create_directory','move_file','rename_file','copy_file','delete_file','run_command'
]);

function tool(name, description, parameters) { return { type: 'function', function: { name, description, parameters } }; }
function str(description) { return { type: 'string', ...(description ? { description } : {}) }; }
function bool() { return { type: 'boolean' }; }
function int(minimum, maximum) { return { type: 'integer', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) }; }
function obj(properties, required = []) { return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }; }

function workspaceFolder() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) throw new Error('Open a folder/workspace in VS Code first.');
  if (folder.uri.scheme !== 'file') throw new Error(`Unsupported workspace scheme: ${folder.uri.scheme}.`);
  return folder;
}
function workspaceRoot() { return workspaceFolder().uri.fsPath; }
function safePath(relative = '') {
  const root = path.resolve(workspaceRoot());
  const target = path.resolve(root, relative || '.');
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  if (t !== r && !t.startsWith(r + path.sep)) throw new Error(`Path escapes workspace: ${relative}`);
  return target;
}
function relPath(full) { return path.relative(workspaceRoot(), full).replace(/\\/g, '/') || '.'; }
function ensureNewName(name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('new_name must be a base name only.');
}
async function readUtf8(full, limit = MAX_TEXT_BYTES) {
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(full));
  if (stat.size > limit) throw new Error(`File too large (${stat.size} bytes; limit ${limit}).`);
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(full));
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('\u0000')) throw new Error('File appears to be binary.');
  return { text, stat };
}
async function writeUtf8(full, content) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(full)));
  await vscode.workspace.fs.writeFile(vscode.Uri.file(full), new TextEncoder().encode(content));
}
function fileType(type) {
  if (type & vscode.FileType.Directory) return 'directory';
  if (type & vscode.FileType.SymbolicLink) return 'symlink';
  if (type & vscode.FileType.File) return 'file';
  return 'unknown';
}
function shell(command, cwd, timeout) {
  return new Promise(resolve => exec(command, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => resolve({
    success: !error,
    exit_code: error && typeof error.code === 'number' ? error.code : (error ? null : 0),
    stdout: String(stdout || '').slice(-300000),
    stderr: String(stderr || '').slice(-300000),
    error: error ? error.message : undefined
  })));
}

async function executeTool(name, args = {}, config) {
  switch (name) {
    case 'get_workspace_info': return getWorkspaceInfo();
    case 'file_info': return fileInfo(args);
    case 'read_file': return readFile(args);
    case 'read_files': return readFiles(args);
    case 'list_files': return listFiles(args);
    case 'search_files': return searchFiles(args);
    case 'list_code_definitions': return listCodeDefinitions(args);
    case 'write_file': return writeFile(args);
    case 'replace_text': return replaceText(args);
    case 'insert_text': return insertText(args);
    case 'apply_patch': return applyPatch(args, config);
    case 'create_directory': return createDirectory(args);
    case 'move_file': return moveFile(args);
    case 'rename_file': return renameFile(args);
    case 'copy_file': return copyFile(args);
    case 'delete_file': return deleteFile(args);
    case 'open_file': return openFile(args);
    case 'run_command': return runCommand(args, config);
    case 'git_status': return gitStatus(config);
    case 'git_diff': return gitDiff(args, config);
    case 'get_diagnostics': return diagnostics(args);
    case 'fetch_url': return fetchUrl(args);
    case 'ask_user': return askUser(args);
    default: return { success: false, error: `Unknown tool: ${name}` };
  }
}

async function getWorkspaceInfo() {
  const root = workspaceRoot();
  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
  const open_files = vscode.workspace.textDocuments
    .filter(d => d.uri.scheme === 'file' && d.uri.fsPath.startsWith(root))
    .map(d => relPath(d.uri.fsPath)).slice(0, 50);
  const active = vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
    ? relPath(vscode.window.activeTextEditor.document.uri.fsPath) : null;
  return { success: true, root, active_file: active, open_files, top_level: entries.slice(0, 200).map(([name,type]) => ({ name, type: fileType(type) })) };
}
async function fileInfo(args) {
  const full = safePath(args.path);
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(full));
  return { success: true, path: relPath(full), type: fileType(stat.type), size: stat.size, created_ms: stat.ctime, modified_ms: stat.mtime, created: new Date(stat.ctime).toISOString(), modified: new Date(stat.mtime).toISOString() };
}
async function readFile(args) {
  const full = safePath(args.path);
  const { text } = await readUtf8(full);
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number(args.start_line || 1));
  const end = Math.min(lines.length, Number(args.end_line || lines.length));
  if (end < start) throw new Error('end_line must be >= start_line.');
  return { success: true, path: relPath(full), start_line: start, end_line: end, total_lines: lines.length, content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
}
async function readFiles(args) {
  const paths = Array.isArray(args.paths) ? args.paths.slice(0, 20) : [];
  const files = [];
  for (const p of paths) {
    try { files.push(await readFile({ path: p })); }
    catch (error) { files.push({ success: false, path: p, error: error.message }); }
  }
  return { success: true, files };
}
async function listFiles(args) {
  const root = workspaceRoot();
  const start = safePath(args.path || '');
  const maxDepth = Math.max(0, Math.min(8, Number(args.max_depth ?? 3)));
  const out = [];
  const ignore = new Set(['.git','node_modules','.venv','venv','__pycache__','.next','dist','build']);
  async function walk(current, depth) {
    if (out.length >= 2000) return;
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(current));
    for (const [name, type] of entries) {
      if (!args.include_hidden && name.startsWith('.')) continue;
      if (ignore.has(name)) continue;
      const full = path.join(current, name);
      out.push({ path: path.relative(root, full).replace(/\\/g, '/'), type: fileType(type) });
      if ((type & vscode.FileType.Directory) && depth < maxDepth) await walk(full, depth + 1);
      if (out.length >= 2000) break;
    }
  }
  await walk(start, 0);
  return { success: true, entries: out, truncated: out.length >= 2000 };
}
async function searchFiles(args) {
  const regexText = String(args.regex || '');
  if (!regexText) throw new Error('regex is required.');
  let re;
  try { re = new RegExp(regexText, args.case_sensitive ? 'g' : 'gi'); }
  catch (error) { throw new Error(`Invalid regex: ${error.message}`); }
  const max = Math.max(1, Math.min(300, Number(args.max_results || 100)));
  const base = String(args.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const pattern = args.file_pattern || '**/*';
  const include = base ? `${base}/${pattern}` : pattern;
  const files = await vscode.workspace.findFiles(include, DEFAULT_IGNORES, 1000);
  const results = [];
  for (const uri of files) {
    if (results.length >= max) break;
    try {
      const { text } = await readUtf8(uri.fsPath, 1024 * 1024);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < max; i += 1) {
        re.lastIndex = 0;
        if (re.test(lines[i])) results.push({ path: relPath(uri.fsPath), line: i + 1, text: lines[i].slice(0, 800) });
      }
    } catch {}
  }
  return { success: true, regex: regexText, results, truncated: results.length >= max };
}
async function listCodeDefinitions(args) {
  const full = safePath(args.path);
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(full));
  let uris = [];
  if (stat.type & vscode.FileType.Directory) {
    const base = relPath(full).replace(/^\.$/, '');
    uris = await vscode.workspace.findFiles(base ? `${base}/**/*` : '**/*', DEFAULT_IGNORES, Math.max(1, Math.min(100, Number(args.max_files || 40))));
  } else {
    uris = [vscode.Uri.file(full)];
  }
  const definitions = [];
  function flatten(symbols, file, depth = 0) {
    if (!Array.isArray(symbols)) return;
    for (const s of symbols) {
      const line = (s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1;
      definitions.push({ path: file, name: s.name || '', kind: vscode.SymbolKind[s.kind] || String(s.kind), line, depth });
      if (s.children) flatten(s.children, file, depth + 1);
      if (definitions.length >= 1000) return;
    }
  }
  for (const uri of uris) {
    if (definitions.length >= 1000) break;
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
      flatten(symbols, relPath(uri.fsPath));
    } catch {}
  }
  return { success: true, definitions, truncated: definitions.length >= 1000 };
}
async function writeFile(args) {
  if (typeof args.content !== 'string') throw new Error('content must be a string.');
  const full = safePath(args.path);
  await writeUtf8(full, args.content);
  return { success: true, path: relPath(full), bytes: Buffer.byteLength(args.content, 'utf8') };
}
async function replaceText(args) {
  const full = safePath(args.path);
  const { text } = await readUtf8(full);
  const oldText = String(args.old_text ?? '');
  if (!oldText) throw new Error('old_text cannot be empty.');
  const count = text.split(oldText).length - 1;
  if (!count) throw new Error('old_text was not found.');
  if (!args.replace_all && count !== 1) throw new Error(`old_text occurs ${count} times.`);
  const updated = args.replace_all ? text.split(oldText).join(String(args.new_text ?? '')) : text.replace(oldText, String(args.new_text ?? ''));
  await writeUtf8(full, updated);
  return { success: true, path: relPath(full), replacements: args.replace_all ? count : 1 };
}
async function insertText(args) {
  const full = safePath(args.path);
  const { text } = await readUtf8(full);
  const lines = text.split(/\r?\n/);
  const line = Number(args.line);
  const content = String(args.content ?? '');
  if (line === 0) {
    await writeUtf8(full, text + (text.endsWith('\n') ? '' : '\n') + content);
    return { success: true, path: relPath(full), line: 0 };
  }
  if (line < 1 || line > lines.length + 1) throw new Error(`line must be 1..${lines.length + 1} or 0 to append.`);
  lines.splice(line - 1, 0, ...content.split(/\r?\n/));
  await writeUtf8(full, lines.join(os.EOL));
  return { success: true, path: relPath(full), line };
}
async function applyPatch(args, config) {
  const patchText = String(args.patch || '');
  if (!patchText.trim()) throw new Error('patch is required.');
  for (const line of patchText.split(/\r?\n/)) {
    if (/^(---|\+\+\+)\s+(?:[ab]\/)?(?:\.\.\/|\/|[A-Za-z]:\\)/.test(line)) throw new Error('Patch contains an unsafe path.');
  }
  const root = workspaceRoot();
  const temp = path.join(root, `.dify-agent-${Date.now()}.patch`);
  await fs.writeFile(temp, patchText, 'utf8');
  try {
    const timeout = config?.get?.('commandTimeoutMs', 120000) || 120000;
    const escaped = temp.replace(/"/g, '\\"');
    const result = await shell(`git apply --whitespace=nowarn --recount "${escaped}"`, root, timeout);
    return { ...result, patch_applied: result.success };
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
async function createDirectory(args) {
  const full = safePath(args.path);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(full));
  return { success: true, path: relPath(full) };
}
async function moveFile(args) {
  const src = safePath(args.source);
  const dst = safePath(args.destination);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dst)));
  await vscode.workspace.fs.rename(vscode.Uri.file(src), vscode.Uri.file(dst), { overwrite: !!args.overwrite });
  return { success: true, source: relPath(src), destination: relPath(dst) };
}
async function renameFile(args) {
  ensureNewName(args.new_name);
  const src = safePath(args.path);
  const dst = safePath(path.join(path.dirname(args.path), args.new_name));
  return moveFile({ source: relPath(src), destination: relPath(dst), overwrite: args.overwrite });
}
async function copyFile(args) {
  const src = safePath(args.source);
  const dst = safePath(args.destination);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dst)));
  await vscode.workspace.fs.copy(vscode.Uri.file(src), vscode.Uri.file(dst), { overwrite: !!args.overwrite });
  return { success: true, source: relPath(src), destination: relPath(dst) };
}
async function deleteFile(args) {
  const full = safePath(args.path);
  if (relPath(full) === '.') throw new Error('Refusing to delete workspace root.');
  await vscode.workspace.fs.delete(vscode.Uri.file(full), { recursive: !!args.recursive, useTrash: args.use_trash !== false });
  return { success: true, path: relPath(full), used_trash: args.use_trash !== false };
}
async function openFile(args) {
  const full = safePath(args.path);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (args.line) {
    const line = Math.max(0, Math.min(doc.lineCount - 1, Number(args.line) - 1));
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
  return { success: true, path: relPath(full) };
}
async function runCommand(args, config) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command is required.');
  const cwd = safePath(args.cwd || '');
  const timeout = Math.max(1000, Math.min(600000, Number(args.timeout_ms || config?.get?.('commandTimeoutMs', 120000) || 120000)));
  const result = await shell(command, cwd, timeout);
  return { ...result, command, cwd: relPath(cwd) };
}
async function gitStatus(config) {
  return shell('git status --short --branch', workspaceRoot(), config?.get?.('commandTimeoutMs', 120000) || 120000);
}
async function gitDiff(args, config) {
  const pathArg = args.path ? ` -- "${safePath(args.path).replace(/"/g, '\\"')}"` : '';
  return shell(`git diff ${args.staged ? '--cached ' : ''}--no-ext-diff${pathArg}`, workspaceRoot(), config?.get?.('commandTimeoutMs', 120000) || 120000);
}
async function diagnostics(args) {
  const root = workspaceRoot();
  const groups = args.path
    ? [[vscode.Uri.file(safePath(args.path)), vscode.languages.getDiagnostics(vscode.Uri.file(safePath(args.path)))]]
    : vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === 'file' && uri.fsPath.startsWith(root));
  const items = [];
  for (const [uri, ds] of groups) {
    for (const d of ds) {
      items.push({ path: relPath(uri.fsPath), line: d.range.start.line + 1, column: d.range.start.character + 1, severity: ['Error','Warning','Information','Hint'][d.severity] || String(d.severity), message: d.message, source: d.source || '' });
      if (items.length >= 500) break;
    }
    if (items.length >= 500) break;
  }
  return { success: true, diagnostics: items, truncated: items.length >= 500 };
}
async function fetchUrl(args) {
  const url = new URL(String(args.url || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported.');
  const response = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'dify-for-vscode-agent' } });
  const reader = response.body?.getReader();
  let bytes = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) break;
      chunks.push(value);
    }
  }
  const merged = chunks.length ? Buffer.concat(chunks.map(v => Buffer.from(v))) : Buffer.from(await response.arrayBuffer());
  const text = merged.toString('utf8').slice(0, Math.max(1000, Math.min(200000, Number(args.max_chars || 50000))));
  return { success: response.ok, status: response.status, url: response.url, content_type: response.headers.get('content-type') || '', truncated: bytes > 1024 * 1024, content: text };
}
async function askUser(args) {
  const answer = await vscode.window.showInputBox({ title: 'Dify Agent', prompt: String(args.question || ''), placeHolder: String(args.placeholder || ''), password: !!args.password, ignoreFocusOut: true });
  return answer === undefined ? { success: false, cancelled: true } : { success: true, answer };
}

module.exports = { TOOLS, MUTATING_TOOLS, executeTool };
