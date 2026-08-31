const vscode = require('vscode');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');

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

function relativePath(full) { return path.relative(workspaceRoot(), full).replace(/\\/g, '/') || '.'; }

function withExtension(relative, ext) {
  const normalized = String(relative || '').trim();
  if (!normalized) throw new Error(`output_path is required and must end with ${ext}.`);
  return normalized.toLowerCase().endsWith(ext) ? normalized : `${normalized}${ext}`;
}

async function ensureParent(full) { await fs.mkdir(path.dirname(full), { recursive: true }); }

function sidecarPath(full) { return `${full}.dify.json`; }

async function writeSidecar(full, payload) {
  const sidecar = sidecarPath(full);
  await ensureParent(sidecar);
  await fs.writeFile(sidecar, JSON.stringify(payload, null, 2), 'utf8');
  return sidecar;
}

async function readSidecar(full) {
  const sidecar = sidecarPath(full);
  try { return JSON.parse(await fs.readFile(sidecar, 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`Failed to read Office sidecar ${relativePath(sidecar)}: ${error.message}`);
  }
}

async function fileInfo(full) {
  const stat = await fs.stat(full);
  return {
    path: relativePath(full),
    size: stat.size,
    modified: stat.mtime.toISOString()
  };
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || '').trim();
        reject(new Error(detail || error.message));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return null;
}

async function findLibreOffice() {
  if (process.platform === 'win32') {
    const found = await firstExisting([
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ]);
    if (found) return found;
  }
  for (const cmd of ['soffice', 'libreoffice']) {
    try { await execFilePromise(cmd, ['--version'], { timeout: 10000 }); return cmd; } catch {}
  }
  return null;
}

async function renderWithLibreOffice(inputFull, outDirFull) {
  const soffice = await findLibreOffice();
  if (!soffice) return null;
  await fs.mkdir(outDirFull, { recursive: true });
  await execFilePromise(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDirFull, inputFull], { timeout: 180000 });
  const pdf = path.join(outDirFull, `${path.basename(inputFull, path.extname(inputFull))}.pdf`);
  try { await fs.access(pdf); } catch { throw new Error('LibreOffice finished without producing the expected PDF.'); }
  return pdf;
}

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

async function renderWithMicrosoftOffice(inputFull, outDirFull) {
  if (process.platform !== 'win32') return null;
  await fs.mkdir(outDirFull, { recursive: true });
  const ext = path.extname(inputFull).toLowerCase();
  const output = path.join(outDirFull, `${path.basename(inputFull, ext)}.pdf`);
  let script;
  if (ext === '.pptx') {
    script = `$app=New-Object -ComObject PowerPoint.Application; try {$p=$app.Presentations.Open(${psQuote(inputFull)},$true,$false,$false); $p.SaveAs(${psQuote(output)},32); $p.Close()} finally {$app.Quit()}`;
  } else if (ext === '.docx') {
    script = `$app=New-Object -ComObject Word.Application; $app.Visible=$false; try {$d=$app.Documents.Open(${psQuote(inputFull)}); $d.SaveAs2(${psQuote(output)},17); $d.Close()} finally {$app.Quit()}`;
  } else if (ext === '.xlsx') {
    script = `$app=New-Object -ComObject Excel.Application; $app.Visible=$false; $app.DisplayAlerts=$false; try {$w=$app.Workbooks.Open(${psQuote(inputFull)}); $w.ExportAsFixedFormat(0,${psQuote(output)}); $w.Close($false)} finally {$app.Quit()}`;
  } else {
    return null;
  }
  try {
    await execFilePromise('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 180000 });
    await fs.access(output);
    return output;
  } catch {
    return null;
  }
}

async function renderOfficePdf(inputRelative, outputDirRelative = 'office-preview') {
  const inputFull = safePath(inputRelative);
  const ext = path.extname(inputFull).toLowerCase();
  if (!['.pptx', '.docx', '.xlsx'].includes(ext)) throw new Error('office_render_pdf supports .pptx, .docx, or .xlsx files.');
  await fs.access(inputFull);
  const outDirFull = safePath(outputDirRelative || 'office-preview');
  let pdf = await renderWithLibreOffice(inputFull, outDirFull).catch(() => null);
  let renderer = pdf ? 'libreoffice' : '';
  if (!pdf) {
    pdf = await renderWithMicrosoftOffice(inputFull, outDirFull);
    renderer = pdf ? 'microsoft-office' : '';
  }
  if (!pdf) {
    return {
      success: false,
      error: 'No usable Office PDF renderer was found. Install LibreOffice, or on Windows install Microsoft Office with PowerPoint/Word/Excel COM automation available.'
    };
  }
  return { success: true, renderer, ...(await fileInfo(pdf)) };
}

module.exports = {
  workspaceRoot, safePath, relativePath, withExtension, ensureParent,
  writeSidecar, readSidecar, sidecarPath, fileInfo, renderOfficePdf
};
