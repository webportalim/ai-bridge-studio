/**
 * AI Bridge - Common Content Extraction Utilities
 * Compatible with Browser Content Scripts and Node.js (for testing)
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (root) {
    root.AIBridgeCommon = mod;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CAPTURE_CHARS = 250000;

  /**
   * Check if an element or its ancestors match UI control selectors that should be excluded
   */
  function isExcludedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const tagName = node.tagName.toLowerCase();

    // Direct excluded tags
    if (['button', 'svg', 'nav', 'header', 'footer'].includes(tagName)) {
      // Don't exclude pre/code inside or anything wanted
      return true;
    }

    // ARIA roles
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (['button', 'toolbar', 'menu', 'menubar'].includes(role)) {
      return true;
    }

    // Rich inline UI widgets (e.g. ChatGPT's "world clock" card, rendered
    // inline in an assistant message when the topic is about date/time).
    // These are real content nodes -- plain div/p/h3 tags, not
    // button/nav/aria chrome -- so none of the checks above catch them,
    // and their widget-face text (hour labels, "+0hrs", tick marks, etc.)
    // was leaking into the plain-text context sent to the other providers
    // as if it were part of ChatGPT's actual answer. Matched by the
    // widget's own data-testid on its outer wrapper
    // (data-testid="dil-widget-shell"), plus a class-name fallback for the
    // same widget-renderer component in case the testid is ever dropped.
    const testId = (node.getAttribute('data-testid') || '').toLowerCase();
    if (testId.includes('widget-shell') || testId.includes('widget-renderer')) {
      return true;
    }

    // Class and attribute based noise
    const className = (typeof node.className === 'string' ? node.className : '').toLowerCase();
    if (
      className.includes('sr-only') ||
      className.includes('screen-reader') ||
      className.includes('actions-toolbar') ||
      className.includes('copy-code') ||
      className.includes('message-actions') ||
      className.includes('widgetrenderer')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Cleanly extract text content from a DOM node while preserving code blocks and excluding UI chrome
   */
  function cleanNodeText(rootNode) {
    if (!rootNode) return '';

    // If text node
    if (rootNode.nodeType === 3) {
      return rootNode.nodeValue || '';
    }

    if (rootNode.nodeType !== 1) {
      return '';
    }

    if (isExcludedNode(rootNode)) {
      return '';
    }

    const tagName = rootNode.tagName.toLowerCase();

    // Preserve code blocks verbatim
    if (tagName === 'pre' || tagName === 'code') {
      // Clone and strip any buttons inside code block header (like "Copy code")
      let text = '';
      for (const child of rootNode.childNodes) {
        if (!isExcludedNode(child)) {
          text += cleanNodeText(child);
        }
      }
      return text;
    }

    let result = '';
    for (const child of rootNode.childNodes) {
      result += cleanNodeText(child);
    }

    // Add sensible spacing around block-level elements
    if (['p', 'div', 'article', 'section', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
      result = result.trim();
      if (result) {
        result += '\n\n';
      }
    }

    return result;
  }

  /**
   * Sanitize text: collapse excessive empty lines, trim trailing whitespace
   */
  function sanitizeText(rawText) {
    if (!rawText) return '';
    return rawText
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Truncate oversized context, keeping the most recent messages from the end
   */
  function truncateContext(messages, maxChars = MAX_CAPTURE_CHARS) {
    if (!Array.isArray(messages)) return { messages: [], truncated: false, charCount: 0 };

    let totalChars = 0;
    for (const msg of messages) {
      totalChars += (msg.text || '').length;
    }

    if (totalChars <= maxChars) {
      return {
        messages: messages.map((m, idx) => ({ ...m, index: idx })),
        truncated: false,
        charCount: totalChars
      };
    }

    // Keep most recent messages fitting in maxChars
    const kept = [];
    let currentChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const len = (msg.text || '').length;
      if (currentChars + len > maxChars && kept.length > 0) {
        break;
      }
      kept.unshift(msg);
      currentChars += len;
    }

    return {
      messages: kept.map((m, idx) => ({ ...m, index: idx })),
      truncated: true,
      charCount: currentChars
    };
  }

  return {
    MAX_CAPTURE_CHARS,
    isExcludedNode,
    cleanNodeText,
    sanitizeText,
    truncateContext
  };
}));
