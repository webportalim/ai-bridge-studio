const fs = require('fs');
const path = require('path');
const assert = require('assert');

function scanFolderForTask(folderPath, maxFiles = 40) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.serena', '.gemini', '.idea', '.vscode']);
  const results = [];

  function walk(currentDir) {
    if (results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (results.length >= maxFiles) break;
      if (ignored.has(ent.name)) continue;
      const fullPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch (_) {}
        const rel = path.relative(folderPath, fullPath).replace(/\\/g, '/');
        results.push({ fullPath, rel, size, name: ent.name });
      }
    }
  }

  walk(folderPath);
  return results;
}

// 1. Test Prompt Augmentation Logic with both file and folder
const attachedFiles = [
  { filePath: path.resolve('utils.js'), name: 'utils.js', relativePath: 'utils.js', size: 157, isDirectory: false },
  { filePath: path.resolve('tests'), name: 'tests', relativePath: 'tests', isDirectory: true }
];

let finalTask = 'Refactor codebase and add regression tests';
if (Array.isArray(attachedFiles) && attachedFiles.length > 0) {
  let filesContext = '\n\n[USER ATTACHED TARGET / REFERENCE FILES & DIRECTORIES]:\n';
  let totalInjectedBytes = 0;
  const maxTotalInjectedBytes = 120 * 1024;

  for (const f of attachedFiles) {
    const p = f.filePath || f.path || f.folderPath;
    if (!p || !fs.existsSync(p)) continue;
    let stat = null;
    try { stat = fs.statSync(p); } catch (_) {}
    if (!stat) continue;

    const isDir = !!(f.isDirectory || stat.isDirectory());
    const targetRef = f.relativePath ? `${f.relativePath} (in project)` : `${p} (external)`;

    if (isDir) {
      const folderFiles = scanFolderForTask(p, 40);
      filesContext += `\n📁 DIRECTORY: ${targetRef} (${folderFiles.length} file(s) found)\n`;
      filesContext += `Contained files:\n`;
      for (const ff of folderFiles) {
        const szStr = ff.size > 1024 ? `${Math.round(ff.size / 1024)} KB` : `${ff.size} B`;
        filesContext += `  - ${ff.rel} (${szStr})\n`;
      }

      for (const ff of folderFiles) {
        if (totalInjectedBytes >= maxTotalInjectedBytes) break;
        if (ff.size <= 25 * 1024) {
          try {
            const content = fs.readFileSync(ff.fullPath, 'utf8');
            if (!content.includes('\0')) {
              filesContext += `\n--- FILE: ${ff.rel} ---\n${content}\n--- END FILE: ${ff.rel} ---\n`;
              totalInjectedBytes += Buffer.byteLength(content, 'utf8');
            }
          } catch (_) {}
        }
      }
      filesContext += `\nINSTRUCTION FOR THIS DIRECTORY: The user has attached the entire folder above. Agents should inspect the files in this directory and collaboratively perform the requested task across these files (team task).\n`;
    } else {
      filesContext += `\n● File: ${targetRef}\n`;
      try {
        if (stat.size <= 80 * 1024 && totalInjectedBytes < maxTotalInjectedBytes) {
          const content = fs.readFileSync(p, 'utf8');
          filesContext += `--- FILE CONTENT START (${f.name}) ---\n${content}\n--- FILE CONTENT END (${f.name}) ---\n`;
          totalInjectedBytes += Buffer.byteLength(content, 'utf8');
        } else {
          filesContext += `(File size: ${Math.round(stat.size / 1024)} KB - large file, read directly from repo/filesystem if needed)\n`;
        }
      } catch (err) {
        filesContext += `(File read error: ${err.message})\n`;
      }
    }
  }
  filesContext += '\nINSTRUCTION: Please perform the requested task on or with the files/directories specified above.\n';
  finalTask = finalTask + filesContext;
}

assert(finalTask.includes('utils.js (in project)'), 'Should contain file relative path');
assert(finalTask.includes('function reverseString'), 'Should contain utils.js content');
assert(finalTask.includes('📁 DIRECTORY: tests (in project)'), 'Should contain directory reference');
assert(finalTask.includes('Contained files:'), 'Should list directory files');
assert(finalTask.includes('INSTRUCTION FOR THIS DIRECTORY: The user has attached the entire folder above'), 'Should include team task instruction');
console.log('✓ Prompt augmentation test for files and folders passed');

// 2. Test File Chip Formatting
const formatSize = (bytes) => {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
};
assert.strictEqual(formatSize(1024), '1 KB');
assert.strictEqual(formatSize(157), '0 KB');
assert.strictEqual(formatSize(5 * 1024 * 1024), '5.0 MB');
console.log('✓ File size formatting test passed');

console.log('All attached files & folders tests passed successfully!');
