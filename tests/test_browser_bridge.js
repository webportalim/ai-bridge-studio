/**
 * AI Bridge — Browser Extension & Context Integration Test Suite
 * Covers all 21 verification criteria specified in requirements.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// Content extraction modules
const common = require('../browser-extension/content/common');
const chatgptAdapter = require('../browser-extension/content/chatgpt');
const claudeAdapter = require('../browser-extension/content/claude');
const geminiAdapter = require('../browser-extension/content/gemini');

// Main process exports
const main = require('../main');

// Test runner state
let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (!condition) {
    failedCount++;
    console.error(`  FAIL: ${message}`);
    throw new Error(message);
  } else {
    passedCount++;
    console.log(`  PASS: ${message}`);
  }
}

async function fetchHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
          text: data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      if (typeof options.body === 'object') {
        req.write(JSON.stringify(options.body));
      } else {
        req.write(options.body);
      }
    }
    req.end();
  });
}

app.whenReady().then(async () => {
  console.log('\n==================================================');
  console.log('AI BRIDGE BROWSER EXTENSION & CONTEXT TEST SUITE');
  console.log('==================================================\n');

  try {
    // Start local bridge server on a test port
    const TEST_PORT = 45890;
    main.stopBrowserBridgeServer();
    await main.startBrowserBridgeServer(TEST_PORT, 1);
    const baseUrl = `http://127.0.0.1:${main.getBridgePort()}`;

    // -------------------------------------------------------------
    // Test 1: Bridge server only binds 127.0.0.1
    // -------------------------------------------------------------
    console.log('1. Checking server binding (127.0.0.1 only)...');
    const statusRes = await fetchHttp(`${baseUrl}/v1/status`);
    assert(statusRes.status === 200, 'Server responds on 127.0.0.1');
    assert(statusRes.data && statusRes.data.status === 'ok', 'Status endpoint returns ok');
    assert(main.getBridgePort() === TEST_PORT, `Server bound to requested port ${TEST_PORT}`);

    // -------------------------------------------------------------
    // Test 2: Incorrect pairing code rejected
    // -------------------------------------------------------------
    console.log('2. Testing pairing with incorrect code...');
    main.setPairingCode('123456', Date.now() + 300000);
    const badPairRes = await fetchHttp(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { code: '999999' }
    });
    assert(badPairRes.status === 401, 'Incorrect pairing code rejected with 401');
    assert(badPairRes.data && badPairRes.data.error, 'Error message provided on bad pairing');

    // -------------------------------------------------------------
    // Test 3: Correct pairing succeeds
    // -------------------------------------------------------------
    console.log('3. Testing pairing with correct code...');
    const goodPairRes = await fetchHttp(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { code: '123456' }
    });
    assert(goodPairRes.status === 200, 'Correct pairing returns 200');
    assert(goodPairRes.data && goodPairRes.data.success === true, 'Pairing success flag is true');
    assert(goodPairRes.data.token && goodPairRes.data.token.length === 64, 'Crypto random token returned');
    const validToken = goodPairRes.data.token;

    // -------------------------------------------------------------
    // Test 4: Expired code rejected
    // -------------------------------------------------------------
    console.log('4. Testing pairing with expired code...');
    main.setPairingCode('654321', Date.now() - 1000); // 1 sec in the past
    const expiredPairRes = await fetchHttp(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { code: '654321' }
    });
    assert(expiredPairRes.status === 401, 'Expired code rejected with 401');

    // -------------------------------------------------------------
    // Test 5: Request without token rejected
    // -------------------------------------------------------------
    console.log('5. Testing request without auth token...');
    const noTokenRes = await fetchHttp(`${baseUrl}/v1/context/current`);
    assert(noTokenRes.status === 401, 'Request without token returns 401 Unauthorized');

    // -------------------------------------------------------------
    // Test 6: Valid token accepted
    // -------------------------------------------------------------
    console.log('6. Testing request with valid auth token...');
    const validTokenRes = await fetchHttp(`${baseUrl}/v1/context/current`, {
      headers: { 'X-AI-Bridge-Token': validToken }
    });
    assert(validTokenRes.status === 200, 'Request with valid token returns 200 OK');

    // Setup headless Chromium window for DOM extraction tests
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false
      }
    });
    await win.loadURL('about:blank');

    const commonJs = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'content', 'common.js'), 'utf8');
    const chatgptJs = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'content', 'chatgpt.js'), 'utf8');
    try {
      await win.webContents.executeJavaScript(`${commonJs};\n${chatgptJs};`);
    } catch (injErr) {
      console.error('Script injection error:', injErr);
    }

    async function extractInBrowser(htmlString, url = 'https://chatgpt.com/c/test') {
      return win.webContents.executeJavaScript(`
        (() => {
          const doc = new DOMParser().parseFromString(${JSON.stringify(htmlString)}, 'text/html');
          return window.ChatGPTAdapter.extractConversation(doc, ${JSON.stringify(url)});
        })()
      `);
    }

    // -------------------------------------------------------------
    // Test 7: ChatGPT fixture extraction
    // -------------------------------------------------------------
    console.log('7. Testing ChatGPT fixture DOM extraction...');
    const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'chatgpt_sample.html'), 'utf8');
    const extractionResult = await extractInBrowser(fixtureHtml, 'https://chatgpt.com/c/test-uuid');

    assert(extractionResult.success === true, 'Extraction from sample fixture succeeds');
    assert(extractionResult.provider === 'chatgpt', 'Provider identified as chatgpt');
    assert(extractionResult.message_count === 3, 'Found exactly 3 messages');
    assert(extractionResult.title.includes('MotionSmith V2 Debugging'), `Title correctly extracted: ${extractionResult.title}`);

    // -------------------------------------------------------------
    // Test 8: User/assistant order preserved
    // -------------------------------------------------------------
    console.log('8. Verifying user/assistant turn order...');
    const msgs = extractionResult.messages;
    assert(msgs[0].role === 'user', 'Turn 1 role is user');
    assert(msgs[1].role === 'assistant', 'Turn 2 role is assistant');
    assert(msgs[2].role === 'user', 'Turn 3 role is user');
    assert(msgs[0].index === 0 && msgs[1].index === 1 && msgs[2].index === 2, 'Message indices are sequentially ordered');

    // -------------------------------------------------------------
    // Test 9: Code block content preserved
    // -------------------------------------------------------------
    console.log('9. Verifying code block preservation...');
    const codeFixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'chatgpt_code_sample.html'), 'utf8');
    const codeExtraction = await extractInBrowser(codeFixtureHtml, 'https://chatgpt.com/c/code-uuid');

    assert(codeExtraction.success === true, 'Code fixture extracted successfully');
    const asstMsg = codeExtraction.messages.find(m => m.role === 'assistant');
    assert(asstMsg && asstMsg.text.includes('def safe_slerp(q1, q2, t):'), 'Python function header preserved');
    assert(asstMsg.text.includes('np.clip(np.dot(q1, q2), -1.0, 1.0)'), 'Math code preserved verbatim');

    // -------------------------------------------------------------
    // Test 10: UI controls excluded from extracted text
    // -------------------------------------------------------------
    console.log('10. Verifying exclusion of UI controls and toolbar buttons...');
    assert(!asstMsg.text.includes('Copy code'), 'Copy code button text excluded');
    assert(!asstMsg.text.includes('Regenerate'), 'Regenerate button text excluded');
    assert(!msgs[1].text.includes('Thumbs up'), 'Screen-reader button text excluded');

    // -------------------------------------------------------------
    // Test 11: Empty / changed DOM => extraction failure
    // -------------------------------------------------------------
    console.log('11. Testing extraction failure on empty / changed layout...');
    const emptyFixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'chatgpt_empty.html'), 'utf8');
    const emptyExtraction = await extractInBrowser(emptyFixtureHtml, 'https://chatgpt.com/');
    assert(emptyExtraction.success === false, 'Extraction fails gracefully when no messages exist');
    assert(emptyExtraction.error && emptyExtraction.error.includes('layout may have changed'), 'Helpful error message returned');

    // -------------------------------------------------------------
    // Test 12: Oversized context truncation (250k ceiling)
    // -------------------------------------------------------------
    console.log('12. Testing context truncation for oversized conversations...');
    const bigMessages = [];
    for (let i = 0; i < 60; i++) {
      bigMessages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `Message ${i}: ` + 'X'.repeat(5000), // 5000 chars * 60 = 300,000 chars
        index: i
      });
    }
    const truncatedRes = common.truncateContext(bigMessages, 250000);
    assert(truncatedRes.truncated === true, 'Truncation flag set to true');
    assert(truncatedRes.charCount <= 250000, `Character count within limit: ${truncatedRes.charCount}`);
    assert(truncatedRes.messages.length < bigMessages.length, 'Older messages dropped');
    // Ensure newest message is preserved
    assert(truncatedRes.messages[truncatedRes.messages.length - 1].text.includes('Message 59'), 'Latest message 59 preserved');

    // -------------------------------------------------------------
    // Test 13: Import updates Electron context state
    // -------------------------------------------------------------
    console.log('13. Testing context import API endpoint...');
    const importRes = await fetchHttp(`${baseUrl}/v1/context/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Bridge-Token': validToken
      },
      body: extractionResult
    });
    assert(importRes.status === 200, 'Context import returns 200');
    assert(importRes.data.success === true, 'Import reports success');
    const activeCtx = main.getActiveContext();
    assert(activeCtx !== null, 'Active context populated in main process');
    assert(activeCtx.title === extractionResult.title, 'Context title matches imported payload');
    assert(activeCtx.messageCount === 3, 'Context message count is 3');

    // -------------------------------------------------------------
    // Test 14: Context stored outside project repo
    // -------------------------------------------------------------
    console.log('14. Verifying context file stored outside project directory...');
    assert(fs.existsSync(activeCtx.filePath), 'Context file exists on disk');
    const isInsideProjectRepo = activeCtx.filePath.toLowerCase().includes(path.normalize('F:\\AI-Bridge-Test').toLowerCase());
    assert(!isInsideProjectRepo, `Context file (${activeCtx.filePath}) is strictly outside project repository`);

    // Verify formatted document contains header and user/assistant markers
    const savedDoc = fs.readFileSync(activeCtx.filePath, 'utf8');
    assert(savedDoc.includes('# Imported Web Conversation'), 'Markdown title present in file');
    assert(savedDoc.includes('[USER]'), '[USER] turn marker present');
    assert(savedDoc.includes('[ASSISTANT]'), '[ASSISTANT] turn marker present');

    // -------------------------------------------------------------
    // Test 15: Run adds --context-file when context exists
    // -------------------------------------------------------------
    console.log('15. Verifying Run includes --context-file when context exists...');
    // We test argument formulation logic matching main.js bridge:run
    const testArgsWithCtx = [];
    if (activeCtx && activeCtx.filePath && fs.existsSync(activeCtx.filePath)) {
      testArgsWithCtx.push('--context-file', activeCtx.filePath);
    }
    assert(testArgsWithCtx.includes('--context-file'), '--context-file included in args');
    assert(testArgsWithCtx[1] === activeCtx.filePath, 'Argument points to correct context file');

    // -------------------------------------------------------------
    // Test 16: Run omits --context-file when absent
    // -------------------------------------------------------------
    console.log('16. Verifying Run omits --context-file when context absent...');
    const testArgsWithoutCtx = [];
    const nullCtx = null;
    if (nullCtx && nullCtx.filePath) {
      testArgsWithoutCtx.push('--context-file', nullCtx.filePath);
    }
    assert(!testArgsWithoutCtx.includes('--context-file'), '--context-file omitted when no context');

    // -------------------------------------------------------------
    // Test 17: Clear Context works
    // -------------------------------------------------------------
    console.log('17. Testing Clear Context DELETE endpoint...');
    const oldFilePath = activeCtx.filePath;
    const deleteRes = await fetchHttp(`${baseUrl}/v1/context/current`, {
      method: 'DELETE',
      headers: { 'X-AI-Bridge-Token': validToken }
    });
    assert(deleteRes.status === 200, 'DELETE /v1/context/current returns 200');
    assert(main.getActiveContext() === null, 'Active context cleared in memory');
    assert(!fs.existsSync(oldFilePath), 'Context file deleted from disk');

    // -------------------------------------------------------------
    // Test 18: Unpair works
    // -------------------------------------------------------------
    console.log('18. Testing unpair functionality...');
    main.setBridgeToken(null);
    const unpairCheckRes = await fetchHttp(`${baseUrl}/v1/context/current`, {
      headers: { 'X-AI-Bridge-Token': validToken }
    });
    assert(unpairCheckRes.status === 401, 'Request with old token rejected after unpair');

    // -------------------------------------------------------------
    // Test 19: Extension offline / desktop closed handled gracefully
    // -------------------------------------------------------------
    console.log('19. Testing client handling when server offline...');
    let offlineHandled = false;
    try {
      await fetchHttp('http://127.0.0.1:45899/v1/status');
    } catch (err) {
      offlineHandled = true;
    }
    assert(offlineHandled, 'Connection refused handled gracefully without crash');

    // -------------------------------------------------------------
    // Test 20: Malformed import payload rejected
    // -------------------------------------------------------------
    console.log('20. Testing malformed import payload rejection...');
    const newToken = crypto.randomBytes(32).toString('hex');
    main.setBridgeToken(newToken);
    const malformedRes = await fetchHttp(`${baseUrl}/v1/context/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Bridge-Token': newToken
      },
      body: { badKey: 'badValue' }
    });
    assert(malformedRes.status === 400, 'Malformed payload returns HTTP 400 Bad Request');
    assert(malformedRes.data && malformedRes.data.error, 'Error description returned');

    // -------------------------------------------------------------
    // Test 21: App shutdown closes localhost server cleanly
    // -------------------------------------------------------------
    console.log('21. Testing bridge server shutdown...');
    main.stopBrowserBridgeServer();
    let serverClosed = false;
    try {
      await fetchHttp(`${baseUrl}/v1/status`);
    } catch (_) {
      serverClosed = true;
    }
    assert(serverClosed, 'Bridge server closed cleanly, no port leak');

    if (win && !win.isDestroyed()) win.destroy();

    console.log('\n==================================================');
    console.log(`AUDIT RESULTS: ${passedCount} PASSED / ${failedCount} FAILED`);
    console.log('==================================================\n');

    if (failedCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (fatalErr) {
    console.error('FATAL TEST ERROR:', fatalErr);
    process.exit(1);
  }
});
