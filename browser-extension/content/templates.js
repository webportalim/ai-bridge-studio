/**
 * AI Bridge — LLM Hub Prompt Template Engine
 * Formulates structured prompts for Collaborative, Debate, Brainstorm, and Code Review modes.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (root) {
    root.LLMHubTemplates = mod;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MODE_INSTRUCTIONS = {
    collaborative: `Mode: COLLABORATIVE SYNTHESIS
Your objective is to build constructively upon prior contributions, bridge gaps, and work towards a cohesive, high-quality solution. Acknowledge valuable insights from other models while refining and extending the core idea.`,

    debate: `Mode: STRUCTURED DEBATE
Your objective is to critically evaluate previous arguments, point out hidden assumptions, edge-case failures, or trade-offs, and defend a distinct and well-reasoned perspective. Do not simply agree.`,

    brainstorm: `Mode: CREATIVE BRAINSTORMING
Your objective is to generate fresh, innovative, and non-overlapping ideas. Avoid repeating suggestions already mentioned by other models. Propose unconventional or high-leverage alternatives.`,

    code_review: `Mode: TECHNICAL & CODE REVIEW
Your objective is to focus strictly on software architecture, implementation correctness, edge cases, security, performance, and API design. Provide concrete code snippets and technical critiques.`
  };

  function formatPreviousResponses(previousResponses, maxChars = 20000, excludeProvider = null) {
    if (!Array.isArray(previousResponses) || previousResponses.length === 0) {
      return '';
    }

    // Drop this provider's own earlier turns before formatting. They are
    // already present natively in this same browser tab/thread (each
    // provider tab keeps its own real conversation history) -- re-pasting
    // them back as if they were a stranger's "previous contribution" is
    // what made every round read like a brand-new context dump instead of
    // a continuation of the same ongoing chat.
    const excludeKey = excludeProvider ? String(excludeProvider).toLowerCase() : null;
    const source = excludeKey
      ? previousResponses.filter((r) => (r.provider || '').toLowerCase() !== excludeKey)
      : previousResponses;

    if (source.length === 0) {
      return '';
    }

    const lines = [];
    let charCount = 0;

    // Iterate backwards to keep the most recent responses if truncation is needed
    for (let i = source.length - 1; i >= 0; i--) {
      const resp = source[i];
      const header = `[${(resp.provider || 'MODEL').toUpperCase()} RESPONSE (Round ${resp.round || 1})]`;
      const text = resp.text || '';
      const entry = `${header}\n${text}\n\n`;

      if (charCount + entry.length > maxChars && lines.length > 0) {
        break;
      }
      lines.unshift(entry);
      charCount += entry.length;
    }

    return lines.join('');
  }

  /**
   * Build initial prompt for the first participant in Round 1
   */
  function buildInitialPrompt(topic, mode = 'collaborative') {
    const modeKey = (mode || 'collaborative').toLowerCase().replace('-', '_');
    const instruction = MODE_INSTRUCTIONS[modeKey] || MODE_INSTRUCTIONS.collaborative;

    return `[TOPIC / TASK]
${topic.trim()}

[INSTRUCTIONS]
${instruction}

Provide your independent, clear, and substantive analysis. Be concise but thorough.`;
  }

  /**
   * Build review / continuation prompt for subsequent participants in a round
   */
  function buildReviewPrompt(topic, previousResponses, mode = 'collaborative', providerName = '', roundNumber = 1) {
    const modeKey = (mode || 'collaborative').toLowerCase().replace('-', '_');
    const instruction = MODE_INSTRUCTIONS[modeKey] || MODE_INSTRUCTIONS.collaborative;
    // Only the OTHER participants' contributions -- this provider's own
    // prior turns are already sitting right above this message in its own
    // thread, so it doesn't need them repeated back to it. This message is
    // sent into the SAME already-open tab/thread every round (no new tab or
    // conversation is ever created); it should read as a continuation of
    // that thread, not as a fresh context dump that looks like a new chat.
    const formattedHistory = formatPreviousResponses(previousResponses, 20000, providerName);

    if (!formattedHistory) {
      // Nothing new from the other participants since this provider's last
      // turn -- still nudge it to keep going, without restating the topic.
      return `Continue this discussion (Round ${roundNumber}).

${instruction}

Advance the discussion with your own distinct and actionable contribution.`;
    }

    return `[NEW CONTRIBUTIONS FROM THE OTHER PARTICIPANTS SINCE YOUR LAST REPLY]
${formattedHistory}
[CONTINUING AS ${providerName.toUpperCase()} -- ROUND ${roundNumber}]
${instruction}

Instructions:
1. Review the new contributions above from the other participants.
2. Directly address agreements, disagreements, or missing perspectives.
3. Continue this same discussion (do not restart it) with your own distinct and actionable contribution.`;
  }

  /**
   * Build Final Consensus synthesis prompt
   */
  function buildConsensusPrompt(topic, allResponses, mode = 'collaborative') {
    const formattedHistory = formatPreviousResponses(allResponses, 30000);

    return `[ORIGINAL TOPIC]
${topic.trim()}

[COMPLETE DISCUSSION HISTORY]
${formattedHistory}
[FINAL SYNTHESIS TASK]
You are acting as the impartial synthesist for this multi-LLM discussion. Produce a structured, balanced final consensus.

Please structure your response with the following sections:
1. **Core Consensus**: Points where all models agree.
2. **Key Disagreements & Trade-offs**: Divergent opinions or unresolved tensions between the models.
3. **Recommended Approach**: The most robust, practical, and well-justified solution.
4. **Important Caveats**: Risks, constraints, or edge cases to keep in mind.

Be concise, neutral, and actionable.`;
  }

  /**
   * Build prompt for follow-up user messages
   */
  function buildFollowUpPrompt(topic, followUpText, previousResponses, mode = 'collaborative', providerName = '') {
    const modeKey = (mode || 'collaborative').toLowerCase().replace('-', '_');
    const instruction = MODE_INSTRUCTIONS[modeKey] || MODE_INSTRUCTIONS.collaborative;
    const formattedHistory = formatPreviousResponses(previousResponses, 15000);

    return `[ORIGINAL TOPIC]
${topic.trim()}

[PREVIOUS DISCUSSION SUMMARY]
${formattedHistory}
[USER FOLLOW-UP MESSAGE]
${followUpText.trim()}

[INSTRUCTIONS FOR ${providerName.toUpperCase()}]
${instruction}

Answer the user's follow-up directly, taking into account the full context of the discussion so far.`;
  }

  return {
    MODE_INSTRUCTIONS,
    buildInitialPrompt,
    buildReviewPrompt,
    buildConsensusPrompt,
    buildFollowUpPrompt,
    formatPreviousResponses
  };
}));
