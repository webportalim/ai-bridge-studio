/**
 * AI Bridge Companion - Popup Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  const DEFAULT_PORT = 45821;
  let serverPort = DEFAULT_PORT;
  let authToken = null;
  let activeTab = null;
  let extractedPayload = null;

  // DOM Elements
  const badge = document.getElementById('connection-badge');
  const badgeText = document.getElementById('badge-text');

  const viewUnpaired = document.getElementById('view-unpaired');
  const viewChatgpt = document.getElementById('view-chatgpt');
  const viewUnsupported = document.getElementById('view-unsupported');

  const pairingCodeInput = document.getElementById('pairing-code');
  const serverPortInput = document.getElementById('server-port');
  const btnPair = document.getElementById('btn-pair');
  const pairError = document.getElementById('pair-error');

  const btnSendChat = document.getElementById('btn-send-chat');
  const sendStatus = document.getElementById('send-status');

  const chatgptDetectedContent = document.getElementById('chatgpt-detected-content');
  const chatgptUndetectedContent = document.getElementById('chatgpt-undetected-content');
  const chatgptConvTitle = document.getElementById('chatgpt-conv-title');
  const chatgptConvStats = document.getElementById('chatgpt-conv-stats');
  const chatgptTruncationNote = document.getElementById('chatgpt-truncation-note');

  const btnUnpair1 = document.getElementById('btn-unpair-1');
  const btnUnpair2 = document.getElementById('btn-unpair-2');

  function getServerUrl() {
    return `http://127.0.0.1:${serverPort}`;
  }

  function setBadgeState(connected) {
    if (connected) {
      badge.className = 'badge badge-connected';
      badgeText.innerText = 'Connected';
    } else {
      badge.className = 'badge badge-disconnected';
      badgeText.innerText = 'Disconnected';
    }
  }

  function showView(viewName) {
    viewUnpaired.classList.add('hidden');
    viewChatgpt.classList.add('hidden');
    viewUnsupported.classList.add('hidden');

    if (viewName === 'unpaired') viewUnpaired.classList.remove('hidden');
    if (viewName === 'chatgpt') viewChatgpt.classList.remove('hidden');
    if (viewName === 'unsupported') viewUnsupported.classList.remove('hidden');
  }

  // Load stored state
  const storageData = await chrome.storage.local.get(['bridgeToken', 'bridgePort']);
  if (storageData.bridgePort) {
    serverPort = storageData.bridgePort;
    serverPortInput.value = serverPort;
  }
  authToken = storageData.bridgeToken || null;

  // Verify connection with desktop
  async function checkDesktopConnection() {
    try {
      const resp = await fetch(`${getServerUrl()}/v1/status`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (resp.ok) {
        const data = await resp.json();
        return { online: true, paired: data.paired };
      }
    } catch (_) {}
    return { online: false, paired: false };
  }

  // Detect other LLM tabs for the footer list
  async function refreshSecondaryTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      let hasClaude = false;
      let hasGemini = false;
      let hasChatgpt = false;

      for (const t of tabs) {
        const url = t.url || '';
        if (/chatgpt\.com|chat\.openai\.com/i.test(url)) hasChatgpt = true;
        if (/claude\.ai/i.test(url)) hasClaude = true;
        if (/gemini\.google\.com/i.test(url)) hasGemini = true;
      }

      const updateStat = (id, found) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = found ? 'Open tab detected' : 'Not detected';
        if (found) el.classList.add('detected');
        else el.classList.remove('detected');
      };

      updateStat('tab-stat-claude', hasClaude);
      updateStat('tab-stat-gemini', hasGemini);
      updateStat('tab-stat-chatgpt-alt', hasChatgpt);
      updateStat('tab-stat-claude-alt', hasClaude);
      updateStat('tab-stat-gemini-alt', hasGemini);
    } catch (_) {}
  }

  // Inspect current active tab
  async function inspectActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      showView('unsupported');
      return;
    }
    activeTab = tabs[0];
    const url = activeTab.url || '';

    if (window.ChatGPTAdapter && window.ChatGPTAdapter.matches(url)) {
      showView('chatgpt');
      await extractFromChatGPTTab();
    } else {
      showView('unsupported');
    }
    refreshSecondaryTabs();
  }

  // Extract conversation from active ChatGPT tab via scripting
  async function extractFromChatGPTTab() {
    if (!activeTab || !activeTab.id) return;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          if (window.ChatGPTAdapter) {
            return window.ChatGPTAdapter.extractConversation(document, window.location.href);
          }
          return { success: false, error: 'ChatGPT adapter not initialized in tab.' };
        }
      });

      if (results && results[0] && results[0].result) {
        const res = results[0].result;
        if (res.success) {
          extractedPayload = res;
          chatgptUndetectedContent.classList.add('hidden');
          chatgptDetectedContent.classList.remove('hidden');

          chatgptConvTitle.innerText = res.title || 'ChatGPT Conversation';
          chatgptConvStats.innerText = `${res.message_count} messages • ${Math.round(res.char_count / 100) / 10}k chars`;

          if (res.truncated) {
            chatgptTruncationNote.classList.remove('hidden');
          } else {
            chatgptTruncationNote.classList.add('hidden');
          }

          btnSendChat.disabled = false;
        } else {
          extractedPayload = null;
          chatgptDetectedContent.classList.add('hidden');
          chatgptUndetectedContent.classList.remove('hidden');
          btnSendChat.disabled = true;
        }
      }
    } catch (err) {
      console.warn('Tab extraction error:', err);
      extractedPayload = null;
      chatgptDetectedContent.classList.add('hidden');
      chatgptUndetectedContent.classList.remove('hidden');
      btnSendChat.disabled = true;
    }
  }

  // Initialization check
  const desktopStatus = await checkDesktopConnection();
  if (desktopStatus.online && authToken) {
    setBadgeState(true);
    await inspectActiveTab();
  } else {
    setBadgeState(false);
    showView('unpaired');
  }

  // Event: Pair Extension
  btnPair.addEventListener('click', async () => {
    const code = (pairingCodeInput.value || '').trim();
    serverPort = parseInt(serverPortInput.value, 10) || DEFAULT_PORT;

    if (!code || code.length !== 6) {
      pairError.innerText = 'Please enter a 6-digit pairing code.';
      pairError.classList.remove('hidden');
      return;
    }

    pairError.classList.add('hidden');
    btnPair.disabled = true;
    btnPair.innerText = 'Connecting...';

    try {
      const resp = await fetch(`${getServerUrl()}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });

      const data = await resp.json();
      if (resp.ok && data.success && data.token) {
        authToken = data.token;
        await chrome.storage.local.set({
          bridgeToken: authToken,
          bridgePort: serverPort
        });

        // Notify background service worker of port
        chrome.runtime.sendMessage({ type: 'UPDATE_PORT', port: serverPort });

        setBadgeState(true);
        await inspectActiveTab();
      } else {
        pairError.innerText = data.error || 'Invalid or expired pairing code.';
        pairError.classList.remove('hidden');
      }
    } catch (err) {
      pairError.innerText = 'Could not reach AI Bridge Desktop. Is the app running?';
      pairError.classList.remove('hidden');
    } finally {
      btnPair.disabled = false;
      btnPair.innerText = 'Connect to Desktop';
    }
  });

  // Event: Send Current Chat to Desktop
  btnSendChat.addEventListener('click', async () => {
    if (!extractedPayload) {
      // Try re-extracting in case page state changed
      await extractFromChatGPTTab();
    }

    if (!extractedPayload || !extractedPayload.success) {
      sendStatus.className = 'status-msg error';
      sendStatus.innerText = 'No readable conversation found to send.';
      sendStatus.classList.remove('hidden');
      return;
    }

    btnSendChat.disabled = true;
    btnSendChat.innerText = 'Sending...';
    sendStatus.classList.add('hidden');

    try {
      const resp = await fetch(`${getServerUrl()}/v1/context/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Bridge-Token': authToken
        },
        body: JSON.stringify(extractedPayload)
      });

      const data = await resp.json();
      if (resp.ok && data.success) {
        sendStatus.className = 'status-msg success';
        sendStatus.innerText = `✓ Sent to AI Bridge (${extractedPayload.message_count} messages)`;
        sendStatus.classList.remove('hidden');
      } else {
        sendStatus.className = 'status-msg error';
        sendStatus.innerText = data.error || 'Failed to import context.';
        sendStatus.classList.remove('hidden');
      }
    } catch (err) {
      sendStatus.className = 'status-msg error';
      sendStatus.innerText = 'Error transmitting to AI Bridge Desktop.';
      sendStatus.classList.remove('hidden');
    } finally {
      btnSendChat.disabled = false;
      btnSendChat.innerText = 'Send Current Chat to AI Bridge';
    }
  });

  // Event: Unpair
  const handleUnpair = async () => {
    await chrome.storage.local.remove(['bridgeToken']);
    authToken = null;
    setBadgeState(false);
    showView('unpaired');
    pairingCodeInput.value = '';
    pairError.classList.add('hidden');
  };

  btnUnpair1.addEventListener('click', handleUnpair);
  btnUnpair2.addEventListener('click', handleUnpair);
});
