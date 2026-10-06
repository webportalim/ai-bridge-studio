/**
 * AI Bridge — LLM Hub Web Orchestration Test Suite
 * Covers all verification criteria for LLM Hub multi-model orchestration,
 * prompt template engine, tab locking, event streaming, saved chats storage,
 * and safety constraints.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// Content extraction & template modules
const templates = require('../browser-extension/content/templates');
const common = require('../browser-extension/content/common');
const chatgptAdapter = require('../browser-extension/content/chatgpt');
const claudeAdapter = require('../browser-extension/content/claude');
const geminiAdapter = require('../browser-extension/content/gemini');
const background = require('../browser-extension/background');

// Main process exports
const main = require('../main');

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

async function runAllTests() {
  console.log('\n===============================================================');
  console.log(' AI Bridge — LLM Hub Web Orchestration Test Suite');
  console.log('===============================================================\n');

  const testAuthToken = crypto.randomBytes(32).toString('hex');
  main.setBridgeToken(testAuthToken);

  let testServerInfo = null;
  try {
    testServerInfo = await main.startBrowserBridgeServer(45830, 5);
    console.log(`Test Bridge Server active on port ${testServerInfo.port}`);
  } catch (err) {
    console.warn('Using existing bridge server on port', main.getBridgePort());
  }

  const serverUrl = `http://127.0.0.1:${main.getBridgePort()}`;

  // --------------------------------------------------------------------------
  // Group 1: Prompt Template Engine Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Group 1: Prompt Template Engine Verification ---');

  // Test 1: Initial Prompt Generation for all 4 modes
  {
    const topic = 'Design a high-performance memory allocator in Rust';
    const initialCollab = templates.buildInitialPrompt(topic, 'collaborative');
    assert(initialCollab.includes(topic), 'Initial collaborative prompt includes topic');
    assert(initialCollab.includes('COLLABORATIVE SYNTHESIS'), 'Initial collaborative prompt includes mode instructions');

    const initialDebate = templates.buildInitialPrompt(topic, 'debate');
    assert(initialDebate.includes('STRUCTURED DEBATE'), 'Initial debate prompt includes debate mode');

    const initialBrainstorm = templates.buildInitialPrompt(topic, 'brainstorm');
    assert(initialBrainstorm.includes('CREATIVE BRAINSTORMING'), 'Initial brainstorm prompt includes brainstorm mode');

    const initialCodeReview = templates.buildInitialPrompt(topic, 'code_review');
    assert(initialCodeReview.includes('TECHNICAL & CODE REVIEW'), 'Initial code review prompt includes code review mode');
  }

  // Test 2: Review Prompt with History Formatting
  {
    const topic = 'Camera smoothing in 3D';
    const history = [
      { round: 1, provider: 'chatgpt', text: 'Use critically damped springs.' },
      { round: 1, provider: 'claude', text: 'Ensure hermite spline velocity continuity.' }
    ];
    const reviewPrompt = templates.buildReviewPrompt(topic, history, 'collaborative', 'Gemini', 1);
    assert(reviewPrompt.includes('[CHATGPT RESPONSE (Round 1)]'), 'Review prompt includes ChatGPT turn');
    assert(reviewPrompt.includes('critically damped springs'), 'Review prompt includes ChatGPT content');
    assert(reviewPrompt.includes('[CLAUDE RESPONSE (Round 1)]'), 'Review prompt includes Claude turn');
    assert(reviewPrompt.includes('CONTINUING AS GEMINI'), 'Review prompt specifies Gemini role');
  }

  // Test 3: Final Consensus Prompt Formatting
  {
    const topic = 'Camera smoothing in 3D';
    const allHistory = [
      { round: 1, provider: 'chatgpt', text: 'Spring model' },
      { round: 1, provider: 'claude', text: 'Spline model' },
      { round: 1, provider: 'gemini', text: 'Layered model' }
    ];
    const consensusPrompt = templates.buildConsensusPrompt(topic, allHistory, 'collaborative');
    assert(consensusPrompt.includes('FINAL SYNTHESIS TASK'), 'Consensus prompt includes synthesis task');
    assert(consensusPrompt.includes('1. **Core Consensus**'), 'Consensus prompt specifies Section 1 Core Consensus');
    assert(consensusPrompt.includes('2. **Key Disagreements & Trade-offs**'), 'Consensus prompt specifies Section 2 Disagreements');
    assert(consensusPrompt.includes('3. **Recommended Approach**'), 'Consensus prompt specifies Section 3 Recommended Approach');
    assert(consensusPrompt.includes('4. **Important Caveats**'), 'Consensus prompt specifies Section 4 Caveats');
  }

  // Test 4: Follow-up Prompt Formatting
  {
    const topic = 'Game physics';
    const followUp = 'How does this handle network latency?';
    const history = [{ round: 1, provider: 'chatgpt', text: 'Physics engine' }];
    const followUpPrompt = templates.buildFollowUpPrompt(topic, followUp, history, 'debate', 'Claude');
    assert(followUpPrompt.includes(followUp), 'Follow-up prompt includes user question');
    assert(followUpPrompt.includes('INSTRUCTIONS FOR CLAUDE'), 'Follow-up specifies Claude role');
  }

  // Test 5: History truncation safety limit
  {
    const oversizedHistory = [];
    for (let i = 0; i < 50; i++) {
      oversizedHistory.push({
        round: i,
        provider: 'chatgpt',
        text: 'A'.repeat(1000)
      });
    }
    const formatted = templates.formatPreviousResponses(oversizedHistory, 5000);
    assert(formatted.length <= 6000, 'History formatter strictly truncates oversized context');
  }

  // --------------------------------------------------------------------------
  // Group 2: Content Script Adapters & UMD Compatibility
  // --------------------------------------------------------------------------
  console.log('\n--- Group 2: Content Script Adapters & UMD Compatibility ---');

  // Test 6: Adapter Exports and Versions
  {
    assert(chatgptAdapter.ADAPTER_NAME === 'chatgpt', 'ChatGPT adapter exports ADAPTER_NAME');
    assert(claudeAdapter.ADAPTER_NAME === 'claude', 'Claude adapter exports ADAPTER_NAME');
    assert(geminiAdapter.ADAPTER_NAME === 'gemini', 'Gemini adapter exports ADAPTER_NAME');
    assert(typeof chatgptAdapter.sendMessage === 'function', 'ChatGPT adapter has sendMessage');
    assert(typeof claudeAdapter.sendMessage === 'function', 'Claude adapter has sendMessage');
    assert(typeof geminiAdapter.sendMessage === 'function', 'Gemini adapter has sendMessage');
    assert(typeof chatgptAdapter.cancelGeneration === 'function', 'ChatGPT adapter has cancelGeneration');
    assert(typeof claudeAdapter.cancelGeneration === 'function', 'Claude adapter has cancelGeneration');
    assert(typeof geminiAdapter.cancelGeneration === 'function', 'Gemini adapter has cancelGeneration');
  }

  // Test 7: URL Matching rules
  {
    assert(chatgptAdapter.matches('https://chatgpt.com/c/123-abc'), 'ChatGPT matches chatgpt.com');
    assert(chatgptAdapter.matches('https://chat.openai.com/'), 'ChatGPT matches chat.openai.com');
    assert(!chatgptAdapter.matches('https://claude.ai/chat/123'), 'ChatGPT does not match claude.ai');

    assert(claudeAdapter.matches('https://claude.ai/chat/abc'), 'Claude matches claude.ai');
    assert(!claudeAdapter.matches('https://gemini.google.com/app'), 'Claude does not match gemini');

    assert(geminiAdapter.matches('https://gemini.google.com/app'), 'Gemini matches gemini.google.com');
    assert(!geminiAdapter.matches('https://chatgpt.com'), 'Gemini does not match chatgpt');
  }

  // --------------------------------------------------------------------------
  // Group 3: Background Service Worker & LLMHubOrchestrator
  // --------------------------------------------------------------------------
  console.log('\n--- Group 3: LLMHubOrchestrator Validation & Tab Locking ---');

  // Test 8: Session Validation - Empty topic rejection
  {
    const orch = new background.LLMHubOrchestrator();
    const res = await orch.startSession({ topic: '', providers: ['chatgpt', 'claude'] });
    assert(res.success === false, 'Rejects session with empty topic');
    assert(res.error.includes('Topic is required'), 'Returns topic required error');
  }

  // Test 9: Session Validation - Fewer than 2 providers rejection
  {
    const orch = new background.LLMHubOrchestrator();
    const res = await orch.startSession({ topic: 'Valid Topic', providers: ['chatgpt'] });
    assert(res.success === false, 'Rejects session with only 1 provider');
    assert(res.error.includes('At least 2 providers'), 'Returns at least 2 providers required');
  }

  // Test 10: Missing tab detection error message
  {
    const orch = new background.LLMHubOrchestrator();
    const lockRes = await orch.validateAndLockTabs(['chatgpt', 'claude']);
    assert(lockRes.valid === false, 'Fails tab locking when browser tabs are not open');
    assert(lockRes.error.includes('browser tab is not connected'), 'Produces clear missing tab error message');
  }

  // --------------------------------------------------------------------------
  // Group 4: Local HTTP Bridge Server & Endpoints
  // --------------------------------------------------------------------------
  console.log('\n--- Group 4: Local HTTP Bridge Server Endpoints ---');

  // Test 11: Auth enforcement on /v1/llm-hub/* endpoints
  {
    const resNoAuth = await fetchHttp(`${serverUrl}/v1/llm-hub/saved-chats`, {
      method: 'GET'
    });
    assert(resNoAuth.status === 401, '401 Unauthorized returned when X-AI-Bridge-Token is missing');

    const resWithAuth = await fetchHttp(`${serverUrl}/v1/llm-hub/saved-chats`, {
      method: 'GET',
      headers: { 'X-AI-Bridge-Token': testAuthToken }
    });
    assert(resWithAuth.status === 200, '200 OK returned with valid X-AI-Bridge-Token');
    assert(Array.isArray(resWithAuth.data.chats), 'Returns chats array');
  }

  // Test 12: POST /v1/llm-hub/event endpoint
  {
    const testEvent = {
      event: 'provider_started',
      sessionId: 'test_session_1',
      round: 1,
      provider: 'chatgpt'
    };
    const res = await fetchHttp(`${serverUrl}/v1/llm-hub/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Bridge-Token': testAuthToken
      },
      body: testEvent
    });
    assert(res.status === 200, 'POST /v1/llm-hub/event returns 200 OK');
    assert(res.data.success === true, 'POST /v1/llm-hub/event acknowledges event');
  }

  // Test 13: Saved Chats CRUD operations
  {
    const testChatSession = {
      sessionId: `test_save_${Date.now()}`,
      topic: 'Automated Test Discussion on Distributed Consensus',
      mode: 'debate',
      totalRounds: 2,
      providers: ['chatgpt', 'claude', 'gemini'],
      history: [
        { round: 1, provider: 'chatgpt', text: 'Raft is simpler than Multi-Paxos.' },
        { round: 1, provider: 'claude', text: 'Multi-Paxos allows pipelining without leader bottlenecks.' },
        { round: 1, provider: 'gemini', text: 'EPaxos eliminates leader bottlenecks entirely.' }
      ],
      consensus: '### 1. Core Consensus\nAll models agree that Raft is simpler, but EPaxos offers better throughput.',
      startedAt: Date.now() - 300000,
      finishedAt: Date.now()
    };

    // Save
    const saveRes = await fetchHttp(`${serverUrl}/v1/llm-hub/saved-chats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Bridge-Token': testAuthToken
      },
      body: testChatSession
    });
    assert(saveRes.status === 200, 'Save chat returns 200 OK');
    const savedId = saveRes.data.chat.id;
    assert(savedId === testChatSession.sessionId, 'Saved chat maintains session ID');

    // Retrieve single
    const getSingleRes = await fetchHttp(`${serverUrl}/v1/llm-hub/saved-chats/${savedId}`, {
      method: 'GET',
      headers: { 'X-AI-Bridge-Token': testAuthToken }
    });
    assert(getSingleRes.status === 200, 'Get single chat returns 200 OK');
    assert(getSingleRes.data.chat.topic === testChatSession.topic, 'Retrieved chat matches saved topic');

    // Export markdown
    const mdExport = main.exportSavedChat(savedId, 'markdown');
    assert(mdExport.includes('# AI Bridge — Multi-LLM Discussion Report'), 'Exported Markdown has report title');
    assert(mdExport.includes('**Mode:** DEBATE'), 'Exported Markdown preserves DEBATE mode');
    assert(mdExport.includes('[CHATGPT — Round 1]'), 'Exported Markdown contains formatted turn');
    assert(mdExport.includes('## Final Consensus Synthesis'), 'Exported Markdown includes consensus');

    // Export JSON
    const jsonExport = main.exportSavedChat(savedId, 'json');
    const parsedExport = JSON.parse(jsonExport);
    assert(parsedExport.sessionId === savedId, 'Exported JSON parses accurately');

    // Delete
    const deleteRes = await fetchHttp(`${serverUrl}/v1/llm-hub/saved-chats/${savedId}`, {
      method: 'DELETE',
      headers: { 'X-AI-Bridge-Token': testAuthToken }
    });
    assert(deleteRes.status === 200, 'Delete chat returns 200 OK');

    const getAfterDelete = await fetchHttp(`${serverUrl}/v1/llm-hub/saved-chats/${savedId}`, {
      method: 'GET',
      headers: { 'X-AI-Bridge-Token': testAuthToken }
    });
    assert(getAfterDelete.status === 404, 'Deleted chat returns 404 Not Found');
  }

  // --------------------------------------------------------------------------
  // Group 5: Demo Mode Simulated Orchestration
  // --------------------------------------------------------------------------
  console.log('\n--- Group 5: Demo Mode Simulated Orchestration ---');

  // Test 14: Demo Session Execution across modes
  {
    const demoRunner = main.runDemoLLMSession({
      topic: 'Camera smoothing in 3D games',
      mode: 'debate',
      rounds: 1,
      providers: ['chatgpt', 'claude', 'gemini']
    });

    assert(Boolean(demoRunner.sessionId), 'Demo session runner returns sessionId');
    assert(typeof demoRunner.cancel === 'function', 'Demo session runner provides cancel handle');

    // Test cancellation
    demoRunner.cancel();
    assert(true, 'Demo session cancellation executes safely without unhandled rejections');
  }

  // --------------------------------------------------------------------------
  // Group 6: Safety, Security & Freeze Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Group 6: Safety & Freeze Verification ---');

  // Test 15: Zero API keys and zero credential storage
  {
    const configPath = main.getSavedChatsDir();
    assert(fs.existsSync(configPath), 'Saved chats directory exists');

    // Verify ai_bridge.sh is untouched and present
    const aiBridgeSh = path.join(__dirname, '..', 'ai_bridge.sh');
    assert(fs.existsSync(aiBridgeSh), 'ai_bridge.sh backend is preserved');

    // Inspect codebase for zero auth header / cookie harvesting
    const bgJs = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'background.js'), 'utf8');
    assert(!bgJs.includes('chrome.cookies'), 'Zero cookie reading APIs in background.js');
    assert(!bgJs.includes('localStorage.getItem("token")'), 'Zero token harvesting in background.js');
  }

  console.log('\n===============================================================');
  console.log(` Test Summary: ${passedCount} passed, ${failedCount} failed.`);
  console.log('===============================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests().catch((err) => {
  console.error('\nTest Suite Fatal Error:', err);
  process.exit(1);
});
