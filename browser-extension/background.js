/**
 * AI Bridge Companion - Background Service Worker (MV3)
 * Orchestrates multi-LLM sessions across active browser tabs (ChatGPT, Claude, Gemini)
 * and streams events to the local AI Bridge Desktop HTTP server.
 */

// Universal import for templates if in Node or browser service worker
let templatesEngine = null;
if (typeof require === 'function') {
  try {
    templatesEngine = require('./content/templates');
  } catch (_) {}
}
if (!templatesEngine && typeof self !== 'undefined' && self.LLMHubTemplates) {
  templatesEngine = self.LLMHubTemplates;
}

// Fallback template builder if external script is not loaded in SW context
const defaultTemplates = {
  buildInitialPrompt: (topic, mode = 'collaborative') => {
    return `[TOPIC / TASK]\n${topic.trim()}\n\n[MODE: ${(mode || 'collaborative').toUpperCase()}]\nProvide your independent, clear, and substantive analysis.`;
  },
  buildReviewPrompt: (topic, previousResponses, mode = 'collaborative', providerName = '', roundNumber = 1) => {
    const history = (previousResponses || []).map(r => `[${(r.provider || 'MODEL').toUpperCase()} (Round ${r.round || 1})]:\n${r.text}`).join('\n\n');
    return `[ORIGINAL TOPIC]\n${topic.trim()}\n\n[PREVIOUS CONTRIBUTIONS]\n${history}\n\n[YOUR ROLE AS ${providerName.toUpperCase()}]\nReview prior contributions, identify agreements/divergences, and add your distinct insights for Round ${roundNumber}.`;
  },
  buildConsensusPrompt: (topic, allResponses, mode = 'collaborative') => {
    const history = (allResponses || []).map(r => `[${(r.provider || 'MODEL').toUpperCase()} (Round ${r.round || 1})]:\n${r.text}`).join('\n\n');
    return `[ORIGINAL TOPIC]\n${topic.trim()}\n\n[DISCUSSION HISTORY]\n${history}\n\n[SYNTHESIS TASK]\nSynthesize a structured final consensus:\n1. Core Consensus\n2. Key Disagreements & Trade-offs\n3. Recommended Approach\n4. Important Caveats`;
  },
  buildFollowUpPrompt: (topic, followUpText, previousResponses, mode = 'collaborative', providerName = '') => {
    return `[ORIGINAL TOPIC]\n${topic.trim()}\n\n[USER FOLLOW-UP QUESTION]\n${followUpText.trim()}\n\n[INSTRUCTIONS FOR ${providerName.toUpperCase()}]\nAnswer the user's follow-up directly within this context.`;
  }
};

const templates = templatesEngine || defaultTemplates;

const DEFAULT_SERVER_PORT = 45821;
let currentPort = DEFAULT_SERVER_PORT;
let activeSession = null;

function getServerUrl() {
  return `http://127.0.0.1:${currentPort}`;
}

async function getStoredAuth() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(['bridgeToken', 'bridgePort']);
      if (data.bridgePort) currentPort = data.bridgePort;
      return { token: data.bridgeToken || null, port: currentPort };
    }
  } catch (_) {}
  return { token: null, port: currentPort };
}

// Emits NDJSON stream events to Desktop
async function emitDesktopEvent(eventData) {
  try {
    const auth = await getStoredAuth();
    if (!auth.token) return;

    const payload = {
      ...eventData,
      timestamp: eventData.timestamp || Date.now()
    };

    await fetch(`${getServerUrl()}/v1/llm-hub/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Bridge-Token': auth.token
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn('Failed to emit LLM Hub event to desktop:', err);
  }
}

// Queries browser tabs for supported LLMs
async function detectLLMTabs() {
  const result = {
    chatgpt: false,
    claude: false,
    gemini: false,
    tabMap: {
      chatgpt: null,
      claude: null,
      gemini: null
    }
  };

  try {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
      return result;
    }

    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      const url = t.url || '';
      if (/https?:\/\/(www\.)?(chatgpt\.com|chat\.openai\.com)/i.test(url)) {
        result.chatgpt = true;
        if (!result.tabMap.chatgpt) result.tabMap.chatgpt = t.id;
      }
      if (/https?:\/\/(www\.)?claude\.ai/i.test(url)) {
        result.claude = true;
        if (!result.tabMap.claude) result.tabMap.claude = t.id;
      }
      if (/https?:\/\/(www\.)?gemini\.google\.com/i.test(url)) {
        result.gemini = true;
        if (!result.tabMap.gemini) result.tabMap.gemini = t.id;
      }
    }
  } catch (err) {
    console.warn('detectLLMTabs error:', err);
  }

  return result;
}

// Report detected tabs to Desktop
async function reportTabsToDesktop(detected) {
  try {
    const auth = await getStoredAuth();
    if (!auth.token) return;

    await fetch(`${getServerUrl()}/v1/tabs/detect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Bridge-Token': auth.token
      },
      body: JSON.stringify({
        chatgpt: detected.chatgpt,
        claude: detected.claude,
        gemini: detected.gemini
      })
    });
  } catch (_) {}
}

// Send runtime message to a specific tab
function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
      return resolve({ success: false, error: 'Chrome tabs API not available' });
    }
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        return resolve({ success: false, error: chrome.runtime.lastError.message });
      }
      resolve(response || { success: true });
    });
  });
}

// ============================================================================
// First-Hop Reliability Helpers
// ----------------------------------------------------------------------------
// Everything between "Start Session" and a prompt actually landing in a
// provider tab: validate the locked tab is still the right page, health-check
// the content script with a ping/pong, reinject it if it never loaded (e.g.
// the tab was open before the extension did), then send — all bounded by a
// hard timeout so a broken hop fails fast instead of leaving the desktop UI
// stuck on "Asking ALL...".
// ============================================================================

const PROVIDER_CONTENT_FILES = {
  chatgpt: ['content/common.js', 'content/templates.js', 'content/chatgpt.js'],
  claude: ['content/common.js', 'content/templates.js', 'content/claude.js'],
  gemini: ['content/common.js', 'content/templates.js', 'content/gemini.js']
};

const PROVIDER_URL_PATTERNS = {
  chatgpt: /https?:\/\/(www\.)?(chatgpt\.com|chat\.openai\.com)/i,
  claude: /https?:\/\/(www\.)?claude\.ai/i,
  gemini: /https?:\/\/(www\.)?gemini\.google\.com/i
};

// Budget for "get the prompt onto the page" (tab check + inject + click send).
// Deliberately separate from WAIT_FOR_RESPONSE's much longer timeout, which
// covers the model actually generating a reply.
const SEND_STAGE_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, timeoutValue) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(timeoutValue);
      }
    }, ms);
    promise.then((val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(timeoutValue);
    });
  });
}

function getTabInfo(tabId) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) {
      return resolve(null);
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        return resolve(null);
      }
      resolve(tab || null);
    });
  });
}

// Health-check: is the content script actually alive in this tab?
function pingProviderTab(tabId) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
      return resolve(false);
    }
    chrome.tabs.sendMessage(tabId, { type: 'AI_BRIDGE_PING' }, (response) => {
      if (chrome.runtime.lastError) {
        return resolve(false);
      }
      resolve(Boolean(response && response.ok));
    });
  });
}

// If the ping fails, the tab was most likely opened before the extension
// loaded (so manifest content_scripts never ran there). Re-inject safely.
async function ensureContentScriptReady(tabId, provider) {
  const alreadyUp = await pingProviderTab(tabId);
  if (alreadyUp) return { ready: true, reinjected: false };

  const files = PROVIDER_CONTENT_FILES[provider];
  if (!files || typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.executeScript) {
    return { ready: false, reinjected: false, error: 'Content script not responding and reinjection is unavailable.' };
  }

  try {
    console.log(`[AI Bridge] ${provider} content script did not respond to ping — reinjecting`, { tabId, files });
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (err) {
    return { ready: false, reinjected: false, error: `Reinjection failed: ${err.message}` };
  }

  // Give the freshly injected script a moment to register its listener.
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ok = await pingProviderTab(tabId);
    if (ok) return { ready: true, reinjected: true };
  }

  return { ready: false, reinjected: true, error: 'Content script still not responding after reinjection.' };
}

// Full first-hop pipeline for one provider tab. Returns
// { ok, stage: 'tab'|'inject'|'send'|'timeout', error, diagnostics }.
async function sendPromptToProviderTab(tabId, provider, text) {
  const attempt = (async () => {
    const tab = await getTabInfo(tabId);
    if (!tab) {
      return { ok: false, stage: 'tab', error: `Tab ${tabId} no longer exists.`, diagnostics: { tabId, provider } };
    }

    const diagnostics = { tabId, provider, url: tab.url };
    console.log(`[AI Bridge] Sending prompt to ${provider}`, diagnostics);

    const urlPattern = PROVIDER_URL_PATTERNS[provider];
    if (urlPattern && !urlPattern.test(tab.url || '')) {
      return { ok: false, stage: 'tab', error: `Tab ${tabId} no longer points at ${provider} (url: ${tab.url}).`, diagnostics };
    }

    const readiness = await ensureContentScriptReady(tabId, provider);
    diagnostics.reinjected = readiness.reinjected;
    if (!readiness.ready) {
      return { ok: false, stage: 'inject', error: readiness.error || 'Content script not available in tab.', diagnostics };
    }

    const sendRes = await sendTabMessage(tabId, { type: 'SEND_MESSAGE', text });
    if (!sendRes || !(sendRes.ok || sendRes.success)) {
      return {
        ok: false,
        stage: (sendRes && sendRes.stage) || 'send',
        error: (sendRes && sendRes.error) || 'Unknown error sending message.',
        diagnostics: Object.assign({}, diagnostics, sendRes && sendRes.diagnostics)
      };
    }

    return { ok: true, stage: 'send', diagnostics: Object.assign({}, diagnostics, sendRes.diagnostics) };
  })();

  return withTimeout(attempt, SEND_STAGE_TIMEOUT_MS, {
    ok: false,
    stage: 'timeout',
    error: `Provider did not accept the prompt within ${Math.round(SEND_STAGE_TIMEOUT_MS / 1000)}s.`,
    diagnostics: { tabId, provider }
  });
}

// LLM Hub Session Manager
class LLMHubOrchestrator {
  constructor() {
    this.session = null;
    this.isCancelled = false;
  }

  async validateAndLockTabs(selectedProviders) {
    const detected = await detectLLMTabs();
    const missing = [];
    const lockedTabs = {};

    for (const p of selectedProviders) {
      const key = p.toLowerCase();
      if (!detected[key] || !detected.tabMap[key]) {
        const readableName = p.charAt(0).toUpperCase() + p.slice(1);
        missing.push(readableName);
      } else {
        lockedTabs[key] = detected.tabMap[key];
        console.log(`[AI Bridge] Locked ${key} tab for session`, { tabId: detected.tabMap[key] });
      }
    }

    if (missing.length > 0) {
      return {
        valid: false,
        error: `${missing.join(' and ')} browser tab is not connected.`
      };
    }

    return {
      valid: true,
      lockedTabs
    };
  }

  async startSession(options) {
    const {
      sessionId = `llm_${Date.now()}`,
      topic,
      mode = 'collaborative',
      rounds = 2,
      providers = ['chatgpt', 'claude', 'gemini']
    } = options;

    if (!topic || !topic.trim()) {
      await emitDesktopEvent({
        event: 'session_error',
        sessionId,
        error: 'Topic is required to start a session.'
      });
      return { success: false, error: 'Topic is required.' };
    }

    if (!Array.isArray(providers) || providers.length < 2) {
      await emitDesktopEvent({
        event: 'session_error',
        sessionId,
        error: 'At least two LLM providers must be selected.'
      });
      return { success: false, error: 'At least 2 providers required.' };
    }

    const roundCount = Math.max(1, Math.min(5, parseInt(rounds, 10) || 2));
    const lockResult = await this.validateAndLockTabs(providers);

    if (!lockResult.valid) {
      await emitDesktopEvent({
        event: 'session_error',
        sessionId,
        error: lockResult.error
      });
      return { success: false, error: lockResult.error };
    }

    this.isCancelled = false;
    this.session = {
      sessionId,
      topic: topic.trim(),
      mode,
      totalRounds: roundCount,
      providers,
      lockedTabs: lockResult.lockedTabs,
      history: [],
      consensus: null,
      startedAt: Date.now(),
      status: 'running'
    };
    activeSession = this.session;

    await emitDesktopEvent({
      event: 'session_started',
      sessionId,
      topic: this.session.topic,
      mode: this.session.mode,
      totalRounds: this.session.totalRounds,
      providers: this.session.providers
    });

    try {
      // Execute Rounds
      for (let r = 1; r <= roundCount; r++) {
        if (this.isCancelled) break;

        await emitDesktopEvent({
          event: 'round_started',
          sessionId,
          round: r,
          totalRounds: roundCount
        });

        for (let i = 0; i < providers.length; i++) {
          if (this.isCancelled) break;

          const provider = providers[i].toLowerCase();
          const tabId = lockResult.lockedTabs[provider];

          let promptText = '';
          if (r === 1 && i === 0) {
            promptText = templates.buildInitialPrompt(this.session.topic, mode);
          } else {
            promptText = templates.buildReviewPrompt(
              this.session.topic,
              this.session.history,
              mode,
              provider,
              r
            );
          }

          await emitDesktopEvent({
            event: 'provider_started',
            sessionId,
            round: r,
            provider,
            prompt: promptText
          });

          // 1. Send prompt to provider tab (validated tab + health-checked
          // content script + hard timeout — see sendPromptToProviderTab)
          const sendRes = await sendPromptToProviderTab(tabId, provider, promptText);

          if (!sendRes || !sendRes.ok) {
            await emitDesktopEvent({
              event: 'provider_failed',
              sessionId,
              round: r,
              provider,
              stage: sendRes ? sendRes.stage : 'unknown',
              error: sendRes ? sendRes.error : 'Unknown error',
              diagnostics: sendRes ? sendRes.diagnostics : null
            });
            throw new Error(`Failed to send message to ${provider} tab (stage: ${sendRes ? sendRes.stage : '?'}): ${sendRes ? sendRes.error : 'Unknown error'}`);
          }

          // 2. Wait for assistant generation
          const waitRes = await sendTabMessage(tabId, {
            type: 'WAIT_FOR_RESPONSE',
            timeoutMs: 180000
          });

          if (this.isCancelled) break;

          if (!waitRes || !waitRes.success) {
            throw new Error(`${provider} failed to produce a response: ${waitRes ? waitRes.error : 'Timeout'}`);
          }

          const responseText = waitRes.text || '';
          const responseEntry = {
            round: r,
            provider,
            text: responseText,
            timestamp: Date.now()
          };

          this.session.history.push(responseEntry);

          await emitDesktopEvent({
            event: 'provider_finished',
            sessionId,
            round: r,
            provider,
            text: responseText
          });
        }

        if (!this.isCancelled) {
          await emitDesktopEvent({
            event: 'round_finished',
            sessionId,
            round: r
          });
        }
      }

      // Execute Final Consensus if not cancelled
      if (!this.isCancelled) {
        const lastProvider = providers[providers.length - 1].toLowerCase();
        const tabId = lockResult.lockedTabs[lastProvider];

        await emitDesktopEvent({
          event: 'consensus_started',
          sessionId,
          provider: lastProvider
        });

        const consensusPrompt = templates.buildConsensusPrompt(
          this.session.topic,
          this.session.history,
          mode
        );

        const consensusSendRes = await sendPromptToProviderTab(tabId, lastProvider, consensusPrompt);
        if (!consensusSendRes || !consensusSendRes.ok) {
          await emitDesktopEvent({
            event: 'provider_failed',
            sessionId,
            round: 'consensus',
            provider: lastProvider,
            stage: consensusSendRes ? consensusSendRes.stage : 'unknown',
            error: consensusSendRes ? consensusSendRes.error : 'Unknown error',
            diagnostics: consensusSendRes ? consensusSendRes.diagnostics : null
          });
          throw new Error(`Failed to send consensus prompt to ${lastProvider} tab (stage: ${consensusSendRes ? consensusSendRes.stage : '?'}): ${consensusSendRes ? consensusSendRes.error : 'Unknown error'}`);
        }

        const consensusRes = await sendTabMessage(tabId, {
          type: 'WAIT_FOR_RESPONSE',
          timeoutMs: 180000
        });

        if (this.isCancelled) return { success: false, cancelled: true };

        const consensusText = (consensusRes && consensusRes.success) ? consensusRes.text : 'Consensus synthesis completed.';
        this.session.consensus = consensusText;
        this.session.status = 'completed';
        this.session.finishedAt = Date.now();

        await emitDesktopEvent({
          event: 'consensus_finished',
          sessionId,
          provider: lastProvider,
          consensus: consensusText
        });

        await emitDesktopEvent({
          event: 'session_finished',
          sessionId,
          session: this.session
        });

        // Save session automatically to desktop storage
        try {
          const auth = await getStoredAuth();
          if (auth.token) {
            await fetch(`${getServerUrl()}/v1/llm-hub/saved-chats`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-AI-Bridge-Token': auth.token
              },
              body: JSON.stringify(this.session)
            });
          }
        } catch (_) {}

        return { success: true, session: this.session };
      } else {
        await emitDesktopEvent({
          event: 'session_cancelled',
          sessionId
        });
        return { success: false, cancelled: true };
      }

    } catch (err) {
      console.error('LLM Hub session execution failed:', err);
      this.session.status = 'error';
      this.session.error = err.message;

      await emitDesktopEvent({
        event: 'session_error',
        sessionId,
        error: err.message
      });

      return { success: false, error: err.message };
    } finally {
      activeSession = null;
    }
  }

  async stopSession() {
    this.isCancelled = true;
    if (this.session && this.session.lockedTabs) {
      for (const provider of Object.keys(this.session.lockedTabs)) {
        const tabId = this.session.lockedTabs[provider];
        try {
          await sendTabMessage(tabId, { type: 'CANCEL_GENERATION' });
        } catch (_) {}
      }
    }
    if (this.session) {
      this.session.status = 'cancelled';
      await emitDesktopEvent({
        event: 'session_cancelled',
        sessionId: this.session.sessionId
      });
    }
    activeSession = null;
    return { success: true };
  }

  async sendFollowUp(options) {
    const {
      sessionId = (this.session ? this.session.sessionId : `llm_${Date.now()}`),
      text,
      targetProvider = 'all'
    } = options;

    if (!text || !text.trim()) {
      return { success: false, error: 'Follow-up text is required.' };
    }

    const detected = await detectLLMTabs();
    const providersToAsk = targetProvider === 'all'
      ? ['chatgpt', 'claude', 'gemini'].filter(p => detected[p])
      : [targetProvider.toLowerCase()].filter(p => detected[p]);

    if (providersToAsk.length === 0) {
      return { success: false, error: 'Target provider tab is not connected.' };
    }

    const history = this.session ? this.session.history : [];
    const topic = this.session ? this.session.topic : text;
    const mode = this.session ? this.session.mode : 'collaborative';

    for (const provider of providersToAsk) {
      const tabId = detected.tabMap[provider];
      const prompt = templates.buildFollowUpPrompt(topic, text, history, mode, provider);

      await emitDesktopEvent({
        event: 'provider_started',
        sessionId,
        round: 'follow-up',
        provider,
        prompt
      });

      const sendRes = await sendPromptToProviderTab(tabId, provider, prompt);
      if (!sendRes || !sendRes.ok) {
        await emitDesktopEvent({
          event: 'provider_failed',
          sessionId,
          round: 'follow-up',
          provider,
          stage: sendRes ? sendRes.stage : 'unknown',
          error: sendRes ? sendRes.error : 'Unknown error',
          diagnostics: sendRes ? sendRes.diagnostics : null
        });
        continue;
      }
      const waitRes = await sendTabMessage(tabId, { type: 'WAIT_FOR_RESPONSE', timeoutMs: 120000 });

      if (waitRes && waitRes.success) {
        const followUpEntry = {
          round: 'follow-up',
          provider,
          text: waitRes.text,
          timestamp: Date.now()
        };
        if (this.session) this.session.history.push(followUpEntry);

        await emitDesktopEvent({
          event: 'provider_finished',
          sessionId,
          round: 'follow-up',
          provider,
          text: waitRes.text
        });
      }
    }

    return { success: true };
  }
}

const orchestrator = new LLMHubOrchestrator();

// ============================================================================
// Desktop Command Polling
// ----------------------------------------------------------------------------
// The Electron desktop app and this extension are two separate browser
// processes; the local HTTP server is the only thing connecting them, and it
// only lets the extension push events (fetch). To actually receive a
// "start session" command, this extension has to pull for it — the desktop's
// llm-hub:start-session IPC handler queues a command, and we poll it here.
//
// MV3 service workers can be suspended after ~30s of no extension-API
// activity, so a fast setInterval is backed by a chrome.alarms wake-up as a
// fallback in case the worker went to sleep between polls.
// ============================================================================

let commandPollInFlight = false;

async function pollForCommands() {
  if (commandPollInFlight) return;
  commandPollInFlight = true;
  try {
    const auth = await getStoredAuth();
    if (!auth.token) return;

    const resp = await fetch(`${getServerUrl()}/v1/llm-hub/command`, {
      method: 'GET',
      headers: { 'X-AI-Bridge-Token': auth.token }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    const cmd = data && data.command;
    if (!cmd || !cmd.type) return;

    console.log('[AI Bridge] Received desktop command:', cmd.type, cmd.id);

    if (cmd.type === 'START_LLM_SESSION') {
      orchestrator.startSession(cmd.options || {});
    } else if (cmd.type === 'STOP_LLM_SESSION') {
      orchestrator.stopSession();
    } else if (cmd.type === 'FOLLOW_UP_LLM') {
      orchestrator.sendFollowUp(cmd.options || {});
    }
  } catch (err) {
    console.warn('[AI Bridge] Command poll failed:', err);
  } finally {
    commandPollInFlight = false;
  }
}

if (typeof setInterval === 'function') {
  setInterval(pollForCommands, 1000);
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create('aiBridgeCommandPoll', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'aiBridgeCommandPoll') {
      pollForCommands();
    }
  });
}

// Tab listeners
if (typeof chrome !== 'undefined' && chrome.tabs) {
  if (chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      if (changeInfo.status === 'complete') {
        const detected = await detectLLMTabs();
        reportTabsToDesktop(detected);
      }
    });
  }

  if (chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(async () => {
      const detected = await detectLLMTabs();
      reportTabsToDesktop(detected);
    });
  }
}

// Runtime message listener for popup & desktop commands
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'DETECT_TABS') {
      detectLLMTabs().then(sendResponse);
      return true;
    }

    if (request.type === 'UPDATE_PORT') {
      currentPort = request.port || DEFAULT_SERVER_PORT;
      chrome.storage.local.set({ bridgePort: currentPort }, () => {
        sendResponse({ success: true });
      });
      return true;
    }

    if (request.type === 'START_LLM_SESSION') {
      orchestrator.startSession(request.options).then(sendResponse);
      return true;
    }

    if (request.type === 'STOP_LLM_SESSION') {
      orchestrator.stopSession().then(sendResponse);
      return true;
    }

    if (request.type === 'FOLLOW_UP_LLM') {
      orchestrator.sendFollowUp(request.options).then(sendResponse);
      return true;
    }
  });
}

// Node.js module export for unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectLLMTabs,
    reportTabsToDesktop,
    LLMHubOrchestrator,
    orchestrator,
    defaultTemplates,
    sendPromptToProviderTab,
    pingProviderTab,
    ensureContentScriptReady,
    pollForCommands
  };
}
