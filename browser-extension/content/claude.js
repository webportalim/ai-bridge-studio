/**
 * AI Bridge - Claude Content Script Adapter
 * Semantic extraction and DOM automation for Claude.ai web tabs
 */
(function (root, factory) {
  const common = (typeof root === 'object' && root && root.AIBridgeCommon) ? root.AIBridgeCommon : (typeof require === 'function' ? require('./common') : {});
  const mod = factory(common);
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (root) {
    root.ClaudeAdapter = mod;
  }
}(typeof self !== 'undefined' ? self : this, function (common) {
  'use strict';

  const ADAPTER_NAME = 'claude';
  const ADAPTER_VERSION = '1.1.0';

  function matches(url) {
    if (!url) return false;
    return /https?:\/\/(www\.)?claude\.ai/i.test(url);
  }

  function detect(doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return { detected: false, count: 0, ready: false };

    const nodes = documentRef.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"], .font-user-message, .font-claude-message');
    const composer = documentRef.querySelector('div.ProseMirror[contenteditable="true"], div[contenteditable="true"], textarea');
    return {
      detected: nodes.length > 0 || Boolean(composer),
      count: nodes.length,
      ready: Boolean(composer)
    };
  }

  function getMetadata(doc, currentUrl = '') {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    let title = 'Claude Conversation';
    let url = currentUrl || (typeof window !== 'undefined' ? window.location.href : '');

    if (documentRef && documentRef.title) {
      title = documentRef.title.replace(/(\s*[-|–—]\s*)?Claude\s*$/i, '').trim() || title;
    }
    return { title, url };
  }

  function extractConversation(doc, currentUrl = '') {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) {
      return { success: false, error: 'Document reference is unavailable.' };
    }

    const { title, url } = getMetadata(documentRef, currentUrl);
    // Find turns in chronological order
    const turns = documentRef.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"], .font-user-message, .font-claude-message');

    if (!turns || turns.length === 0) {
      return {
        success: false,
        error: 'Claude conversation could not be detected. The website layout may have changed.'
      };
    }

    const rawMessages = [];
    turns.forEach((node) => {
      const isUser = node.getAttribute('data-testid') === 'user-message' || node.classList.contains('font-user-message');
      const role = isUser ? 'user' : 'assistant';
      const text = common.sanitizeText(common.cleanNodeText(node));

      if (text.length > 0) {
        rawMessages.push({
          role,
          text,
          index: rawMessages.length
        });
      }
    });

    if (rawMessages.length === 0) {
      return { success: false, error: 'No readable Claude messages extracted.' };
    }

    const { messages, truncated, charCount } = common.truncateContext(rawMessages, common.MAX_CAPTURE_CHARS);

    return {
      success: true,
      version: 1,
      provider: ADAPTER_NAME,
      adapter_version: ADAPTER_VERSION,
      title,
      url,
      captured_at: new Date().toISOString(),
      message_count: messages.length,
      char_count: charCount,
      truncated,
      messages
    };
  }

  // =========================================================================
  // AUTOMATION API
  // =========================================================================

  // Semantic, multi-candidate lookups (avoids hashed build-time CSS classes,
  // which change on every Claude.ai deploy).
  const COMPOSER_SELECTORS = [
    'div.ProseMirror[contenteditable="true"]',
    'form [contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'form textarea',
    'textarea'
  ];

  const SEND_BUTTON_SELECTORS = [
    'button[data-testid="chat-input-send"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send" i]',
    'fieldset button:has(svg)'
  ];

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function findComposer(documentRef) {
    for (const sel of COMPOSER_SELECTORS) {
      const nodes = documentRef.querySelectorAll(sel);
      for (const node of nodes) {
        if (isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true') {
          return node;
        }
      }
    }
    return null;
  }

  function findSendButton(documentRef, composer) {
    // Pick the first VISIBLE match per selector — a hidden/off-screen element
    // sharing the same aria-label elsewhere on the page (a feedback widget,
    // a collapsed menu item) would otherwise be selected instead of the
    // real, on-screen send button.
    for (const sel of SEND_BUTTON_SELECTORS) {
      const nodes = documentRef.querySelectorAll(sel);
      for (const btn of nodes) {
        if (isVisible(btn)) return btn;
      }
    }
    if (composer) {
      const form = composer.closest('form') || composer.closest('fieldset');
      if (form) {
        const btn = form.querySelector('button[type="submit"], button:has(svg)');
        if (btn) return btn;
      }
    }
    return null;
  }

  function describeElement(el) {
    if (!el) return null;
    return {
      tagName: el.tagName,
      contenteditable: el.getAttribute && el.getAttribute('contenteditable'),
      role: el.getAttribute && el.getAttribute('role'),
      dataTestId: el.getAttribute && el.getAttribute('data-testid'),
      ariaLabel: el.getAttribute && el.getAttribute('aria-label'),
      disabled: Boolean(el.disabled) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function setComposerValue(composer, text) {
    composer.focus();

    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const proto = composer.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(composer, text);
      } else {
        composer.value = text;
      }
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (composer.isContentEditable) {
      let inserted = false;
      try {
        document.execCommand('selectAll', false, null);
        inserted = document.execCommand('insertText', false, text);
      } catch (_) {
        inserted = false;
      }
      if (!inserted) {
        composer.innerHTML = `<p>${text.replace(/\n/g, '</p><p>')}</p>`;
        composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      }
      return true;
    }

    return false;
  }

  function isGenerating(doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return false;

    const stopBtn = documentRef.querySelector('button[aria-label="Stop response"], button[aria-label*="Stop response" i], [data-is-streaming="true"]');
    return Boolean(stopBtn);
  }

  function getLastAssistantMessage(doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return '';

    const nodes = documentRef.querySelectorAll('[data-testid="assistant-message"], .font-claude-message');
    if (!nodes || nodes.length === 0) return '';

    const last = nodes[nodes.length - 1];
    return common.sanitizeText(common.cleanNodeText(last));
  }

  // Structured result: { success, ok, provider, stage, error, diagnostics }.

  const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"], .font-claude-message';

  function getComposerSnapshot(composer) {
    if (!composer) return '';
    if (composer.isContentEditable) return (composer.textContent || '').trim();
    return (composer.value || '').trim();
  }

  // After clicking send / dispatching the Enter fallback, confirm the action
  // actually took effect instead of trusting a click() call that may have
  // hit a stale/disabled/detached button. Polls briefly for any of: the
  // composer clearing, the assistant message count increasing, or the
  // "generating" indicator appearing. This keeps the failure inside
  // background.js's ~12s send-stage timeout instead of only surfacing once
  // the much longer wait-for-response timeout (120s+) expires with nothing
  // ever having been sent.
  async function verifySendTookEffect(documentRef, composer, initialAssistantCount, initialComposerText) {
    // 4.5s budget: generous enough to survive slower UIs (Gemini in
    // particular can take a beat before "generating" or a fresh response
    // node appears), while staying well inside background.js's 12s overall
    // send-stage timeout.
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      await sleep(200);
      if (isGenerating(documentRef)) return true;
      const nowCount = documentRef.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length;
      if (nowCount > initialAssistantCount) return true;
      const nowComposerText = getComposerSnapshot(composer);
      if (initialComposerText && nowComposerText === '') return true;
      // Weaker but still meaningful signal: the composer no longer holds
      // exactly the text we just typed (partial re-render, placeholder
      // swap, etc.) even if it isn't fully empty yet.
      if (initialComposerText && nowComposerText !== initialComposerText) return true;
    }
    return false;
  }

  async function sendMessage(text, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    const diagnostics = {};

    function fail(stage, error) {
      return { success: false, ok: false, provider: ADAPTER_NAME, stage, error, diagnostics };
    }

    if (!documentRef) {
      return fail('tab', 'Document not available.');
    }

    if (isGenerating(documentRef)) {
      return fail('composer', 'Claude is currently generating a response.');
    }

    const composer = findComposer(documentRef);
    diagnostics.composer = describeElement(composer);
    if (!composer) {
      return fail('composer', 'Claude composer input could not be found. Layout may have changed.');
    }

    const populated = await setComposerValue(composer, text);
    if (!populated) {
      return fail('input', 'Composer element is neither an input/textarea nor contenteditable.');
    }

    await sleep(200);

    const initialAssistantCount = documentRef.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length;
    const initialComposerText = getComposerSnapshot(composer);

    const sendBtn = findSendButton(documentRef, composer);
    diagnostics.sendButton = describeElement(sendBtn);

    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
      sendBtn.click();
    } else if (composer.isContentEditable || composer.tagName === 'TEXTAREA') {
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
    } else {
      return fail('send', 'Send button not found or disabled, and no composer to focus for the Enter fallback.');
    }

    const verified = await verifySendTookEffect(documentRef, composer, initialAssistantCount, initialComposerText);
    diagnostics.sendVerified = verified;
    if (!verified) {
      return fail('send', 'Claude send button/Enter fired but no effect was observed (composer not cleared, no new response, not generating). Selector may be stale.');
    }

    return { success: true, ok: true, provider: ADAPTER_NAME, stage: 'send', error: null, diagnostics };
  }

  async function waitForResponse(timeoutMs = 90000, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return { success: false, error: 'Document unavailable.' };

    const startTime = Date.now();
    let initialCount = documentRef.querySelectorAll('[data-testid="assistant-message"], .font-claude-message').length;
    let startedGenerating = false;
    let lastLength = 0;
    let stableChecks = 0;

    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          clearInterval(interval);
          resolve({ success: false, error: `Claude response timed out after ${Math.round(timeoutMs / 1000)}s.` });
          return;
        }

        const generating = isGenerating(documentRef);
        const currentCount = documentRef.querySelectorAll('[data-testid="assistant-message"], .font-claude-message').length;

        if (generating || currentCount > initialCount) {
          startedGenerating = true;
        }

        if (startedGenerating) {
          const latestText = getLastAssistantMessage(documentRef);
          if (latestText && latestText.length > 0) {
            if (latestText.length === lastLength) {
              stableChecks++;
            } else {
              stableChecks = 0;
              lastLength = latestText.length;
            }

            if (!generating && stableChecks >= 2) {
              clearInterval(interval);
              resolve({
                success: true,
                provider: ADAPTER_NAME,
                text: latestText
              });
              return;
            }
          }
        }
      }, 500);
    });
  }

  function cancelGeneration(doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return false;

    const stopBtn = documentRef.querySelector('button[aria-label="Stop response"]');
    if (stopBtn) {
      stopBtn.click();
      return true;
    }
    return false;
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    const globalRef = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : {});
    if (!globalRef.__AI_BRIDGE_CLAUDE_LISTENER__) {
      globalRef.__AI_BRIDGE_CLAUDE_LISTENER__ = true;

      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'AI_BRIDGE_PING') {
          sendResponse({ ok: true, provider: ADAPTER_NAME });
          return true;
        }

        const href = (typeof window !== 'undefined' && window.location) ? window.location.href : '';
        if (!matches(href)) return false;

        if (request.type === 'DETECT') {
          const meta = getMetadata();
          const det = detect();
          sendResponse({
            success: true,
            provider: ADAPTER_NAME,
            detected: det.detected,
            ready: det.ready,
            count: det.count,
            title: meta.title,
            url: meta.url
          });
          return true;
        }

        if (request.type === 'EXTRACT_CONVERSATION') {
          const conv = extractConversation();
          sendResponse(conv);
          return true;
        }

        if (request.type === 'SEND_MESSAGE') {
          sendMessage(request.text).then(sendResponse);
          return true;
        }

        if (request.type === 'WAIT_FOR_RESPONSE') {
          waitForResponse(request.timeoutMs || 120000).then(sendResponse);
          return true;
        }

        if (request.type === 'CANCEL_GENERATION') {
          const cancelled = cancelGeneration();
          sendResponse({ success: true, cancelled });
          return true;
        }

        if (request.type === 'GET_LAST_MESSAGE') {
          const text = getLastAssistantMessage();
          sendResponse({ success: true, text });
          return true;
        }
      });
    }
  }

  return {
    ADAPTER_NAME,
    ADAPTER_VERSION,
    matches,
    detect,
    detectConversation: detect,
    getMetadata,
    extractConversation,
    sendMessage,
    waitForResponse,
    isGenerating,
    getLastAssistantMessage,
    cancelGeneration
  };
}));
