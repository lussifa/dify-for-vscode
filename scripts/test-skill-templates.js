#!/usr/bin/env node
// Smoke test for the multi-file skill template system.
// Mocks the `vscode` module so skillManager.js can be loaded outside of VS Code,
// then exercises every template and asserts the resulting directory tree.

'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

const TEST_ROOT = '/tmp/skill-template-test';
const SMOKE_FILE_COUNT = { minimal: 1, document: 4, tool: 6, full: 7 };

// ===== vscode mock =====
const vscodeMock = {
  Uri: {
    file(p) {
      const u = { fsPath: p, path: p, scheme: 'file' };
      u.joinPath = (...parts) => vscodeMock.Uri.file(path.join(p, ...parts));
      return u;
    },
    joinPath(base, ...parts) {
      return vscodeMock.Uri.file(path.join(base.fsPath, ...parts));
    }
  },
  workspace: {
    fs: {
      async stat(uri) {
        const st = fs.statSync(uri.fsPath);
        return { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs };
      },
      async createDirectory(uri) {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
      async writeFile(uri, data) {
        fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
        fs.writeFileSync(uri.fsPath, data);
      },
      async delete(uri) {
        fs.rmSync(uri.fsPath, { recursive: true, force: true });
      }
    }
  }
};

// Intercept `require('vscode')` to return our mock.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  if (request === 'adm-zip') {
    // Not exercised in this test, but skillManager.js requires it at top level.
    return { default: class AdmZip { constructor() {} getEntries() { return []; } } };
  }
  return origLoad.call(this, request, ...rest);
};

// ===== Load skillManager =====
const skillManager = require('../skillManager');
const { SKILL_TEMPLATES, applySkillTemplate, _templates } = skillManager;

// ===== Run tests =====
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(p, rel));
    else out.push(rel);
  }
  return out.sort();
}

(async () => {
  // Fresh sandbox
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  let pass = 0, fail = 0;
  for (const [id, tpl] of Object.entries(SKILL_TEMPLATES)) {
    const skillDir = path.join(TEST_ROOT, id);
    const expected = SMOKE_FILE_COUNT[id];
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      // ApplySkillTemplate expects a vscode Uri, not a raw path.
      const result = await applySkillTemplate(vscodeMock.Uri.file(skillDir), id, `${id}-demo`, `Demo for ${id} template`);
      const tree = walk(skillDir);
      const ok = result.written.length === expected && tree.length === expected;
      if (ok) {
        console.log(`[PASS] ${id.padEnd(8)}  ${result.written.length} files`);
        for (const f of tree) console.log(`         ${f}`);
        pass++;
      } else {
        console.log(`[FAIL] ${id}  expected ${expected} files, got ${result.written.length} (wrote) / ${tree.length} (on disk)`);
        fail++;
      }
    } catch (err) {
      console.log(`[FAIL] ${id}  threw: ${err.message}`);
      fail++;
    }
  }

  // Pull hello.js out of the tool template and execute it.
  const helloPath = path.join(TEST_ROOT, 'tool', 'scripts', 'hello.js');
  if (fs.existsSync(helloPath)) {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [helloPath, 'world'], { encoding: 'utf8' });
    const out2 = execFileSync('node', [helloPath, 'dify'], { encoding: 'utf8' });
    if (out.trim() === 'hello, world' && out2.trim() === 'hello, dify') {
      console.log(`[PASS] scripts/hello.js runs: "${out.trim()}" / "${out2.trim()}"`);
      pass++;
    } else {
      console.log(`[FAIL] scripts/hello.js output unexpected: "${out}" / "${out2}"`);
      fail++;
    }
  }

  // Sanity-check SKILL.md frontmatter parses for every template.
  for (const id of Object.keys(SKILL_TEMPLATES)) {
    const md = fs.readFileSync(path.join(TEST_ROOT, id, 'SKILL.md'), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    const name = fm && fm[1].match(/^name:\s*(.+)$/m);
    const desc = fm && fm[1].match(/^description:\s*"(.+)"$/m);
    if (name && desc && name[1] === `${id}-demo`) {
      console.log(`[PASS] ${id}/SKILL.md frontmatter (name="${name[1]}")`);
      pass++;
    } else {
      console.log(`[FAIL] ${id}/SKILL.md frontmatter broken`);
      fail++;
    }
  }

  // Verify the "all-files-have-content" check: no zero-byte files.
  let zeroByte = 0;
  for (const id of Object.keys(SKILL_TEMPLATES)) {
    const root = path.join(TEST_ROOT, id);
    for (const f of walk(root)) {
      if (f.endsWith('/')) continue;
      const size = fs.statSync(path.join(root, f)).size;
      if (size === 0) { console.log(`[FAIL] ${id}/${f} is empty`); zeroByte++; fail++; }
    }
  }
  if (zeroByte === 0) console.log('[PASS] no zero-byte files in any template');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
