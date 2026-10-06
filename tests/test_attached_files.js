const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Test Prompt Augmentation Logic
const attachedFiles = [
  { filePath: path.resolve('utils.js'), name: 'utils.js', relativePath: 'utils.js', size: 157 },
  { filePath: path.resolve('README.md'), name: 'README.md', relativePath: 'README.md', size: 500 }
];

let finalTask = 'Fix something';
if (Array.isArray(attachedFiles) && attachedFiles.length > 0) {
  let filesContext = '\n\n[USER ATTACHED TARGET / REFERENCE FILES]:\n';
  for (const f of attachedFiles) {
    const p = f.filePath || f.path;
    if (!p) continue;
    const targetRef = f.relativePath ? `${f.relativePath} (in project)` : `${p} (external file)`;
    filesContext += `\n● File: ${targetRef}\n`;
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size <= 80 * 1024) {
          const content = fs.readFileSync(p, 'utf8');
          filesContext += `--- FILE CONTENT START (${f.name}) ---\n${content}\n--- FILE CONTENT END (${f.name}) ---\n`;
        } else {
          filesContext += `(File size: ${Math.round(stat.size / 1024)} KB - large file, read directly from repo/filesystem if needed)\n`;
        }
      }
    } catch (err) {
      filesContext += `(File read error: ${err.message})\n`;
    }
  }
  filesContext += '\nINSTRUCTION: Please perform the requested task on the file(s) specified above or prioritize their contents.\n';
  finalTask = finalTask + filesContext;
}

assert(finalTask.includes('utils.js (in project)'), 'Should contain relative path');
assert(finalTask.includes('function reverseString'), 'Should contain utils.js content');
assert(finalTask.includes('INSTRUCTION: Please perform the requested task on the file(s) specified above'), 'Should include instruction');
console.log('✓ Prompt augmentation test passed');

// 2. Test File Chip Formatting
const formatSize = (bytes) => {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
};
assert.strictEqual(formatSize(1024), '1 KB');
assert.strictEqual(formatSize(157), '0 KB');
assert.strictEqual(formatSize(5 * 1024 * 1024), '5.0 MB');
console.log('✓ File size formatting test passed');

console.log('All attached files tests passed successfully!');
