// ==========================================================================
// AI Bridge Desktop V1 — Frontend Application Controller
// Event-driven reactive UI connected to ai_bridge.sh via Electron IPC
// ==========================================================================

// Application State
const state = {
  isRunning: false,
  demoMode: false,
  activeRunId: '20260920_170140',
  currentTurn: 1,
  maxTurns: 3,
  startTime: null,
  elapsedSeconds: 0,
  elapsedTimer: null,
  projectPath: 'F:\\AI-Bridge-Test',
  activeBranch: 'master',
  isGitClean: true,
  git: { exists: true, isRepo: true, detached: false, sha: '' },
  currentDecision: 'ready_for_approval',
  browserBridge: {
    paired: false,
    port: 45821,
    activeContext: null,
    detectedTabs: { chatgpt: false, claude: false, gemini: false },
    pairingTimer: null,
    pairingExpiresAt: 0
  },
  agentDurations: { codex: 134, claude: 92, agy: 46, verify: 2 }, // in seconds
  agentStatus: {
    codex: 'completed',
    claude: 'completed',
    agy: 'working'
  },
  metrics: {
    filesChanged: 4,
    linesAdded: 128,
    linesRemoved: 41,
    warnings: 0,
    testsPassed: 12,
    testsTotal: 12,
    blockers: 0,
    majors: 0,
    minors: 1,
    riskLevel: 'Low',
    mainChanges: [
      'Fixed camera keyframe interpolation causing jerky motion',
      'Added regression test for keyframe transitions',
      'Preserved existing architecture and interfaces',
      'Clean git working tree preserved'
    ],
    filesList: [
      { status: 'M', file: 'src/sequencer/camera_interpolator.py', add: 84, del: 31 },
      { status: 'M', file: 'src/sequencer/timeline.py', add: 16, del: 10 },
      { status: 'A', file: 'tests/test_camera_jitter.py', add: 28, del: 0 },
      { status: 'M', file: 'README.md', add: 0, del: 0 }
    ]
  }
};

// Safe bridge access (supports both real Electron IPC and standalone browser testing)
const bridge = window.aiBridge || {
  selectProject: async () => null,
  run: async () => ({ started: true, pid: 1234 }),
  stop: async () => true,
  accept: async () => ({ success: true }),
  rollback: async () => ({ success: true }),
  status: async () => ({ success: true }),
  report: async () => ({ success: true }),
  history: async () => ({ success: true, runs: [] }),
  doctor: async () => ({ success: true, data: { ready: true } }),
  openLog: async () => true,
  getReport: async () => ({ success: true }),
  getHistory: async () => ({ success: true, runs: [] }),
  getDoctor: async () => ({ success: true, data: { ready: true } }),
  getStorage: async () => ({}),
  setStorage: async () => ({}),
  getBranchInfo: async () => ({ branch: 'master', clean: true, exists: true, isRepo: true, detached: false }),
  windowControl: async () => {},
  isMaximized: async () => false,
  onEvent: () => () => {},
  onStderr: () => () => {}
};

// ==========================================================================
// 1. INITIALIZATION & STORAGE
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  initClock();
  setupEventListeners();
  setupKeyboardShortcuts();
  await loadInitialStorage();
  await refreshGitBranch();
  if (!state.demoMode) {
    resetRunPanel(false);
    state.currentDecision = 'idle';
  }
  renderAllState();
  initLLMHub();
});

function initClock() {
  function update() {
    const now = new Date();
    const str = now.toISOString().slice(0, 19).replace('T', ' ');
    const el = document.getElementById('clock-display');
    if (el) el.innerText = str.slice(0, 16);
  }
  update();
  setInterval(update, 1000);
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeA4Modal();
      closeFilesModal();
      closePairingModal();
      closeSavedChatsModal();
      closeConnectedTabsModal();
    }
  });
}

async function loadInitialStorage() {
  try {
    const cfg = await bridge.getStorage();
    if (!cfg || !cfg.models) await initModelPickers(null);
    if (cfg) {
      if (cfg.lastProject) {
        state.projectPath = cfg.lastProject;
        const pInput = document.getElementById('project-input');
        if (pInput) pInput.value = state.projectPath;
      }
      if (cfg.verifyCmd) {
        const vInput = document.getElementById('verify-input');
        if (vInput) vInput.value = cfg.verifyCmd;
      }
      await initModelPickers(cfg.models);
      if (cfg.maxTurns) {
        const tInput = document.getElementById('turns-input');
        if (tInput) tInput.value = cfg.maxTurns;
      }
      if (cfg.autoApprove !== undefined) {
        const chk = document.getElementById('chk-auto-approve');
        if (chk) {
          chk.checked = !!cfg.autoApprove;
          updateAutoApproveLabel();
        }
      }
      if (cfg.demoMode !== undefined) {
        state.demoMode = !!cfg.demoMode;
        updateDemoModeButton();
      }
      if (cfg.timeouts) {
        if (cfg.timeouts.codex) document.getElementById('setting-codex-timeout').value = cfg.timeouts.codex;
        if (cfg.timeouts.claude) document.getElementById('setting-claude-timeout').value = cfg.timeouts.claude;
        if (cfg.timeouts.agy) document.getElementById('setting-agy-timeout').value = cfg.timeouts.agy;
      }
      renderProjectsList(cfg.recentProjects || [state.projectPath]);
    }
  } catch (err) {
    console.warn('Could not load storage:', err);
  }
  await initBrowserBridge();
}

async function refreshGitBranch() {
  try {
    const info = await bridge.getBranchInfo(state.projectPath);
    if (info) {
      state.git = {
        exists: info.exists !== false,
        isRepo: info.isRepo !== false,
        detached: !!info.detached,
        sha: info.sha || ''
      };
      state.activeBranch = info.branch || '';
      state.isGitClean = !!info.clean;
      updateBranchBadges();
    }
  } catch (_) {}
}

function describeGit(info) {
  if (info.exists === false) return { kind: 'missing', label: 'Directory not found' };
  if (info.isRepo === false) return { kind: 'norepo', label: 'Not a git repository' };
  if (info.detached) return { kind: 'detached', label: `DETACHED HEAD${info.sha ? ' · ' + info.sha : ''}` };
  return { kind: 'ok', label: `branch: ${info.branch || 'main'}` };
}

const GIT_WARNINGS = {
  missing: 'This directory was not found on disk. Check the project path or pick it again with Browse.',
  norepo: 'This folder is not a git repository. AI Bridge tracks changes with git, so it cannot run here. Run `git init` in the folder and make an initial commit, or pick a git repository.',
  detached: 'You are not on any branch (detached HEAD). Commits made in this state can be lost unless they are moved to a branch. Switch to a branch first: `git switch <branch>` or `git switch -c new-branch`.'
};

function updateBranchBadges() {
  const g = describeGit({
    exists: state.git.exists, isRepo: state.git.isRepo, detached: state.git.detached,
    sha: state.git.sha, branch: state.activeBranch
  });
  const bBadge = document.getElementById('branch-badge');
  if (bBadge) {
    bBadge.className = `git-chip git-${g.kind}`;
    bBadge.innerText = g.label;
    bBadge.title = GIT_WARNINGS[g.kind] || '';
  }
  const warn = document.getElementById('git-warning');
  if (warn) {
    if (g.kind === 'ok') {
      warn.classList.add('hidden');
    } else {
      warn.className = `git-warning git-${g.kind}`;
      warn.innerHTML = `<span class="gw-ico">${g.kind === 'detached' ? '⚠' : '⛔'}</span><span>${escapeHtml(GIT_WARNINGS[g.kind]).replace(/`([^`]+)`/g, '<code class="git-code">$1</code>')}</span>`;
    }
  }
  const fGit = document.getElementById('foot-git');
  if (fGit) {
    let color = state.isGitClean ? 'bg-emerald-400' : 'bg-amber-400';
    let text = state.isGitClean ? 'Git: Clean' : 'Git: Dirty';
    if (g.kind === 'norepo' || g.kind === 'missing') { color = 'bg-rose-400'; text = 'Git: —'; }
    else if (g.kind === 'detached') { color = 'bg-amber-400'; text = 'Git: Detached'; }
    fGit.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${color}"></span> ${text}`;
  }
}

// ==========================================================================
// 2. WINDOW CONTROLS
// ==========================================================================

function windowMinimize() {
  bridge.windowControl('minimize');
}

function windowMaximize() {
  bridge.windowControl('maximize');
}

function windowClose() {
  bridge.windowControl('close');
}

// ==========================================================================
// 3. TAB NAVIGATION
// ==========================================================================

const TABS = ['run', 'projects', 'history', 'settings', 'llm-hub'];

function switchTab(tabId) {
  TABS.forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    const nav = document.getElementById(`nav-${t}`);
    if (el) el.classList.add('hidden');
    if (nav) {
      nav.className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg font-medium text-left transition-all text-slate-400 hover:text-slate-200 hover:bg-slate-800/40";
    }
  });

  const targetTab = document.getElementById(`tab-${tabId}`);
  const targetNav = document.getElementById(`nav-${tabId}`);
  if (targetTab) targetTab.classList.remove('hidden');
  if (targetNav) {
    targetNav.className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg font-medium text-left transition-all bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-sm shadow-cyan-500/10";
  }

  if (tabId === 'history') loadHistory();
  if (tabId === 'settings') runDoctorCheck();
}

function scrollToLLMSection(sectionId) {
  setTimeout(() => {
    const sec = document.getElementById(sectionId);
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

// ==========================================================================
// 4. NDJSON BACKEND STREAM LISTENER & ERROR HANDLING
// ==========================================================================

function setupEventListeners() {
  bridge.onEvent((event) => {
    handleBackendEvent(event);
  });

  bridge.onStderr((text) => {
    if (text && text.trim()) {
      console.warn('CLI Diagnostic Stderr:', text);
    }
  });
}

function handleBackendEvent(ev) {
  if (!ev || !ev.event) return;

  switch (ev.event) {
    case 'run_started':
      state.activeRunId = ev.run_id || Date.now().toString();
      state.currentTurn = 1;
      state.maxTurns = ev.max_turns || ev.turns || 3;
      state.startTime = Date.now();
      resetRunPanel(true);
      startElapsedTimer();
      setRunUiState(true);
      appendLog('SYSTEM', `AI Bridge started. Base: ${ev.base_head || 'HEAD'} | Branch: ${ev.branch || 'ai-bridge'}`, 'text-cyan-400');
      setDecisionState('running');
      resetPipelineCards();
      showToast('info', 'AI Bridge run started.');
      break;

    case 'turn_started':
      state.currentTurn = ev.turn || 1;
      updateTurnDisplay();
      appendLog('SYSTEM', `Turn ${state.currentTurn}/${state.maxTurns} started...`, 'text-cyan-400');
      break;

    case 'agent_started':
      setAgentStatus(ev.agent, 'working', 'Working...');
      appendLog(ev.agent.toUpperCase(), `Agent is executing the task...`, getAgentColor(ev.agent));
      break;

    case 'agent_tool':
      if (ev.tool) {
        appendLog(ev.agent ? ev.agent.toUpperCase() : 'TOOL', `Tool call: ${ev.tool}`, 'text-slate-400');
      }
      break;

    case 'agent_finished':
      const durSec = ev.duration_sec ?? ev.duration_seconds ?? 0;
      const durationStr = formatDuration(durSec);
      setAgentStatus(ev.agent, 'completed', `Completed (${durationStr})`, durSec);
      appendLog(ev.agent.toUpperCase(), `✓ Agent step completed. (rc=${ev.exit_code || 0}, duration=${durationStr})`, 'text-emerald-400');
      break;

    case 'agent_failed':
      setAgentStatus(ev.agent, 'failed', ev.error ? `Error: ${String(ev.error).slice(0, 90)}` : 'An error occurred');
      appendLog(ev.agent.toUpperCase(), `✗ Agent step failed${ev.error ? ': ' + ev.error : ''}`, 'text-rose-400');
      showToast('error', `${ev.agent.toUpperCase()} failed.`);
      break;

    case 'agent_skipped':
      setAgentStatus(ev.agent, 'skipped', 'Skipped');
      appendLog(ev.agent.toUpperCase(), `Agent skipped.`, 'text-slate-500');
      break;

    case 'review_finished':
      const verdict = ev.verdict || 'APPROVE';
      const blockers = ev.blocker ?? ev.blocking_issues ?? 0;
      const majors = ev.major ?? ev.major_issues ?? 0;
      const minors = ev.minor ?? ev.minor_issues ?? 0;
      state.metrics.blockers = blockers;
      state.metrics.majors = majors;
      state.metrics.minors = minors;
      updateReviewFindingsDisplay();
      { const dc = document.getElementById('dec-claude'); if (dc) dc.innerText = verdict; }
      appendLog('CLAUDE', `Review verdict: ${verdict} (Blocker: ${blockers}, Major: ${majors}, Minor: ${minors})`, verdict === 'APPROVE' ? 'text-emerald-400' : 'text-amber-400');
      break;

    case 'verification_started':
      setVerificationFooter('Running...', 'bg-cyan-400');
      appendLog('ANTIGRAVITY', `Running independent verification command: ${ev.command || 'verify'}`, 'text-cyan-400');
      break;

    case 'verification_finished':
      const passed = ev.passed === true || ev.status === 'passed';
      setVerificationFooter(passed ? 'Passed' : 'Failed', passed ? 'bg-emerald-400' : 'bg-rose-400');
      setTestResult(passed);
      appendLog('TEST', `Verification ${passed ? 'PASSED ✓' : 'FAILED ✗'} (rc=${ev.exit_code || 0})`, passed ? 'text-emerald-400' : 'text-rose-400');
      break;

    case 'repo_stats':
      {
        const f = ev.files_changed ?? ev.changed_files;
        if (f !== undefined) state.metrics.filesChanged = f;
        if (ev.lines_added !== undefined) state.metrics.linesAdded = ev.lines_added;
        if (ev.lines_removed !== undefined) state.metrics.linesRemoved = ev.lines_removed;
      }
      {
        const ul = document.getElementById('main-changes-list');
        if (ul) ul.innerHTML = `<li>${state.metrics.filesChanged} files changed (+${state.metrics.linesAdded} / -${state.metrics.linesRemoved})</li>`;
      }
      updateMetricsCards();
      break;

    case 'warning':
      showToast('warning', ev.message || 'Warning received');
      appendLog('WARN', ev.message || 'Warning', 'text-amber-400');
      break;

    case 'error':
      showToast('error', ev.message || 'An error occurred');
      appendLog('ERROR', ev.message || 'Error', 'text-rose-400');
      break;

    case 'turn_finished':
      appendLog('SYSTEM', `Turn ${ev.turn || state.currentTurn} completed.`, 'text-slate-400');
      break;

    case 'decision':
      state.currentDecision = ev.decision || ev.status || 'ready_for_approval';
      renderDecisionBanner(state.currentDecision, ev.reason);
      appendLog('DECISION', `Son Karar: ${state.currentDecision.toUpperCase()}`, getDecisionColor(state.currentDecision));
      break;

    case 'run_finished':
      stopElapsedTimer();
      setRunUiState(false);
      state.currentDecision = ev.status || ev.final_decision || state.currentDecision;
      renderDecisionBanner(state.currentDecision);
      appendLog('SYSTEM', `Run finished. Status: ${state.currentDecision}. Duration: ${formatDuration(ev.duration_sec ?? ev.total_duration_seconds ?? state.elapsedSeconds)}`, 'text-cyan-300');
      updateDecisionDetails(ev.duration_sec ?? state.elapsedSeconds);
      if (state.currentDecision === 'ready_for_approval') {
        showToast('success', 'All agents finished. Changes are awaiting your approval!');
      } else if (state.currentDecision === 'blocked') {
        showToast('error', 'Run stopped by the security guard.');
      }
      loadHistory();
      break;

    case 'interrupted':
      stopElapsedTimer();
      setRunUiState(false);
      setDecisionState('interrupted');
      appendLog('INTERRUPT', 'Stopped by user (SIGINT -> exit 130).', 'text-rose-400');
      showToast('info', 'Run stopped (SIGINT).');
      break;

    case 'process_exit':
      stopElapsedTimer();
      setRunUiState(false);
      if (ev.exit_code === 130) {
        setDecisionState('interrupted');
        showToast('info', 'Run stopped (exit 130).');
      } else if (ev.exit_code === 1) {
        setDecisionState('failed');
        showToast('error', 'Backend exited with an error (exit 1). Check the logs.');
      } else if (ev.exit_code === 2) {
        setDecisionState('max_turns');
        showToast('warning', 'Tur limiti doldu (exit 2: max_turns).');
      }
      break;

    case 'preflight_failed':
      stopElapsedTimer();
      setRunUiState(false);
      setDecisionState('failed');
      renderDecisionBanner('failed', ev.message || 'Preflight check failed.');
      appendLog('PREFLIGHT', ev.message || 'Preflight check failed.', 'text-rose-400');
      showToast('error', ev.message || 'Preflight check failed.');
      break;

    case 'raw_log':
      if (ev.message) {
        appendLog('LOG', ev.message, 'text-slate-400');
      }
      break;
  }
}

// ==========================================================================
// 5. RUN / STOP CONTROLS & DEMO SIMULATION
// ==========================================================================

async function toggleRun() {
  if (state.isRunning) {
    if (state.demoMode) {
      handleBackendEvent({ event: 'interrupted' });
    } else {
      appendLog('SYSTEM', 'Sending stop signal (SIGINT)...', 'text-amber-400');
      const stopped = await bridge.stop();
      if (!stopped) {
        showToast('warning', 'No active process to stop.');
      }
    }
  } else {
    if (state.demoMode) {
      runDemoSimulation();
    } else {
      await startRealRun();
    }
  }
}

const MODEL_AGENTS = ['codex', 'claude', 'agy'];
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' };

// Fallback used when the desktop bridge is unavailable (browser preview) or
// the local CLI caches cannot be read.
const FALLBACK_CATALOG = {
  codex: {
    defaultModel: 'gpt-6-astra', defaultEffort: 'medium',
    models: [
      { slug: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
      { slug: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
      { slug: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
      { slug: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
      { slug: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }
    ]
  },
  claude: {
    defaultModel: '', defaultEffort: '',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    models: [{ slug: 'opus', label: 'Opus' }, { slug: 'sonnet', label: 'Sonnet' }, { slug: 'haiku', label: 'Haiku' }]
  },
  agy: {
    defaultModel: '', defaultEffort: '',
    efforts: ['low', 'medium', 'high'],
    models: [
      { slug: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { slug: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
      { slug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { slug: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6' }
    ]
  }
};

let modelCatalog = null;

function effortLabel(e) { return EFFORT_LABELS[e] || e; }

function fillModelSelect(agent, selected) {
  const sel = document.getElementById(`model-${agent}`);
  if (!sel) return;
  const cat = modelCatalog[agent];
  const dm = cat.defaultModel ? cat.models.find(m => m.slug === cat.defaultModel) : null;
  const defLabel = cat.defaultModel ? `Default · ${dm ? dm.label : cat.defaultModel}` : 'Default';
  sel.innerHTML = `<option value="">${escapeHtml(defLabel)}</option>` +
    cat.models.map(m => `<option value="${escapeHtml(m.slug)}">${escapeHtml(m.label)}</option>`).join('') +
    '<option value="__custom__">Custom model…</option>';
  sel.title = cat.defaultModel ? `Default model: ${dm ? dm.label : cat.defaultModel}` : '';
  sel.value = selected && [...sel.options].some(o => o.value === selected) ? selected : '';
}

function currentModelSlug(agent) {
  const field = document.getElementById(`field-${agent}`);
  if (field && field.classList.contains('is-custom')) {
    const inp = document.getElementById(`model-${agent}-custom`);
    return inp ? inp.value.trim() : '';
  }
  const sel = document.getElementById(`model-${agent}`);
  return sel && sel.value !== '__custom__' ? sel.value : '';
}

function fillEffortSelect(agent, selected) {
  const sel = document.getElementById(`effort-${agent}`);
  if (!sel) return;
  const cat = modelCatalog[agent];
  const slug = currentModelSlug(agent) || cat.defaultModel;
  const m = cat.models.find(x => x.slug === slug);
  const efforts = (m && m.efforts && m.efforts.length) ? m.efforts : (cat.efforts || ['low', 'medium', 'high', 'xhigh', 'max']);
  const defEffort = (currentModelSlug(agent) ? (m && m.defaultEffort) : '') || cat.defaultEffort;
  sel.title = defEffort ? `Default effort: ${effortLabel(defEffort)}` : '';
  sel.innerHTML = `<option value="">${defEffort ? 'Default (' + effortLabel(defEffort) + ')' : 'Default'}</option>` +
    efforts.map(e => `<option value="${e}">${effortLabel(e)}</option>`).join('');
  sel.value = selected && efforts.includes(selected) ? selected : '';
}

function onModelChange(agent, fromCustomInput) {
  const field = document.getElementById(`field-${agent}`);
  const sel = document.getElementById(`model-${agent}`);
  if (!fromCustomInput && sel && sel.value === '__custom__') {
    field.classList.add('is-custom');
    const inp = document.getElementById(`model-${agent}-custom`);
    if (inp) { inp.value = ''; inp.focus(); }
  }
  const eff = document.getElementById(`effort-${agent}`);
  fillEffortSelect(agent, eff ? eff.value : '');
  saveModelSettings();
}

function exitCustomModel(agent) {
  const field = document.getElementById(`field-${agent}`);
  const sel = document.getElementById(`model-${agent}`);
  if (field) field.classList.remove('is-custom');
  if (sel) sel.value = '';
  onModelChange(agent);
}

function getModelSettings() {
  const out = {};
  for (const a of MODEL_AGENTS) {
    const e = document.getElementById(`effort-${a}`);
    out[a] = { model: currentModelSlug(a), effort: e ? e.value : '' };
  }
  return out;
}

function saveModelSettings() {
  bridge.setStorage({ models: getModelSettings() });
  refreshModelChips();
}

async function initModelPickers(saved) {
  let cat = null;
  try {
    cat = bridge.getModelCatalog ? await bridge.getModelCatalog() : null;
  } catch (_) { cat = null; }
  modelCatalog = {
    codex: (cat && cat.codex && cat.codex.models && cat.codex.models.length) ? cat.codex : FALLBACK_CATALOG.codex,
    claude: (cat && cat.claude) || FALLBACK_CATALOG.claude,
    agy: (cat && cat.agy) || FALLBACK_CATALOG.agy
  };
  for (const a of MODEL_AGENTS) {
    const cfg = (saved && saved[a]) || {};
    const known = modelCatalog[a].models.some(m => m.slug === cfg.model);
    fillModelSelect(a, known ? cfg.model : '');
    if (cfg.model && !known) {
      const field = document.getElementById(`field-${a}`);
      const inp = document.getElementById(`model-${a}-custom`);
      if (field && inp) { field.classList.add('is-custom'); inp.value = cfg.model; }
    }
    fillEffortSelect(a, cfg.effort || '');
  }
  refreshModelChips();
}

async function startRealRun() {
  const projectPath = document.getElementById('project-input').value.trim();
  const task = document.getElementById('task-text').value.trim();
  const turns = parseInt(document.getElementById('turns-input').value, 10) || 3;
  const verifyCmd = document.getElementById('verify-input').value.trim();
  const autoApprove = document.getElementById('chk-auto-approve').checked;

  const agents = [];
  if (document.getElementById('chk-codex').checked) agents.push('codex');
  if (document.getElementById('chk-claude').checked) agents.push('claude');
  if (document.getElementById('chk-agy').checked) agents.push('agy');

  if (!projectPath) {
    showToast('error', 'Please enter or pick a project directory.');
    return;
  }
  if (!task) {
    showToast('error', 'Please describe the task.');
    return;
  }
  if (agents.length === 0) {
    showToast('error', 'Please select at least one agent.');
    return;
  }

  // Check if project exists
  const info = await bridge.getBranchInfo(projectPath);
  if (info && info.exists === false) {
    showToast('error', 'The target project directory was not found on disk!');
    return;
  }
  if (info && info.isRepo === false) {
    showToast('error', 'The selected folder is not a git repository. Run `git init` and make an initial commit first.');
    return;
  }
  if (info && info.detached) {
    showToast('warning', 'Detached HEAD: changes will not be attached to a branch.');
  }
  if (info && !info.clean) {
    showToast('warning', 'Warning: the working tree is not clean (dirty working tree).');
  }

  const res = await bridge.run({
    models: getModelSettings(),
    projectPath,
    task,
    turns,
    agents: agents.join(','),
    verifyCmd,
    autoApprove,
    agyTransport: getSelectedTransport()
  });

  if (res && res.error) {
    showToast('error', 'Run error: ' + res.error);
  }
}

// Realistic interactive demo simulation when Demo mode is ON
let demoTimeouts = [];
function runDemoSimulation() {
  clearDemoTimeouts();
  handleBackendEvent({
    event: 'run_started',
    run_id: 'demo_' + Date.now().toString().slice(-6),
    base_head: 'ac9f72a',
    branch: 'ai-bridge/demo_active',
    turns: 3
  });

  demoTimeouts.push(setTimeout(() => {
    handleBackendEvent({ event: 'turn_started', turn: 1 });
    handleBackendEvent({ event: 'agent_started', agent: 'codex' });
  }, 600));

  demoTimeouts.push(setTimeout(() => {
    handleBackendEvent({ event: 'agent_tool', agent: 'codex', tool: 'view_file src/sequencer/camera_interpolator.py' });
  }, 1600));

  demoTimeouts.push(setTimeout(() => {
    handleBackendEvent({
      event: 'agent_finished',
      agent: 'codex',
      exit_code: 0,
      duration_seconds: 134
    });
    handleBackendEvent({ event: 'agent_started', agent: 'claude' });
  }, 3000));

  demoTimeouts.push(setTimeout(() => {
    handleBackendEvent({
      event: 'review_finished',
      verdict: 'APPROVE',
      blocking_issues: 0,
      major_issues: 0,
      minor_issues: 1
    });
    handleBackendEvent({
      event: 'agent_finished',
      agent: 'claude',
      exit_code: 0,
      duration_seconds: 92
    });
    handleBackendEvent({ event: 'agent_started', agent: 'antigravity' });
    handleBackendEvent({ event: 'verification_started', command: 'pytest -q' });
  }, 4500));

  demoTimeouts.push(setTimeout(() => {
    handleBackendEvent({
      event: 'verification_finished',
      passed: true,
      exit_code: 0
    });
    handleBackendEvent({
      event: 'agent_finished',
      agent: 'antigravity',
      exit_code: 0,
      duration_seconds: 46
    });
    handleBackendEvent({
      event: 'decision',
      decision: 'ready_for_approval',
      reason: 'All agents completed successfully. Verification passed.'
    });
    handleBackendEvent({
      event: 'run_finished',
      final_decision: 'ready_for_approval',
      total_duration_seconds: 272
    });
  }, 6000));
}

function clearDemoTimeouts() {
  demoTimeouts.forEach(t => clearTimeout(t));
  demoTimeouts = [];
}

function setRunUiState(running) {
  state.isRunning = running;
  const btn = document.getElementById('btn-run');
  const btnText = document.getElementById('btn-run-text');
  const btnIcon = document.getElementById('btn-run-icon');
  const topBadge = document.getElementById('top-ready-badge');
  const hair = document.getElementById('run-progress');
  if (hair) hair.classList.toggle('active', running);

  if (running) {
    btn.className = "run-btn is-running";
    btnText.innerText = "Stop (Kill)";
    btnIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" fill="currentColor"/>';

    topBadge.className = "status-pill running";
    topBadge.innerHTML = '<i></i><span>Running...</span>';
  } else {
    btn.className = "run-btn";
    btnText.innerText = "Run Bridge";
    btnIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';

    topBadge.className = "status-pill ready";
    topBadge.innerHTML = '<i></i><span>Ready</span>';
  }
}

// ==========================================================================
// 6. PIPELINE & AGENT CARD CONTROLLER
// ==========================================================================

function enabledAgents() {
  return MODEL_AGENTS.filter(a => { const c = document.getElementById(`chk-${a}`); return !c || c.checked; });
}

function onAgentToggle() {
  refreshModelChips();
  refreshPipelineProgress();
}

function refreshPipelineProgress() {
  const on = enabledAgents();
  const done = on.filter(a => ['completed', 'skipped'].includes(state.agentStatus[a])).length;
  const bar = document.getElementById('pipe-progress-bar');
  const txt = document.getElementById('pipe-progress-text');
  if (bar) bar.style.width = on.length ? `${Math.round((done / on.length) * 100)}%` : '0%';
  if (txt) txt.innerText = `${done}/${on.length}`;
}

function modelChipText(agent) {
  if (!modelCatalog) return '';
  const cat = modelCatalog[agent];
  const slug = currentModelSlug(agent);
  const eSel = document.getElementById(`effort-${agent}`);
  const effort = eSel ? eSel.value : '';
  let model = slug ? ((cat.models.find(m => m.slug === slug) || {}).label || slug) : (cat.defaultModel ? ((cat.models.find(m => m.slug === cat.defaultModel) || {}).label || cat.defaultModel) : 'default model');
  const eff = effort || (slug ? '' : cat.defaultEffort);
  return eff ? `${model} · ${effortLabel(eff)}` : model;
}

function refreshModelChips() {
  for (const a of MODEL_AGENTS) {
    const el = document.getElementById(`pipe-${a}-model`);
    const c = document.getElementById(`chk-${a}`);
    if (!el) continue;
    el.innerText = (c && !c.checked) ? 'off' : modelChipText(a);
  }
}

function setPipelineTurn() {
  const c = document.getElementById('pipe-turn-chip');
  if (c) c.innerHTML = `Tur <b>${state.currentTurn}/${state.maxTurns}</b>`;
}

function setTestResult(passed) {
  const bar = document.getElementById('test-progress-bar');
  const text = document.getElementById('test-progress-text');
  if (bar) {
    bar.style.width = '100%';
    bar.className = `h-full ${passed ? 'bg-emerald-400' : 'bg-rose-400'} rounded-full`;
  }
  if (text) {
    text.innerText = passed ? 'Passed' : 'Failed';
    text.className = `${passed ? 'text-emerald-400' : 'text-rose-400'} font-mono font-bold text-[11px]`;
  }
  const dv = document.getElementById('dec-verify');
  if (dv) {
    dv.innerText = passed ? 'PASSED' : 'FAILED';
    dv.className = `${passed ? 'text-emerald-400' : 'text-rose-400'} font-bold font-mono`;
  }
}

function updateDecisionDetails(durationSec) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  set('dec-files', state.metrics.filesChanged);
  set('dec-warnings', state.metrics.warnings);
  set('dec-duration', formatDuration(durationSec || 0));
  const dts = document.getElementById('decision-timestamp');
  if (dts) dts.innerText = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const ag = state.agentStatus.agy;
  set('dec-agy', ag === 'completed' ? 'DONE' : String(ag || '-').toUpperCase());
  set('dec-blocked', state.currentDecision === 'blocked' ? 'YES' : 'NO');
  set('total-duration-text', formatDuration(durationSec || 0));
  const rl = document.getElementById('risk-level-badge');
  if (rl) {
    const mt = state.metrics;
    const level = mt.blockers > 0 ? 'High' : (mt.majors > 0 ? 'Medium' : 'Low');
    rl.className = `risk-pill risk-${level.toLowerCase()}`;
    rl.innerText = `${level === 'Low' ? '✓' : '!'} ${level}`;
  }
}

// Puts the Run page into a clean idle state (no leftover demo/mock data).
function resetRunPanel(keepLog) {
  const m = state.metrics;
  m.filesChanged = 0; m.linesAdded = 0; m.linesRemoved = 0; m.warnings = 0;
  m.blockers = 0; m.majors = 0; m.minors = 0;
  m.testsPassed = 0; m.testsTotal = 0;
  m.mainChanges = []; m.filesList = [];
  state.elapsedSeconds = 0;
  if (!keepLog) clearLog();
  resetPipelineCards();
  ['codex', 'claude', 'agy'].forEach(a => {
    const t = document.getElementById(`pipe-${a}-time`);
    if (t) { t.innerHTML = ''; t.classList.add('hidden'); }
  });
  updateMetricsCards();
  updateReviewFindingsDisplay();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  const bar = document.getElementById('test-progress-bar');
  const text = document.getElementById('test-progress-text');
  if (bar) { bar.style.width = '0%'; bar.className = 'h-full bg-slate-600 rounded-full'; }
  if (text) { text.innerText = '-'; text.className = 'text-slate-400 font-mono font-bold text-[11px]'; }
  const dv = document.getElementById('dec-verify');
  if (dv) { dv.innerText = '-'; dv.className = 'text-slate-400 font-bold font-mono'; }
  set('dec-claude', '-'); set('dec-agy', '-'); set('dec-blocked', '-');
  set('dec-duration', '-'); set('dec-files', '0'); set('decision-timestamp', '');
  set('total-duration-text', '-');
  ['codex', 'claude', 'agy'].forEach(k => { const p = document.getElementById(`pill-${k}`); if (p) p.classList.add('hidden'); });
  const ul = document.getElementById('main-changes-list');
  if (ul) ul.innerHTML = '<li>No runs yet.</li>';
  const rl = document.getElementById('risk-level-badge');
  if (rl) { rl.className = 'risk-pill risk-none'; rl.innerText = '-'; }
  const ec = document.getElementById('pipe-elapsed-chip');
  if (ec) ec.innerHTML = '⏱ <b>0m 00s</b>';
}

function resetPipelineCards() {
  ['codex', 'claude', 'agy'].forEach(a => {
    setAgentStatus(a, 'waiting', 'Waiting in queue...');
  });
}

function setAgentStatus(agent, status, desc, durationSeconds) {
  const normAgent = agent === 'antigravity' ? 'agy' : agent;
  state.agentStatus[normAgent] = status;
  if (durationSeconds !== undefined) {
    state.agentDurations[normAgent] = durationSeconds;
  }

  const card = document.getElementById(`pipe-card-${normAgent}`);
  const badge = document.getElementById(`pipe-${normAgent}-badge`);
  const descEl = document.getElementById(`pipe-${normAgent}-desc`);
  const timeEl = document.getElementById(`pipe-${normAgent}-time`);

  if (!card) return;

  card.className = `pipeline-card ${status}`;

  if (desc && descEl) descEl.innerText = desc;
  if (durationSeconds !== undefined && status === 'completed') {
    const pill = document.getElementById(`pill-${normAgent}`);
    if (pill) {
      const nm = { codex: 'Codex', claude: 'Claude', agy: 'AGY' }[normAgent];
      pill.innerText = `${nm} ${formatDuration(durationSeconds)}`;
      pill.classList.remove('hidden');
    }
  }
  if (timeEl && durationSeconds !== undefined) {
    timeEl.classList.remove('hidden');
    timeEl.innerHTML = `<svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${formatDuration(durationSeconds)}`;
  }

  refreshPipelineProgress();

  if (badge) {
    const labels = { working: 'Working', completed: 'Completed', failed: 'Failed', skipped: 'Skipped', waiting: 'Waiting' };
    const key = labels[status] ? status : 'waiting';
    badge.className = `st-badge st-${key}`;
    badge.innerHTML = (key === 'working' || key === 'completed' || key === 'failed')
      ? `<span class="st-dot"></span>${labels[key]}` : labels[key];
  }
}

// ==========================================================================
// 7. DECISION BANNER CONTROLLER (All 10 States)
// ==========================================================================

function setDecisionState(status) {
  state.currentDecision = status;
  renderDecisionBanner(status);
}

function renderDecisionBanner(status, customDesc) {
  const banner = document.getElementById('decision-banner');
  const title = document.getElementById('decision-title');
  const desc = document.getElementById('decision-desc');
  const btnAccept = document.getElementById('btn-accept');
  const btnRollback = document.getElementById('btn-rollback');

  if (!banner) return;

  switch (status) {
    case 'ready_for_approval':
      banner.className = "p-3.5 rounded-lg bg-emerald-950/50 border border-emerald-500/50 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "✓";
      title.className = "text-xs font-bold text-emerald-300 uppercase tracking-wider";
      title.innerText = "READY FOR APPROVAL";
      desc.innerText = customDesc || "All agents completed successfully. Changes are ready for your review.";
      btnAccept.disabled = false;
      btnAccept.className = "py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg shadow-md shadow-emerald-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'needs_another_turn':
      banner.className = "p-3.5 rounded-lg bg-amber-950/40 border border-amber-500/40 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "↻";
      title.className = "text-xs font-bold text-amber-300 uppercase tracking-wider";
      title.innerText = "NEEDS ANOTHER TURN";
      desc.innerText = customDesc || "Turn finished but further fixes are needed. Moving on to the next turn.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'accepted':
      banner.className = "p-3.5 rounded-lg bg-cyan-950/50 border border-cyan-500/50 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "✓";
      title.className = "text-xs font-bold text-cyan-300 uppercase tracking-wider";
      title.innerText = "ACCEPTED & MERGED";
      desc.innerText = customDesc || "Changes were accepted and committed to the original branch.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = true;
      btnRollback.className = "py-2.5 bg-slate-900 text-slate-600 font-bold text-xs rounded-lg cursor-not-allowed";
      break;

    case 'rolled_back':
      banner.className = "p-3.5 rounded-lg bg-slate-900 border border-slate-700 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "↺";
      title.className = "text-xs font-bold text-rose-300 uppercase tracking-wider";
      title.innerText = "ROLLED BACK";
      desc.innerText = customDesc || "Changes were reset and the isolated branch was cleaned up.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = true;
      btnRollback.className = "py-2.5 bg-slate-900 text-slate-600 font-bold text-xs rounded-lg cursor-not-allowed";
      break;

    case 'blocked':
      banner.className = "p-3.5 rounded-lg bg-rose-950/60 border border-rose-600/60 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "⊘";
      title.className = "text-xs font-bold text-rose-300 uppercase tracking-wider";
      title.innerText = "BLOCKED BY SECURITY GUARD";
      desc.innerText = customDesc || "An unauthorized or forbidden git action was detected and blocked.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'needs_manual_verification':
      banner.className = "p-3.5 rounded-lg bg-amber-950/50 border border-amber-500/50 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "⚠";
      title.className = "text-xs font-bold text-amber-300 uppercase tracking-wider";
      title.innerText = "NEEDS MANUAL VERIFICATION";
      desc.innerText = customDesc || "Agents finished but the tests did not pass. Manual review is recommended.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'max_turns':
      banner.className = "p-3.5 rounded-lg bg-amber-950/50 border border-amber-600/50 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "⏱";
      title.className = "text-xs font-bold text-amber-300 uppercase tracking-wider";
      title.innerText = "MAX TURNS REACHED";
      desc.innerText = customDesc || "The maximum turn limit was reached without passing verification.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'failed':
      banner.className = "p-3.5 rounded-lg bg-rose-950/60 border border-rose-600/60 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "✕";
      title.className = "text-xs font-bold text-rose-300 uppercase tracking-wider";
      title.innerText = "EXECUTION FAILED";
      desc.innerText = customDesc || "A critical error occurred during agent or tool execution.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'interrupted':
      banner.className = "p-3.5 rounded-lg bg-slate-900 border border-amber-600/50 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "■";
      title.className = "text-xs font-bold text-amber-300 uppercase tracking-wider";
      title.innerText = "INTERRUPTED BY USER";
      desc.innerText = customDesc || "The run was stopped by the user (SIGINT).";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = false;
      btnRollback.className = "py-2.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer";
      break;

    case 'running':
      banner.className = "p-3.5 rounded-lg bg-cyan-950/40 border border-cyan-600/40 flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = '<div class="w-4 h-4 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin"></div>';
      title.className = "text-xs font-bold text-cyan-300 uppercase tracking-wider";
      title.innerText = "PIPELINE RUNNING";
      desc.innerText = "Agents are running and changes are being verified...";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = true;
      btnRollback.className = "py-2.5 bg-slate-900 text-slate-600 font-bold text-xs rounded-lg cursor-not-allowed";
      break;

    default:
      banner.className = "p-3.5 rounded-lg bg-[#070e1c] border border-[#16243d] flex items-center gap-3";
      banner.children[0].className = "w-9 h-9 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center font-bold text-lg shrink-0";
      banner.children[0].innerHTML = "●";
      title.className = "text-xs font-bold text-slate-300 uppercase tracking-wider";
      title.innerText = "AWAITING EXECUTION";
      desc.innerText = "Click 'Run Bridge' to start.";
      btnAccept.disabled = true;
      btnAccept.className = "py-2.5 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed";
      btnRollback.disabled = true;
      btnRollback.className = "py-2.5 bg-slate-900 text-slate-600 font-bold text-xs rounded-lg cursor-not-allowed";
  }
}

// ==========================================================================
// 8. ACCEPT & ROLLBACK ACTIONS
// ==========================================================================

async function handleAccept() {
  if (state.currentDecision !== 'ready_for_approval') {
    showToast('warning', "Only runs in the 'ready_for_approval' state can be accepted.");
    return;
  }

  appendLog('ACCEPT', 'Calling ai_bridge.sh accept...', 'text-cyan-400');
  
  if (state.demoMode) {
    setDecisionState('accepted');
    appendLog('ACCEPT', 'SUCCESS: Changes were committed and merged.', 'text-emerald-400');
    showToast('success', '✓ Changes accepted and merged into the original branch!');
    return;
  }

  const res = await bridge.accept(state.projectPath);
  if (res && res.success) {
    setDecisionState('accepted');
    appendLog('ACCEPT', 'SUCCESS: Changes were committed and merged.', 'text-emerald-400');
    showToast('success', '✓ Changes accepted and merged into the original branch!');
  } else {
    appendLog('ERROR', `Accept failed: ${res ? res.error : 'Error'}`, 'text-rose-400');
    showToast('error', 'Error: Accept could not be completed (state rule or fingerprint mismatch).');
  }
}

async function handleRollback() {
  if (!confirm("All changes will be reset and the isolated working branch will be deleted. Are you sure?")) {
    return;
  }

  appendLog('ROLLBACK', 'Calling ai_bridge.sh rollback...', 'text-rose-400');

  if (state.demoMode) {
    setDecisionState('rolled_back');
    appendLog('ROLLBACK', 'Repository reset to the original BASE_HEAD.', 'text-rose-400');
    showToast('info', '↺ Changes rolled back and the repository cleaned.');
    return;
  }

  const res = await bridge.rollback(state.projectPath);
  if (res && res.success) {
    setDecisionState('rolled_back');
    appendLog('ROLLBACK', 'Repository reset to the original BASE_HEAD.', 'text-rose-400');
    showToast('info', '↺ Changes rolled back and the repository cleaned.');
  } else {
    appendLog('ERROR', `Rollback failed: ${res ? res.error : 'Error'}`, 'text-rose-400');
    showToast('error', 'Error: Rollback could not be completed.');
  }
}

// ==========================================================================
// 9. LOG CONSOLE HELPERS
// ==========================================================================

function appendLog(tag, msg, colorClass = 'text-slate-300') {
  const consoleEl = document.getElementById('log-console');
  if (!consoleEl) return;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];

  const line = document.createElement('div');
  line.className = 'terminal-line';
  line.innerHTML = `
    <span class="terminal-time">[${timeStr}]</span>
    <span class="terminal-tag ${colorClass}">${tag}</span>
    <span class="terminal-msg">${escapeHtml(msg)}</span>
  `;

  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearLog() {
  const consoleEl = document.getElementById('log-console');
  if (consoleEl) consoleEl.innerHTML = '';
}

async function openLogInEditor() {
  const res = await bridge.openLog(state.projectPath);
  if (!res) {
    showToast('info', `Log file has not been created yet: ${state.projectPath}/.git/ai_bridge/bridge_latest.log`);
  }
}

// ==========================================================================
// 10. MODAL: FULL DECISION A4 & FILES
// ==========================================================================

function openA4Modal() {
  const modal = document.getElementById('modal-a4');
  if (!modal) return;

  document.getElementById('a4-status').innerText = `DURUM: ${state.currentDecision.toUpperCase()}`;
  document.getElementById('a4-runid').innerText = state.activeRunId;
  document.getElementById('a4-branch').innerText = state.activeBranch;
  document.getElementById('a4-footer-status').innerText = state.currentDecision;

  const taskText = document.getElementById('task-text').value;
  if (taskText) document.getElementById('a4-task-desc').innerText = taskText;

  // Durations
  document.getElementById('a4-dur-total').innerText = formatDuration(state.elapsedSeconds || 272);
  document.getElementById('a4-dur-codex').innerText = formatDuration(state.agentDurations.codex || 134);
  document.getElementById('a4-dur-claude').innerText = formatDuration(state.agentDurations.claude || 92);
  document.getElementById('a4-dur-agy').innerText = formatDuration(state.agentDurations.agy || 46);
  document.getElementById('a4-dur-verify').innerText = '2.4s';

  modal.classList.remove('hidden');
}

function closeA4Modal() {
  const modal = document.getElementById('modal-a4');
  if (modal) modal.classList.add('hidden');
}

function showFilesModal() {
  const modal = document.getElementById('modal-files');
  const list = document.getElementById('files-modal-list');
  if (!modal || !list) return;

  list.innerHTML = state.metrics.filesList.map(f => `
    <div class="p-2.5 rounded bg-[#060c18] border border-[#182a4a] flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="font-bold ${f.status === 'A' ? 'text-cyan-400' : 'text-emerald-400'}">[${f.status}]</span>
        <span class="text-slate-300 font-mono">${f.file}</span>
      </div>
      <div class="font-mono text-xs">
        <span class="text-emerald-400">+${f.add}</span>
        <span class="text-rose-400 ml-1.5">-${f.del}</span>
      </div>
    </div>
  `).join('');

  modal.classList.remove('hidden');
}

function closeFilesModal() {
  const modal = document.getElementById('modal-files');
  if (modal) modal.classList.add('hidden');
}

// ==========================================================================
// 11. BROWSE FOLDER & PROJECT HANDLING
// ==========================================================================

async function browseFolder() {
  const chosen = await bridge.selectProject();
  if (chosen) {
    state.projectPath = chosen;
    const pInput = document.getElementById('project-input');
    if (pInput) pInput.value = chosen;
    await refreshGitBranch();
    await bridge.setStorage({ lastProject: chosen });
    showToast('info', `Project selected: ${chosen}`);
  }
}

async function onProjectChange() {
  const pInput = document.getElementById('project-input');
  if (pInput) {
    state.projectPath = pInput.value.trim();
    await refreshGitBranch();
    await bridge.setStorage({ lastProject: state.projectPath });
  }
}

async function renderProjectsList(projects) {
  const container = document.getElementById('projects-list-container');
  if (!container) return;

  const items = [];
  projectListCache = Array.isArray(projects) ? projects.slice() : [];
  for (let idx = 0; idx < projectListCache.length; idx++) {
    const p = projectListCache[idx];
    const info = (await bridge.getBranchInfo(p)) || {};
    const exists = info.exists !== false;
    const g = describeGit(info);
    const statusLine = g.kind === 'missing' ? 'Directory not found on disk'
      : g.kind === 'norepo' ? 'Not a git repository — `git init` is required for AI Bridge'
      : g.kind === 'detached' ? `Detached HEAD${info.sha ? ' (' + info.sha + ')' : ''} — switch to a branch`
      : `Active Branch: ${info.branch || 'main'}`;
    items.push(`
      <div class="p-4 rounded-xl bg-[#0a1324] border border-[#1b2b48] flex items-center justify-between hover:border-cyan-500/30 transition-all">
        <div>
          <div class="text-sm font-semibold text-white flex items-center gap-2">
            <span>📁</span>
            <span>${escapeHtml(p)}</span>
            ${!exists ? '<span class="git-chip git-missing">Not Found</span>' : (g.kind === 'norepo' ? '<span class="git-chip git-norepo">Not a git repository</span>' : (g.kind === 'detached' ? '<span class="git-chip git-detached">Detached HEAD</span>' : ''))}
          </div>
          <div class="text-xs text-slate-400 font-mono mt-0.5">${escapeHtml(statusLine)}</div>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="removeProjectFromList(${idx}, event)" class="px-2.5 py-1.5 bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-300 text-xs rounded-lg border border-slate-800 transition-colors">
            Remove
          </button>
          <button onclick="selectProjectFromList(${idx})" class="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors">
            Select & Open
          </button>
        </div>
      </div>
    `);
  }

  container.innerHTML = items.join('');
}

let projectListCache = [];

async function removeProjectFromList(idx, e) {
  if (e) e.stopPropagation();
  const p = projectListCache[idx];
  if (p === undefined) return;
  const cfg = (await bridge.getStorage()) || {};
  const list = (cfg.recentProjects || projectListCache).filter(item => item !== p);
  const patch = { recentProjects: list };
  if (cfg.lastProject === p) patch.lastProject = list[0] || '';
  await bridge.setStorage(patch);
  await renderProjectsList(list);
  showToast('info', 'Project removed from the list.');
}

async function selectProjectFromList(idx) {
  const p = projectListCache[idx];
  if (!p) return;
  state.projectPath = p;
  bridge.setStorage({ lastProject: p });
  const pInput = document.getElementById('project-input');
  if (pInput) pInput.value = p;
  await refreshGitBranch();
  switchTab('run');
  showToast('info', `Active project: ${p}`);
}

// ==========================================================================
// 12. HISTORY & DOCTOR
// ==========================================================================

async function loadHistory() {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;

  try {
    const res = await bridge.getHistory(state.projectPath);
    const runs = res && res.runs ? res.runs : [];

    if (runs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="p-4 text-center text-slate-500 font-mono">
            No run history has been recorded in this repository yet.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = runs.map(r => `
      <tr class="hover:bg-[#0c1830] transition-colors">
        <td class="p-3 font-mono text-cyan-400">${r.run_id || 'N/A'}</td>
        <td class="p-3 truncate max-w-xs text-slate-300">${escapeHtml(r.task || '')}</td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${getDecisionBadgeClass(r.decision || r.status)}">
            ${r.decision || r.status || 'unknown'}
          </span>
        </td>
        <td class="p-3 font-mono text-slate-400">${formatDuration(r.duration_seconds || 0)}</td>
        <td class="p-3 font-mono text-slate-400">${r.changed_files || 0} files</td>
        <td class="p-3 text-right">
          <button onclick="openA4Modal()" class="text-cyan-400 hover:underline font-medium">Rapor</button>
        </td>
      </tr>
    `).join('');
  } catch (_) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">Could not load history.</td></tr>`;
  }
}

async function runDoctorCheck() {
  const container = document.getElementById('doctor-results');
  const btn = document.getElementById('btn-doctor');
  if (!container) return;

  if (btn) btn.innerText = 'Kontrol Ediliyor...';

  try {
    const res = await bridge.getDoctor();
    const data = res && res.data ? res.data : null;

    if (data) {
      container.innerHTML = `
        <div class="p-3 rounded-lg bg-[#060c18] border border-[#182a4a]">
          <div class="text-slate-400">Git</div>
          <div class="font-semibold font-mono mt-0.5 ${data.git && data.git.available ? 'text-emerald-400' : 'text-rose-400'}">
            ${data.git && data.git.available ? data.git.version : 'Missing / Not installed'}
          </div>
          <div class="text-[10px] text-slate-500 font-mono truncate mt-0.5">${data.git ? data.git.path : ''}</div>
        </div>
        <div class="p-3 rounded-lg bg-[#060c18] border border-[#182a4a]">
          <div class="text-slate-400">Codex CLI</div>
          <div class="font-semibold font-mono mt-0.5 ${data.codex && data.codex.available ? 'text-emerald-400' : 'text-rose-400'}">
            ${data.codex && data.codex.available ? data.codex.version : 'Missing / Not installed'}
          </div>
          <div class="text-[10px] text-slate-500 font-mono truncate mt-0.5">${data.codex ? data.codex.path : ''}</div>
        </div>
        <div class="p-3 rounded-lg bg-[#060c18] border border-[#182a4a]">
          <div class="text-slate-400">Claude Code</div>
          <div class="font-semibold font-mono mt-0.5 ${data.claude && data.claude.available ? 'text-emerald-400' : 'text-rose-400'}">
            ${data.claude && data.claude.available ? data.claude.version : 'Missing / Not installed'}
          </div>
          <div class="text-[10px] text-slate-500 font-mono truncate mt-0.5">${data.claude ? data.claude.path : ''}</div>
        </div>
        <div class="p-3 rounded-lg bg-[#060c18] border border-[#182a4a]">
          <div class="text-slate-400">Antigravity (AGY)</div>
          <div class="font-semibold font-mono mt-0.5 ${data.agy && data.agy.available ? 'text-emerald-400' : 'text-rose-400'}">
            ${data.agy && data.agy.available ? data.agy.version : 'Missing / Not installed'}
          </div>
          <div class="text-[10px] text-slate-500 font-mono truncate mt-0.5">${data.agy ? data.agy.path : ''}</div>
        </div>
        <div class="p-3 rounded-lg bg-[#060c18] border border-[#182a4a]">
          <div class="text-slate-400">jq (JSON Parser)</div>
          <div class="font-semibold font-mono mt-0.5 ${data.jq && data.jq.available ? 'text-emerald-400' : 'text-rose-400'}">
            ${data.jq && data.jq.available ? data.jq.version : 'Missing / Not installed'}
          </div>
          <div class="text-[10px] text-slate-500 font-mono truncate mt-0.5">${data.jq ? data.jq.path : ''}</div>
        </div>
        <div class="p-3 rounded-lg bg-[#060c18] border border-[#182a4a]">
          <div class="text-slate-400">System Readiness</div>
          <div class="font-semibold font-mono mt-0.5 ${data.ready ? 'text-cyan-300' : 'text-amber-400'}">
            ${data.ready ? 'READY (All tools OK)' : 'SOME TOOLS ARE MISSING'}
          </div>
          <div class="text-[10px] text-slate-500 font-mono mt-0.5">Auth: unknown</div>
        </div>
      `;
    }
  } catch (_) {}

  if (btn) btn.innerText = 'Test Et (Doctor)';
}

async function saveSettings() {
  const codex = parseInt(document.getElementById('setting-codex-timeout').value, 10) || 1500;
  const claude = parseInt(document.getElementById('setting-claude-timeout').value, 10) || 900;
  const agy = parseInt(document.getElementById('setting-agy-timeout').value, 10) || 1500;
  const transport = getSelectedTransport();

  await bridge.setStorage({
    timeouts: { codex, claude, agy },
    agyTransport: transport
  });

  showToast('success', '✓ Settings saved successfully.');
}

async function resetSettingsToDefaults() {
  document.getElementById('setting-codex-timeout').value = 1500;
  document.getElementById('setting-claude-timeout').value = 900;
  document.getElementById('setting-agy-timeout').value = 1500;
  document.getElementById('turns-input').value = 3;
  document.getElementById('verify-input').value = 'pytest -q';
  document.getElementById('chk-auto-approve').checked = false;
  updateAutoApproveLabel();

  const radios = document.getElementsByName('agy-transport');
  for (const r of radios) {
    r.checked = (r.value === 'stream');
  }

  await bridge.setStorage({
    timeouts: { codex: 1500, claude: 900, agy: 1500 },
    agyTransport: 'stream',
    verifyCmd: 'pytest -q',
    maxTurns: 3,
    autoApprove: false
  });

  showToast('info', 'Settings reset to defaults.');
}

// ==========================================================================
// 13. BROWSER BRIDGE & CHAT CONTEXT CONTROLLER
// ==========================================================================

async function initBrowserBridge() {
  try {
    const status = await bridge.browserBridgeStatus();
    if (status) {
      state.browserBridge.port = status.port || 45821;
      state.browserBridge.paired = !!status.paired;
      state.browserBridge.activeContext = status.activeContext || null;
      state.browserBridge.detectedTabs = status.detectedTabs || { chatgpt: false, claude: false, gemini: false };
    }
  } catch (err) {
    console.warn('Browser bridge status error:', err);
  }

  // Register push event listeners from main process
  if (bridge.onChatContextUpdated) {
    bridge.onChatContextUpdated((ctx) => {
      state.browserBridge.activeContext = ctx;
      updateChatContextDisplay();
      if (ctx) {
        showToast('success', `Conversation imported from the browser: ${ctx.title} (${ctx.messageCount} messages)`);
      }
    });
  }

  if (bridge.onBrowserPaired) {
    bridge.onBrowserPaired((data) => {
      state.browserBridge.paired = !!data.paired;
      updateChatContextDisplay();
      updateSettingsBridgeDisplay();
      if (data.paired) {
        closePairingModal();
        showToast('success', 'Browser extension paired successfully!');
      } else {
        showToast('info', 'Extension unpaired.');
      }
    });
  }

  if (bridge.onDetectedTabsUpdated) {
    bridge.onDetectedTabsUpdated((tabs) => {
      state.browserBridge.detectedTabs = tabs || {};
      updateDetectedTabsDisplay();
    });
  }

  updateChatContextDisplay();
  updateSettingsBridgeDisplay();
  updateDetectedTabsDisplay();
}

async function openPairingModal() {
  const modal = document.getElementById('modal-pairing');
  if (!modal) return;
  modal.classList.remove('hidden');
  await regeneratePairingCode();
}

async function regeneratePairingCode() {
  const codeEl = document.getElementById('pairing-modal-code');
  const portInfo = document.getElementById('pairing-port-info');
  if (codeEl) codeEl.innerText = '------';

  try {
    const res = await bridge.createPairingCode();
    if (res && res.code) {
      if (codeEl) codeEl.innerText = res.code;
      if (portInfo) portInfo.innerText = `127.0.0.1:${res.port || state.browserBridge.port}`;
      state.browserBridge.pairingExpiresAt = res.expiresAt || (Date.now() + 300000);
      startPairingCountdown();
    }
  } catch (err) {
    showToast('error', 'Could not generate pairing code: ' + err.message);
  }
}

function startPairingCountdown() {
  clearInterval(state.browserBridge.pairingTimer);
  const timerEl = document.getElementById('pairing-timer');

  const updateTimer = () => {
    const remaining = Math.max(0, Math.floor((state.browserBridge.pairingExpiresAt - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60).toString().padStart(2, '0');
    const secs = (remaining % 60).toString().padStart(2, '0');
    if (timerEl) timerEl.innerText = `${mins}:${secs}`;
    if (remaining <= 0) {
      clearInterval(state.browserBridge.pairingTimer);
      if (timerEl) timerEl.innerText = '00:00 (Expired)';
    }
  };

  updateTimer();
  state.browserBridge.pairingTimer = setInterval(updateTimer, 1000);
}

function closePairingModal() {
  clearInterval(state.browserBridge.pairingTimer);
  const modal = document.getElementById('modal-pairing');
  if (modal) modal.classList.add('hidden');
}

function updateChatContextDisplay() {
  const badge = document.getElementById('chat-context-badge');
  const title = document.getElementById('chat-context-title');
  const meta = document.getElementById('chat-context-meta');
  const iconContainer = document.getElementById('chat-context-icon-container');
  const truncWarn = document.getElementById('chat-context-trunc-warn');
  const btnPair = document.getElementById('btn-chat-pair');
  const btnRefresh = document.getElementById('btn-chat-refresh');
  const btnClear = document.getElementById('btn-chat-clear');

  if (!badge || !title || !meta) return;

  if (state.demoMode) {
    badge.className = "text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800 flex items-center gap-1";
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ChatGPT Web Connected (DEMO)';
    title.innerText = 'MotionSmith V2 Debugging';
    meta.innerText = '47 messages • 18.4k chars • Simulated';
    if (iconContainer) {
      iconContainer.className = "w-8 h-8 rounded-lg bg-emerald-950/90 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0";
    }
    if (truncWarn) truncWarn.classList.add('hidden');
    if (btnPair) {
      btnPair.classList.remove('hidden');
      btnPair.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg> Pair Extension';
    }
    if (btnRefresh) btnRefresh.classList.add('hidden');
    if (btnClear) btnClear.classList.add('hidden');
    return;
  }

  const bb = state.browserBridge;
  const ctx = bb.activeContext;

  if (ctx) {
    // 1. Live Context Imported
    badge.className = "text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800 flex items-center gap-1";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> ${ctx.provider || 'ChatGPT Web'}`;
    title.innerText = ctx.title || 'ChatGPT Conversation';
    const charsK = Math.round((ctx.charCount || 0) / 100) / 10;
    const timeAgo = formatTimeAgo(ctx.importedAt);
    meta.innerText = `${ctx.messageCount} messages • ${charsK}k chars • Updated ${timeAgo}`;
    if (iconContainer) {
      iconContainer.className = "w-8 h-8 rounded-lg bg-emerald-950/90 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0";
    }
    if (truncWarn) {
      if (ctx.truncated) truncWarn.classList.remove('hidden');
      else truncWarn.classList.add('hidden');
    }
    if (btnPair) btnPair.classList.add('hidden');
    if (btnRefresh) {
      btnRefresh.classList.remove('hidden');
      btnRefresh.classList.add('flex');
    }
    if (btnClear) {
      btnClear.classList.remove('hidden');
      btnClear.classList.add('flex');
    }
  } else if (bb.paired) {
    // 2. Extension Paired, but no conversation imported yet
    badge.className = "text-[10px] font-medium px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-400 border border-cyan-800 flex items-center gap-1";
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-cyan-400"></span> Extension Paired';
    title.innerText = 'No conversation imported';
    meta.innerText = 'Open ChatGPT tab and click "Send Current Chat"';
    if (iconContainer) {
      iconContainer.className = "w-8 h-8 rounded-lg bg-cyan-950/80 border border-cyan-500/40 flex items-center justify-center text-cyan-400 shrink-0";
    }
    if (truncWarn) truncWarn.classList.add('hidden');
    if (btnPair) {
      btnPair.classList.remove('hidden');
      btnPair.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg> Pairing Info';
    }
    if (btnRefresh) btnRefresh.classList.add('hidden');
    if (btnClear) btnClear.classList.add('hidden');
  } else {
    // 3. Not paired
    badge.className = "text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-1";
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Not Connected';
    title.innerText = 'No Extension Paired';
    meta.innerText = 'Pair browser extension to sync web chats';
    if (iconContainer) {
      iconContainer.className = "w-8 h-8 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-400 shrink-0";
    }
    if (truncWarn) truncWarn.classList.add('hidden');
    if (btnPair) {
      btnPair.classList.remove('hidden');
      btnPair.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg> Pair Extension';
    }
    if (btnRefresh) btnRefresh.classList.add('hidden');
    if (btnClear) btnClear.classList.add('hidden');
  }
}

function importChatContext() {
  if (state.demoMode) {
    showToast('info', 'Demo: ChatGPT Web context imported (47 messages, 18.4k chars).');
    return;
  }
  if (!state.browserBridge.paired) {
    openPairingModal();
  } else {
    showToast('info', 'Open the ChatGPT tab in your browser and click "Send Current Chat" from the extension icon.');
  }
}

async function refreshChatContext() {
  if (state.demoMode) {
    showToast('info', 'Demo: Session synced.');
    return;
  }
  try {
    const ctx = await bridge.getChatContext();
    state.browserBridge.activeContext = ctx;
    updateChatContextDisplay();
    if (ctx) {
      showToast('info', `Conversation context refreshed: ${ctx.title}`);
    } else {
      showToast('info', 'No conversation has been imported yet.');
    }
  } catch (err) {
    showToast('error', 'Refresh error: ' + err.message);
  }
}

async function disconnectChatContext() {
  if (state.demoMode) {
    showToast('info', 'Demo: Context cleared.');
    return;
  }
  try {
    await bridge.clearChatContext();
    state.browserBridge.activeContext = null;
    updateChatContextDisplay();
    showToast('info', 'Conversation context cleared. Run will no longer use --context-file.');
  } catch (err) {
    showToast('error', 'Context clear error: ' + err.message);
  }
}

async function unpairBrowserExtension() {
  try {
    await bridge.unpairBrowserExtension();
    state.browserBridge.paired = false;
    state.browserBridge.activeContext = null;
    updateChatContextDisplay();
    updateSettingsBridgeDisplay();
    showToast('info', 'Browser extension unpaired successfully.');
  } catch (err) {
    showToast('error', 'Unpair error: ' + err.message);
  }
}

function updateSettingsBridgeDisplay() {
  const badge = document.getElementById('settings-bridge-badge');
  const portEl = document.getElementById('settings-bridge-port');
  const btnUnpair = document.getElementById('btn-settings-unpair');

  const bb = state.browserBridge;
  if (portEl) portEl.innerText = `Port: 127.0.0.1:${bb.port || 45821}`;

  if (badge) {
    if (bb.paired) {
      badge.className = 'px-2.5 py-1 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800 text-[11px] font-mono';
      badge.innerText = 'Connected & Paired';
    } else {
      badge.className = 'px-2.5 py-1 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-[11px] font-mono';
      badge.innerText = 'Not Paired';
    }
  }

  if (btnUnpair) {
    if (bb.paired) btnUnpair.classList.remove('hidden');
    else btnUnpair.classList.add('hidden');
  }
}

function updateDetectedTabsDisplay() {
  // In LLM Hub tab, reflect detected status
  const tabs = state.browserBridge.detectedTabs || {};
  // Could update session indicator in LLM Hub
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'recently';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ==========================================================================
// 14. HELPERS, TIMERS & FORMATTERS
// ==========================================================================

function showToast(type = 'info', message = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let icon = 'ℹ';
  if (type === 'success') icon = '✓';
  if (type === 'warning') icon = '⚠';
  if (type === 'error') icon = '✕';

  toast.innerHTML = `<span class="font-bold text-sm">${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px) scale(0.96)';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

function renderAllState() {
  updateCharCount();
  updateAutoApproveLabel();
  updateReviewFindingsDisplay();
  updateMetricsCards();
  updateTestProgress(state.metrics.testsPassed, state.metrics.testsTotal);
  renderDecisionBanner(state.currentDecision);
  updateChatContextDisplay();
}

function updateMetricsCards() {
  const mFiles = document.getElementById('metric-files');
  const mAdded = document.getElementById('metric-added');
  const mRemoved = document.getElementById('metric-removed');
  const mWarnings = document.getElementById('metric-warnings');

  const setKpi = (el, val) => {
    if (!el) return;
    const next = String(val);
    if (el.innerText !== next) {
      el.innerText = next;
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  };
  setKpi(mFiles, state.metrics.filesChanged);
  setKpi(mAdded, `+${state.metrics.linesAdded}`);
  setKpi(mRemoved, `-${state.metrics.linesRemoved}`);
  setKpi(mWarnings, state.metrics.warnings);
}

function updateCharCount() {
  const textarea = document.getElementById('task-text');
  const counter = document.getElementById('char-count');
  if (textarea && counter) {
    counter.innerText = `${textarea.value.length}/4000`;
  }
}

function updateAutoApproveLabel() {
  const chk = document.getElementById('chk-auto-approve');
  const label = document.getElementById('auto-approve-label');
  if (chk && label) {
    label.innerText = chk.checked ? 'On' : 'Off';
    label.className = chk.checked ? 'text-[10px] text-cyan-400 font-mono font-bold' : 'text-[10px] text-slate-500 font-mono';
  }
}

function toggleDemoMode() {
  state.demoMode = !state.demoMode;
  updateDemoModeButton();
  updateChatContextDisplay();
  bridge.setStorage({ demoMode: state.demoMode });
  showToast('info', state.demoMode ? 'Demo Mode enabled.' : 'Production Mode enabled.');
}

function updateDemoModeButton() {
  const btn = document.getElementById('btn-demo-mode');
  if (btn) {
    btn.innerText = state.demoMode ? 'ON' : 'OFF';
    btn.className = state.demoMode
      ? 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-cyan-600 text-white transition-colors shadow-sm shadow-cyan-600/30'
      : 'text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 hover:text-white transition-colors';
  }
}

function updateReviewFindingsDisplay() {
  const text = document.getElementById('review-findings-text');
  if (text) {
    text.innerHTML = `
      <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Blocker ${state.metrics.blockers}</span>
      <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Major ${state.metrics.majors}</span>
      <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> Minor ${state.metrics.minors}</span>
    `;
  }
}

function updateTestProgress(passed, total) {
  if (!total) return;
  const bar = document.getElementById('test-progress-bar');
  const text = document.getElementById('test-progress-text');
  if (bar && text) {
    const pct = Math.round((passed / total) * 100);
    bar.style.width = `${pct}%`;
    text.innerText = `${passed} / ${total} Passed`;
    if (pct === 100) {
      bar.className = 'h-full bg-emerald-400 rounded-full';
      text.className = 'text-emerald-400 font-mono font-bold text-[11px]';
    } else {
      bar.className = 'h-full bg-amber-400 rounded-full';
      text.className = 'text-amber-400 font-mono font-bold text-[11px]';
    }
  }
}

function updateTurnDisplay() {
  const foot = document.getElementById('foot-turn');
  if (foot) foot.innerText = `Turn: ${state.currentTurn}/${state.maxTurns}`;
  setPipelineTurn();
}

function setVerificationFooter(text, colorClass) {
  const f = document.getElementById('foot-verify');
  if (f) {
    f.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${colorClass}"></span> Verification: ${text}`;
  }
}

function startElapsedTimer() {
  stopElapsedTimer();
  state.elapsedSeconds = 0;
  state.elapsedTimer = setInterval(() => {
    state.elapsedSeconds++;
    const str = formatDuration(state.elapsedSeconds);
    const foot = document.getElementById('foot-elapsed');
    if (foot) foot.innerText = `⏱ Elapsed: ${str}`;
    const chip = document.getElementById('pipe-elapsed-chip');
    if (chip) chip.innerHTML = `⏱ <b>${str}</b>`;
  }, 1000);
}

function stopElapsedTimer() {
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
}

function getSelectedTransport() {
  const radios = document.getElementsByName('agy-transport');
  for (const r of radios) {
    if (r.checked) return r.value;
  }
  return 'stream';
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s < 10 ? '0' : ''}${s}s`;
}

function getAgentColor(agent) {
  if (agent === 'codex') return 'text-emerald-400';
  if (agent === 'claude') return 'text-amber-400';
  if (agent === 'antigravity' || agent === 'agy') return 'text-cyan-400';
  return 'text-slate-300';
}

function getDecisionColor(dec) {
  if (dec === 'ready_for_approval' || dec === 'accepted') return 'text-emerald-400';
  if (dec === 'blocked' || dec === 'failed') return 'text-rose-400';
  if (dec === 'needs_manual_verification' || dec === 'needs_another_turn' || dec === 'max_turns') return 'text-amber-400';
  return 'text-cyan-300';
}

function getDecisionBadgeClass(dec) {
  if (dec === 'accepted') return 'bg-emerald-950 text-emerald-400 border border-emerald-800';
  if (dec === 'ready_for_approval') return 'bg-cyan-950 text-cyan-400 border border-cyan-800';
  if (dec === 'rolled_back') return 'bg-rose-950 text-rose-400 border border-rose-800';
  if (dec === 'blocked' || dec === 'failed') return 'bg-rose-950 text-rose-400 border border-rose-800';
  return 'bg-slate-800 text-slate-300';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================================================
// 15. LLM HUB WEB ORCHESTRATION CONTROLLER
// ==========================================================================

const llmHubState = {
  mode: 'collaborative',
  rounds: 2,
  topic: 'How can we make camera motion in 3D games feel more natural and cinematic?',
  providers: {
    chatgpt: true,
    claude: true,
    gemini: true
  },
  isRunning: false,
  activeSessionId: null,
  history: [
    {
      round: 1,
      provider: 'chatgpt',
      text: "Natural camera motion often comes from combining intention (what the player is focusing on) with physical realism. I'd suggest using a mix of spring-based smoothing, look-ahead based on player input, and contextual adjustments (e.g., tighter framing during combat, wider shots during exploration).",
      timestamp: Date.now() - 120000
    },
    {
      round: 1,
      provider: 'claude',
      text: "I agree, and would add that consistency is key. The camera should follow clear rules so it feels predictable, but with subtle variation to avoid feeling mechanical. Consider using cinematic techniques like rule of thirds, dynamic framing, and easing curves to make transitions feel more intentional and film-like.",
      timestamp: Date.now() - 90000
    },
    {
      round: 1,
      provider: 'gemini',
      text: "Building on both points, you can also leverage AI-driven camera assistants that adapt to in-game context (e.g., detecting important moments, environmental scale, or player emotion). Using a layered system — base rules + context awareness + cinematic presets — can produce natural yet dynamic camera behavior.",
      timestamp: Date.now() - 60000
    }
  ],
  consensus: `### 1. Core Consensus
All models agree that natural camera motion requires eliminating velocity discontinuities across keyframes through cubic spline interpolation and critically damped spring-damper physics, paired with subtle look-ahead tracking.

### 2. Key Disagreements & Trade-offs
- **Physics vs. Determinism**: Pure spring-damper models feel more natural in single-player, whereas deterministic spline baselines with local client-side smoothing are preferred for networked multiplayer.
- **Responsiveness vs. Cinematic Weight**: Aggressive damping enhances cinematic quality but increases perceived input lag during twitch reflex actions.

### 3. Recommended Approach
Adopt a 3-layer camera controller:
1. **Target Anchor Layer**: Evaluates position and forward vector using Catmull-Rom splines.
2. **Smoothing Layer**: Employs safe quaternion slerp with antipodal sign correction and dynamic damping coefficients.
3. **Contextual Framing Layer**: Adapts FOV and framing offset according to gameplay state (combat, exploration, dialog).

### 4. Important Caveats & Action Items
- Handle zero-delta keyframes and antipodal quaternion flips explicitly.
- Implement camera dead-zones to prevent micro-jitter during idle turns.`,
  savedChats: [],
  filteredSavedChats: [],
  timer: null,
  elapsedSec: 0
};

function initLLMHub() {
  renderLLMDiscussionMessages();
  renderConsensus(llmHubState.consensus);
  loadSavedChats();
  refreshTabDetection();

  if (bridge.onLLMHubEvent) {
    bridge.onLLMHubEvent((eventData) => {
      handleLLMHubEvent(eventData);
    });
  }

  if (bridge.onDetectedTabsUpdated) {
    bridge.onDetectedTabsUpdated((tabs) => {
      state.browserBridge.detectedTabs = tabs;
      updateDetectedTabsUI(tabs);
    });
  }
}

function setLLMMode(mode) {
  llmHubState.mode = mode;
  const modes = ['collaborative', 'debate', 'brainstorm', 'code_review'];
  modes.forEach((m) => {
    const btn = document.getElementById(`mode-btn-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = 'px-2.5 py-1 rounded bg-cyan-600/30 text-cyan-300 border border-cyan-500/50 text-xs font-semibold transition-all shadow-sm shadow-cyan-500/10';
      } else {
        btn.className = 'px-2.5 py-1 rounded bg-slate-800 text-slate-400 hover:text-slate-200 text-xs font-medium transition-all';
      }
    }
  });
}

function onLLMProviderToggle() {
  const chkGpt = document.getElementById('llm-chk-chatgpt');
  const chkClaude = document.getElementById('llm-chk-claude');
  const chkGemini = document.getElementById('llm-chk-gemini');

  llmHubState.providers = {
    chatgpt: chkGpt ? chkGpt.checked : true,
    claude: chkClaude ? chkClaude.checked : true,
    gemini: chkGemini ? chkGemini.checked : true
  };

  const selectedCount = Object.values(llmHubState.providers).filter(Boolean).length;
  if (selectedCount < 2) {
    showToast('warning', 'At least 2 LLM providers must be selected for multi-model orchestration.');
  }
  updateSummaryParticipants();
}

function updateLLMCharCount() {
  const input = document.getElementById('llm-topic-input');
  const counter = document.getElementById('llm-char-count');
  if (input && counter) {
    counter.innerText = `${input.value.length}/2000`;
    llmHubState.topic = input.value;
  }
  const summaryTopic = document.getElementById('llm-summary-topic');
  if (summaryTopic && input) {
    summaryTopic.innerText = input.value || 'Untitled Discussion';
  }
}

function injectQuickPrompt(type) {
  const input = document.getElementById('llm-topic-input');
  if (!input) return;

  if (type === 'architectural') {
    input.value = 'Compare modular event-driven architecture vs ECS (Entity Component System) for a real-time game engine. Discuss memory layout, cache locality, and developer ergonomics.';
    setLLMMode('collaborative');
  } else if (type === 'code_review') {
    input.value = 'Review the quaternion slerp interpolation algorithm in our camera sequencer. Identify race conditions, antipodal flipping bugs, and recommend SIMD optimizations.';
    setLLMMode('code_review');
  } else if (type === 'brainstorm') {
    input.value = 'Brainstorm 10 innovative game mechanics combining time-manipulation with dynamic physical destruction. Focus on emergent gameplay.';
    setLLMMode('brainstorm');
  } else if (type === 'debate') {
    input.value = 'Debate: Should game camera systems rely on critically damped physical spring-mass simulations, or deterministic hermite splines?';
    setLLMMode('debate');
  }

  updateLLMCharCount();
  showToast('info', 'Quick prompt loaded into LLM Hub.');
  input.focus();
}

let llmErrorTimer = null;

function showLLMError(msg) {
  const alert = document.getElementById('llm-error-alert');
  const text = document.getElementById('llm-error-text');
  if (alert && text) {
    text.innerText = msg;
    alert.classList.remove('hidden');
    clearTimeout(llmErrorTimer);
    llmErrorTimer = setTimeout(hideLLMError, 8000);
  }
}

function hideLLMError() {
  clearTimeout(llmErrorTimer);
  const alert = document.getElementById('llm-error-alert');
  if (alert) alert.classList.add('hidden');
}

async function startLLMSession() {
  hideLLMError();
  const input = document.getElementById('llm-topic-input');
  const roundsInput = document.getElementById('llm-rounds-input');

  const topic = input ? input.value.trim() : '';
  const rounds = roundsInput ? parseInt(roundsInput.value, 10) || 2 : 2;

  if (!topic) {
    showToast('error', 'Please enter a topic before starting the session.');
    if (input) input.focus();
    return;
  }

  const selectedProviders = Object.keys(llmHubState.providers).filter(k => llmHubState.providers[k]);
  if (selectedProviders.length < 2) {
    showToast('error', 'Please select at least 2 LLM providers.');
    return;
  }

  // Clear previous discussion
  llmHubState.history = [];
  llmHubState.consensus = null;
  llmHubState.activeSessionId = `session_${Date.now()}`;
  llmHubState.isRunning = true;
  llmHubState.elapsedSec = 0;

  renderLLMDiscussionMessages();
  const consensusCard = document.getElementById('llm-consensus-card');
  if (consensusCard) consensusCard.classList.add('hidden');

  setLLMRunningUI(true);
  startLLMTimer();

  try {
    const res = await bridge.startLLMSession({
      sessionId: llmHubState.activeSessionId,
      topic,
      mode: llmHubState.mode,
      rounds,
      providers: selectedProviders,
      demo: state.demoMode
    });

    if (!res.success) {
      setLLMRunningUI(false);
      stopLLMTimer();
      showLLMError(res.error || 'Failed to start session.');
      showToast('error', res.error || 'Session failed.');
    } else {
      showToast('info', `Multi-LLM session started (${selectedProviders.join(', ')})...`);
    }
  } catch (err) {
    setLLMRunningUI(false);
    stopLLMTimer();
    showLLMError(err.message);
    showToast('error', err.message);
  }
}

async function stopLLMSession() {
  try {
    await bridge.stopLLMSession();
    setLLMRunningUI(false);
    stopLLMTimer();
    hideGeneratingIndicator();
    showToast('warning', 'Session stopped by user.');
  } catch (err) {
    showToast('error', err.message);
  }
}

function setLLMRunningUI(running) {
  llmHubState.isRunning = running;
  const btnStart = document.getElementById('btn-llm-start');
  const btnStop = document.getElementById('btn-llm-stop');
  const statusEl = document.getElementById('llm-summary-status');

  if (btnStart) {
    if (running) {
      btnStart.classList.add('hidden');
    } else {
      btnStart.classList.remove('hidden');
    }
  }

  if (btnStop) {
    if (running) {
      btnStop.classList.remove('hidden');
      btnStop.classList.add('flex');
    } else {
      btnStop.classList.add('hidden');
      btnStop.classList.remove('flex');
    }
  }

  if (statusEl) {
    if (running) {
      statusEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span> Active';
      statusEl.className = 'text-cyan-400 font-bold flex items-center gap-1';
    } else {
      statusEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Ready';
      statusEl.className = 'text-emerald-400 font-bold flex items-center gap-1';
    }
  }
}

function startLLMTimer() {
  stopLLMTimer();
  llmHubState.elapsedSec = 0;
  const el = document.getElementById('llm-summary-elapsed');
  llmHubState.timer = setInterval(() => {
    llmHubState.elapsedSec++;
    if (el) el.innerText = formatDuration(llmHubState.elapsedSec);
  }, 1000);
}

function stopLLMTimer() {
  if (llmHubState.timer) {
    clearInterval(llmHubState.timer);
    llmHubState.timer = null;
  }
}

function showGeneratingIndicator(text) {
  const ind = document.getElementById('llm-generating-indicator');
  const lbl = document.getElementById('llm-generating-text');
  if (ind && lbl) {
    lbl.innerText = text || 'Model is generating response...';
    ind.classList.remove('hidden');
    ind.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

function hideGeneratingIndicator() {
  const ind = document.getElementById('llm-generating-indicator');
  if (ind) ind.classList.add('hidden');
}

function handleLLMHubEvent(ev) {
  if (!ev || !ev.event) return;

  switch (ev.event) {
    case 'session_started':
      setLLMRunningUI(true);
      showToast('info', `Session started: ${ev.mode || 'collaborative'} mode`);
      break;

    case 'round_started':
      const roundBadge = document.getElementById('llm-summary-rounds');
      if (roundBadge) roundBadge.innerText = `Round ${ev.round || 1}/${ev.totalRounds || 2}`;
      break;

    case 'provider_started':
      const pName = (ev.provider || 'Model').toUpperCase();
      showGeneratingIndicator(`${pName} is formulating response...`);
      break;

    case 'provider_finished':
      hideGeneratingIndicator();
      llmHubState.history.push({
        round: ev.round || 1,
        provider: ev.provider,
        text: ev.text || '',
        timestamp: Date.now()
      });
      renderLLMDiscussionMessages();
      break;

    case 'consensus_started':
      const lastP = (ev.provider || 'Synthesizer').toUpperCase();
      showGeneratingIndicator(`${lastP} is synthesizing Final Consensus...`);
      break;

    case 'consensus_finished':
      hideGeneratingIndicator();
      llmHubState.consensus = ev.consensus || '';
      renderConsensus(ev.consensus);
      break;

    case 'session_finished':
      setLLMRunningUI(false);
      stopLLMTimer();
      hideGeneratingIndicator();
      loadSavedChats();
      showToast('success', 'Multi-LLM session completed successfully!');
      break;

    case 'session_cancelled':
      setLLMRunningUI(false);
      stopLLMTimer();
      hideGeneratingIndicator();
      showToast('warning', 'Session was cancelled.');
      break;

    case 'provider_failed':
      hideGeneratingIndicator();
      {
        const pName = (ev.provider || 'Provider').toUpperCase();
        const stageLabel = ev.stage ? ` (${ev.stage})` : '';
        showToast('error', `${pName}${stageLabel}: ${ev.error || 'Failed to deliver the prompt.'}`);
      }
      break;

    case 'session_error':
      setLLMRunningUI(false);
      stopLLMTimer();
      hideGeneratingIndicator();
      showLLMError(ev.error || 'An error occurred during execution.');
      showToast('error', ev.error || 'Execution failed.');
      break;
  }
}

function renderLLMDiscussionMessages() {
  const container = document.getElementById('llm-stream-messages');
  const countBadge = document.getElementById('llm-stream-count-badge');
  if (!container) return;

  if (countBadge) {
    countBadge.innerText = `${llmHubState.history.length} message${llmHubState.history.length !== 1 ? 's' : ''}`;
  }

  if (llmHubState.history.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500 space-y-2">
        <div class="text-3xl">💬</div>
        <div class="text-xs font-medium text-slate-400">No active discussion yet</div>
        <div class="text-[11px] text-slate-600">Enter a topic above and click <strong>Start Session</strong> to begin.</div>
      </div>
    `;
    return;
  }

  const html = llmHubState.history.map((msg, index) => {
    const p = (msg.provider || 'user').toLowerCase();
    const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    let avatarBg = 'bg-slate-800 border-slate-700 text-slate-300';
    let avatarIcon = '●';
    let name = 'Model';
    let roleBadge = `Round ${msg.round || 1}`;

    if (p === 'chatgpt') {
      avatarBg = 'bg-emerald-950 border-emerald-500/40 text-emerald-400';
      avatarIcon = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 14.5h-2v-2h2zm0-4h-2V7h2z"/></svg>';
      name = 'ChatGPT';
    } else if (p === 'claude') {
      avatarBg = 'bg-amber-950 border-amber-500/40 text-amber-400';
      avatarIcon = '<span class="text-sm font-bold">✱</span>';
      name = 'Claude';
    } else if (p === 'gemini') {
      avatarBg = 'bg-purple-950 border-purple-500/40 text-purple-400';
      avatarIcon = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7z"/></svg>';
      name = 'Gemini';
    } else if (p === 'user') {
      avatarBg = 'bg-cyan-950 border-cyan-500/40 text-cyan-400';
      avatarIcon = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>';
      name = 'You (Follow-up)';
      roleBadge = 'User Query';
    }

    return `
      <div class="flex items-start gap-3 text-xs p-3 rounded-xl bg-[#081120] border border-[#16233b] hover:border-slate-700/80 transition-all">
        <div class="w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${avatarBg}">
          ${avatarIcon}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <div class="flex items-center gap-2">
              <span class="font-bold text-white">${escapeHtml(name)}</span>
              <span class="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-[#0a1528] text-slate-400 border border-slate-700/60">${escapeHtml(roleBadge)}</span>
              <span class="text-[10px] text-slate-500 font-mono">${timeStr}</span>
            </div>
            <button onclick="copyMessageText(${index})" class="text-[10px] text-slate-500 hover:text-cyan-400 transition-colors" title="Copy Message">
              Copy
            </button>
          </div>
          <div class="text-slate-300 leading-relaxed font-sans text-xs select-text break-words whitespace-pre-wrap">${formatMessageBody(msg.text)}</div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function formatMessageBody(raw) {
  if (!raw) return '';
  const escaped = escapeHtml(raw);
  // Highlight code blocks
  return escaped.replace(/```([a-z]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre class="my-2 p-2.5 rounded-lg bg-[#040812] border border-[#1e3256] text-[11px] font-mono text-cyan-300 overflow-x-auto"><code>${code}</code></pre>`;
  });
}

function copyMessageText(index) {
  const msg = llmHubState.history[index];
  if (msg && msg.text) {
    navigator.clipboard.writeText(msg.text);
    showToast('success', 'Message copied to clipboard.');
  }
}

function renderConsensus(consensusMarkdown) {
  const card = document.getElementById('llm-consensus-card');
  const body = document.getElementById('llm-consensus-body');
  if (!card || !body) return;

  if (!consensusMarkdown || !consensusMarkdown.trim()) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');

  // Format sections nicely
  const formatted = escapeHtml(consensusMarkdown)
    .replace(/^### (.*$)/gim, '<h4 class="font-bold text-cyan-300 text-xs mt-2 border-b border-[#1c2e4e] pb-0.5">$1</h4>')
    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    .replace(/^\- (.*$)/gim, '<li class="ml-4 list-disc text-slate-300">$1</li>');

  body.innerHTML = formatted;
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

async function copyConsensusText() {
  const text = llmHubState.consensus ||
    llmHubState.history.map(h => `[${h.provider.toUpperCase()} — Round ${h.round}]\n${h.text}`).join('\n\n');
  if (!text) {
    showToast('warning', 'Nothing to copy.');
    return;
  }
  const ok = await copyToClipboard(text);
  showToast(ok ? 'success' : 'error', ok ? 'Result copied to clipboard.' : 'Copy failed.');
}

function toggleConsensusExpand() {
  const body = document.getElementById('llm-consensus-body');
  const btn = document.getElementById('btn-consensus-expand');
  if (!body) return;
  const expanded = body.classList.toggle('expanded');
  if (btn) btn.innerText = expanded ? 'Collapse' : 'Expand';
}

async function exportConsensusMarkdown() {
  if (!llmHubState.consensus) {
    showToast('warning', 'No result to export.');
    return;
  }
  const md = [
    '# AI Bridge — Final Consensus',
    '',
    `**Topic:** ${llmHubState.topic || ''}`,
    `**Mode:** ${String(llmHubState.mode || '').toUpperCase()}`,
    `**Date:** ${new Date().toISOString()}`,
    '',
    '---',
    '',
    llmHubState.consensus
  ].join('\n');
  await saveMarkdown(`ai-bridge-consensus-${Date.now()}.md`, md);
}

function transferConsensusToTask() {
  if (!llmHubState.consensus) return;
  const taskText = document.getElementById('task-text');
  if (taskText) {
    taskText.value = `[Synthesized Task from LLM Hub]\n${llmHubState.consensus}`;
    updateCharCount();
  }
  switchTab('run');
  showToast('success', 'Consensus transferred to Run Task!');
}

async function sendLLMFollowUp() {
  const input = document.getElementById('llm-followup-input');
  const targetSelect = document.getElementById('llm-followup-target');
  if (!input) return;

  const text = input.value.trim();
  const target = targetSelect ? targetSelect.value : 'all';

  if (!text) return;

  // Add user message to UI stream
  llmHubState.history.push({
    round: 'follow-up',
    provider: 'user',
    text,
    timestamp: Date.now()
  });
  renderLLMDiscussionMessages();
  input.value = '';

  showGeneratingIndicator(`Asking ${target.toUpperCase()}...`);

  try {
    await bridge.sendLLMFollowUp({
      sessionId: llmHubState.activeSessionId,
      text,
      targetProvider: target
    });
  } catch (err) {
    hideGeneratingIndicator();
    showToast('error', err.message);
  }
}

function clearLLMDiscussion() {
  llmHubState.history = [];
  llmHubState.consensus = null;
  renderLLMDiscussionMessages();
  const consensusCard = document.getElementById('llm-consensus-card');
  if (consensusCard) consensusCard.classList.add('hidden');
  showToast('info', 'Discussion cleared.');
}

async function exportCurrentSession(format = 'markdown') {
  if (llmHubState.history.length === 0) {
    showToast('warning', 'No messages to export.');
    return;
  }

  const sessionObj = {
    sessionId: llmHubState.activeSessionId || `session_${Date.now()}`,
    topic: llmHubState.topic,
    mode: llmHubState.mode,
    totalRounds: llmHubState.rounds,
    providers: Object.keys(llmHubState.providers).filter(k => llmHubState.providers[k]),
    history: llmHubState.history,
    consensus: llmHubState.consensus,
    startedAt: Date.now() - (llmHubState.elapsedSec * 1000),
    finishedAt: Date.now()
  };

  const mdContent = [
    `# AI Bridge — Multi-LLM Discussion Report`,
    ``,
    `**Topic:** ${sessionObj.topic}`,
    `**Mode:** ${sessionObj.mode.toUpperCase()}`,
    `**Date:** ${new Date().toISOString()}`,
    `**Participants:** ${sessionObj.providers.join(', ')}`,
    ``,
    `---`,
    ``,
    `## Discussion Transcript`,
    ``,
    ...sessionObj.history.map(h => `### [${h.provider.toUpperCase()} (Round ${h.round})]\n\n${h.text}\n`),
    `---`,
    ``,
    `## Final Consensus`,
    ``,
    sessionObj.consensus || 'No consensus generated.'
  ].join('\n');

  await saveMarkdown(`ai-bridge-${sessionObj.sessionId}.md`, mdContent);
}

async function saveMarkdown(fileName, content) {
  try {
    if (bridge.saveTextFile) {
      const res = await bridge.saveTextFile(fileName, content);
      if (res && res.success) {
        showToast('success', `Saved: ${res.filePath}`);
        return;
      }
      if (res && res.canceled) return;
      throw new Error((res && res.error) || 'Could not save');
    }
    if (window.aiBridge) {
      throw new Error('The save component is not loaded — fully quit and restart the app.');
    }
    const blob = new Blob([content], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast('success', 'Markdown file downloaded.');
  } catch (err) {
    showToast('error', 'Export failed: ' + err.message);
  }
}

// ==========================================================================
// Saved Chats Modal & Management
// ==========================================================================

async function loadSavedChats() {
  try {
    const chats = await bridge.getSavedChats();
    llmHubState.savedChats = Array.isArray(chats) ? chats : [];
    llmHubState.filteredSavedChats = [...llmHubState.savedChats];

    const toolSavedCount = document.getElementById('llm-tool-saved-count');
    if (toolSavedCount) toolSavedCount.innerText = llmHubState.savedChats.length;

    renderSavedChatsList();
  } catch (err) {
    console.warn('loadSavedChats failed:', err);
  }
}

function openSavedChatsModal() {
  loadSavedChats();
  const modal = document.getElementById('modal-saved-chats');
  if (modal) modal.classList.remove('hidden');
}

function closeSavedChatsModal() {
  const modal = document.getElementById('modal-saved-chats');
  if (modal) modal.classList.add('hidden');
}

function filterSavedChats() {
  const searchInput = document.getElementById('saved-chats-search');
  const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
  if (!q) {
    llmHubState.filteredSavedChats = [...llmHubState.savedChats];
  } else {
    llmHubState.filteredSavedChats = llmHubState.savedChats.filter(c =>
      (c.topic || '').toLowerCase().includes(q) ||
      (c.mode || '').toLowerCase().includes(q)
    );
  }
  renderSavedChatsList();
}

function renderSavedChatsList() {
  const container = document.getElementById('saved-chats-list');
  const countLabel = document.getElementById('saved-chats-count-label');
  if (!container) return;

  if (countLabel) {
    countLabel.innerText = `${llmHubState.filteredSavedChats.length} Chats`;
  }

  if (llmHubState.filteredSavedChats.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <div class="text-2xl mb-1">📁</div>
        <div class="text-xs">No saved chats yet.</div>
      </div>
    `;
    return;
  }

  const html = llmHubState.filteredSavedChats.map((chat) => {
    const dateStr = chat.startedAt ? new Date(chat.startedAt).toLocaleString() : 'Recent';
    const participants = (chat.providers || ['chatgpt', 'claude', 'gemini']).map(p => p.toUpperCase()).join(' • ');

    return `
      <div class="p-3 rounded-lg bg-[#060c18] border border-[#1b2c4c] flex items-center justify-between gap-3 hover:border-cyan-500/40 transition-all">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-bold text-white truncate max-w-md">${escapeHtml(chat.topic || 'Untitled')}</span>
            <span class="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-[#0a1528] text-cyan-400 border border-cyan-800">${escapeHtml(chat.mode || 'collaborative')}</span>
          </div>
          <div class="text-[10px] text-slate-400 font-mono flex items-center gap-2">
            <span>${dateStr}</span>
            <span>•</span>
            <span>${participants}</span>
            <span>•</span>
            <span>${chat.messageCount || 0} msgs</span>
            ${chat.hasConsensus ? '<span class="text-emerald-400">★ Consensus</span>' : ''}
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button onclick="viewSavedChat('${chat.id}')" class="px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-semibold transition-colors">
            View
          </button>
          <button onclick="exportSavedChatFile('${chat.id}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs border border-slate-700 transition-colors" title="Export Markdown">
            Export
          </button>
          <button onclick="deleteSavedChatById('${chat.id}')" class="px-2 py-1 bg-rose-950/60 hover:bg-rose-900 text-rose-300 rounded text-xs border border-rose-800 transition-colors" title="Delete">
            Delete
          </button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

async function viewSavedChat(id) {
  try {
    const chat = await bridge.getSavedChat(id);
    if (!chat) return;

    llmHubState.topic = chat.topic || '';
    llmHubState.mode = chat.mode || 'collaborative';
    llmHubState.history = Array.isArray(chat.history) ? chat.history : [];
    llmHubState.consensus = chat.consensus || null;
    llmHubState.activeSessionId = chat.sessionId || id;

    const input = document.getElementById('llm-topic-input');
    if (input) input.value = llmHubState.topic;

    setLLMMode(llmHubState.mode);
    updateLLMCharCount();
    renderLLMDiscussionMessages();
    renderConsensus(llmHubState.consensus);

    closeSavedChatsModal();
    switchTab('llm-hub');
    showToast('info', `Loaded: ${chat.topic}`);
  } catch (err) {
    showToast('error', 'Could not load chat: ' + err.message);
  }
}

async function exportSavedChatFile(id) {
  try {
    const md = await bridge.exportSavedChat(id, 'markdown');
    if (md) await saveMarkdown(`ai-bridge-${id}.md`, md);
  } catch (err) {
    showToast('error', err.message);
  }
}

async function deleteSavedChatById(id) {
  try {
    await bridge.deleteSavedChat(id);
    await loadSavedChats();
    showToast('info', 'Chat deleted.');
  } catch (err) {
    showToast('error', err.message);
  }
}

// ==========================================================================
// Connected Tabs Modal & Management
// ==========================================================================

function openConnectedTabsModal() {
  refreshTabDetection();
  const modal = document.getElementById('modal-connected-tabs');
  if (modal) modal.classList.remove('hidden');
}

function closeConnectedTabsModal() {
  const modal = document.getElementById('modal-connected-tabs');
  if (modal) modal.classList.add('hidden');
}

async function refreshTabDetection() {
  try {
    const res = await bridge.getConnectedTabsStatus();
    if (res && res.tabs) {
      state.browserBridge.detectedTabs = res.tabs;
      updateDetectedTabsUI(res.tabs);
    }
    showToast('info', 'Tab status updated.');
  } catch (_) {}
}

function updateDetectedTabsUI(tabs) {
  const t = tabs || { chatgpt: false, claude: false, gemini: false };

  // 1. LLM Hub Top Cards
  const updateBadge = (id, connected) => {
    const el = document.getElementById(id);
    if (el) {
      if (connected) {
        el.className = 'text-[10px] text-emerald-400 flex items-center gap-1 font-medium';
        el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Detected';
      } else {
        el.className = 'text-[10px] text-slate-500 flex items-center gap-1 font-medium';
        el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-600"></span> Not open';
      }
    }
  };

  updateBadge('llm-tab-badge-chatgpt', t.chatgpt);
  updateBadge('llm-tab-badge-claude', t.claude);
  updateBadge('llm-tab-badge-gemini', t.gemini);

  // 2. Modal list
  const updateModalStat = (id, connected) => {
    const el = document.getElementById(id);
    if (el) {
      if (connected) {
        el.className = 'text-[10px] text-emerald-400 flex items-center gap-1 font-medium font-mono';
        el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Connected';
      } else {
        el.className = 'text-[10px] text-slate-500 flex items-center gap-1 font-medium font-mono';
        el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-600"></span> Not Open';
      }
    }
  };

  updateModalStat('modal-tab-stat-chatgpt', t.chatgpt);
  updateModalStat('modal-tab-stat-claude', t.claude);
  updateModalStat('modal-tab-stat-gemini', t.gemini);

  // 3. Side tools counter
  const detectedCount = Object.values(t).filter(Boolean).length;
  const toolCount = document.getElementById('llm-tool-tabs-count');
  if (toolCount) toolCount.innerText = detectedCount;

  updateSummaryParticipants();
}

function updateSummaryParticipants() {
  const container = document.getElementById('llm-summary-participants');
  if (!container) return;

  const p = llmHubState.providers;
  const items = [];
  if (p.chatgpt) items.push('<span class="text-emerald-400">🟢 ChatGPT</span>');
  if (p.claude) items.push('<span class="text-amber-400">🟠 Claude</span>');
  if (p.gemini) items.push('<span class="text-purple-400">🟣 Gemini</span>');

  container.innerHTML = items.join(' ') || '<span class="text-slate-500">None</span>';
}

