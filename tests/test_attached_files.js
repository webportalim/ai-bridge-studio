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
  let filesContext = '\n\n[KULLANICININ SEÇTİĞİ VE İŞLEM YAPILMASINI İSTEDİĞİ HEDEF / REFERANS DOSYALAR]:\n';
  for (const f of attachedFiles) {
    const p = f.filePath || f.path;
    if (!p) continue;
    const targetRef = f.relativePath ? `${f.relativePath} (proje içi)` : `${p} (harici dosya)`;
    filesContext += `\n● Dosya: ${targetRef}\n`;
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size <= 80 * 1024) {
          const content = fs.readFileSync(p, 'utf8');
          filesContext += `--- İÇERİK BAŞLANGICI (${f.name}) ---\n${content}\n--- İÇERİK BİTİŞİ (${f.name}) ---\n`;
        } else {
          filesContext += `(Dosya boyutu ${Math.round(stat.size / 1024)} KB - büyük dosya, gerekirse doğrudan repodan/dosya sisteminden okuyun)\n`;
        }
      }
    } catch (err) {
      filesContext += `(Dosya okuma bilgisi: ${err.message})\n`;
    }
  }
  filesContext += '\nTALİMAT: Lütfen görevi yukarıda belirtilen dosya(lar) üzerinde uygulayın veya bu dosyalardaki içeriği/talimatları öncelikli olarak dikkate alın.\n';
  finalTask = finalTask + filesContext;
}

assert(finalTask.includes('utils.js (proje içi)'), 'Should contain relative path');
assert(finalTask.includes('function reverseString'), 'Should contain utils.js content');
assert(finalTask.includes('TALİMAT: Lütfen görevi yukarıda belirtilen dosya(lar) üzerinde uygulayın'), 'Should include instruction');
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
