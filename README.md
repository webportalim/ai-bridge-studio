# AI Bridge Desktop V1

> **Three AIs. One workflow. Better results.**  
> Orchestrate OpenAI Codex, Anthropic Claude Code, and Google DeepMind Antigravity seamlessly in a production-grade desktop interface.

---

## 📸 Overview & Design System

AI Bridge Desktop V1 is a 16:9 desktop-first Electron application built with a high-contrast dark navy design system, directly matching the approved production mockups (`masaüstü görünümü.png` and `LLM Hub Sayfası.png`).

```
AI Bridge Desktop V1
│
├── Left Sidebar
│   ├── Logo & Brand (▲ AI Bridge v1.0.0)
│   ├── Run Screen (Active Pipeline & Execution)
│   ├── Projects (Managed Git Repositories)
│   ├── History (Historical Runs & Decisions)
│   ├── Divider
│   ├── LLM Hub (New — Web Sessions, Multi-LLM Chat, Session Tools)
│   ├── Divider
│   ├── Settings (System Diagnostics & Timeouts)
│   └── Three AIs Branding Card
│
├── Top Header
│   ├── Tagline ("Orchestrate Codex, Claude, and Antigravity")
│   ├── Status Indicator (● Ready / ● Running)
│   ├── Demo Mode Toggle (Interactive Preview Simulation)
│   ├── Real-time Clock
│   └── Window Controls (Minimize, Maximize, Close)
│
├── Run Screen (Main 16:9 Grid)
│   ├── LEFT COLUMN (8/12)
│   │   ├── Project Selection (Input, Browse, Active Branch)
│   │   ├── Task Prompt & Controls (Max Turns, Agents, Auto Approve, Verify Cmd, Run/Stop)
│   │   ├── Pipeline Visualizer (Codex, Claude Reviewer, Antigravity status cards)
│   │   └── Live Log Console (NDJSON formatted stream, Clear, Open in Editor)
│   │
│   └── RIGHT COLUMN (4/12)
│       ├── Chat Context (ChatGPT Web connection, message & char count, Import/Refresh)
│       ├── Change Overview (Files Changed, Lines Added, Lines Removed, Warnings/Findings)
│       │   └── Tests Progress, Review Findings, Risk Level, Agent Durations, Main Changes
│       └── Final Decision Banner (Ready for Approval, Blocked, Needs Verification, Accepted, Rolled Back)
│           ├── Status Grid (Claude Verdict, AGY Done, Verification, Permissions, Duration)
│           ├── View Full Decision (A4 Paper Modal)
│           ├── Open Log Button
│           ├── Accept Changes Button (Merge & Commit)
│           └── Rollback Button (Reset & Clean)
│
├── Secondary Views
│   ├── Projects: Manage local git repos and switch active projects
│   ├── History: Run history table with direct A4 report access
│   ├── Settings: CLI Doctor diagnostics (`git`, `codex`, `claude`, `agy`, `jq`) & timeouts
│   └── LLM Hub: Multi-LLM collaboration showcase (ChatGPT, Claude, Gemini)
│
└── Modals
    ├── View Full Decision (A4 printable paper report aesthetic)
    └── View Files (Detailed diff file list with additions/deletions)
```

---

## 🚀 Quick Start

### 1. Requirements
- **Node.js** >= 18.0.0
- **Git for Windows** (with Git Bash installed at standard path `C:\Program Files\Git\bin\bash.exe`)
- **CLI Tools** (optional for live execution, verified via Doctor):
  - `git`
  - `codex` (OpenAI Codex CLI)
  - `claude` (Anthropic Claude Code)
  - `agy` (Google Antigravity)
  - `jq` (JSON processor)

### 2. Installation
```bash
# In the AI-Bridge directory:
npm install
```

### 3. Launching the Desktop Application
On Windows, you can launch using any of the following methods:

- **Method A (Easiest)**: Double-click `start.bat` in the project root.
- **Method B (PowerShell)**: Run `npm.cmd start` or `npx.cmd electron .` (bypasses PowerShell `.ps1` ExecutionPolicy restrictions).
- **Method C (Command Prompt / Git Bash)**: Run `npm start`.

---

## 🎮 Interactive Demo Mode

The application includes a built-in **Demo Mode** toggle at the top header (`Demo: ON/OFF`):
- When enabled, clicking **Run Bridge** executes a realistic animated multi-agent pipeline simulation.
- Visualizes step-by-step agent execution, live terminal logs, review findings, test passing, and dynamic decision banners.
- Allows demonstrating and testing **Accept Changes**, **Rollback**, and **View Full Decision (A4)** without external API quotas.

---

## 🛡 Backend Integration Architecture

The Electron Main process (`main.js`) connects to the hardened canonical `ai_bridge.sh` backend via Git Bash child process spawning with `--json-events`:

- **Stdout NDJSON Streaming**: Output is buffered line-by-line and parsed as JSON before being securely passed to the renderer via IPC `bridge:event`.
- **Signal Handling & Process Tree Cleanup**: When **Stop** is clicked or the app is closed, Windows process trees are terminated cleanly (`SIGINT` -> `taskkill /t /f`).
- **Safety Gates**:
  - `accept` is strictly guarded by backend verification state.
  - `rollback` preserves clean working trees and cleans temporary branches safely.
  - No commits metric is shown during an active run (only Warnings and Review Findings).

---

## 🤖 LLM Hub Web Orchestration V1

AI Bridge Desktop V1 includes a **multi-LLM web orchestration engine** connecting your active Chrome/Edge browser sessions without API keys, token billing, or external quotas:

```
User Topic / Task
       ↓
ChatGPT Web (Proposes Initial Analysis & Core Architecture)
       ↓
Claude Web (Critiques, Refines & Extends Insights)
       ↓
Gemini Web (Compares Perspectives & Synthesizes Next Steps)
       ↓
Round 2... (Iterative Deep-Dive)
       ↓
Final Consensus (Core Consensus, Disagreements, Recommendation & Caveats)
```

### Key Features:
- **Zero API Keys & Zero Quota Footprint**: Uses your existing logged-in browser web sessions in ChatGPT, Claude, and Gemini.
- **4 Specialized Conversation Modes**:
  - `Collaborative`: Constructive synthesis building cohesively upon prior contributions.
  - `Debate`: Critical evaluation identifying edge-case failures, hidden assumptions, and trade-offs.
  - `Brainstorm`: Unconventional, creative, non-overlapping concept generation.
  - `Code Review`: Technical implementation critique focusing on correctness, race conditions, and performance.
- **Tab Locking & Detection**: Verifies that all selected models have active, detected browser tabs before starting; produces clear error alerts if a tab is missing.
- **Dedicated Consensus Card**: Synthesizes a 4-part consensus (Core Consensus, Key Disagreements & Trade-offs, Recommended Approach, Important Caveats & Action Items).
- **Interactive Follow-ups**: Ask follow-up questions targeting all models or a specific provider.
- **Saved Chats Storage**: Locally stores completed sessions in `userData/saved_chats/` with search, view, Markdown/JSON export, and deletion.
- **Connected Tabs Modal**: Real-time status inspector for ChatGPT, Claude, and Gemini browser tabs.
- **One-Click Task Transfer**: Transfer synthesized consensus directly into the Run screen task input.

---

## 🌐 Browser Companion Extension (Chrome / Edge)

AI Bridge includes a Manifest V3 browser companion in [`browser-extension/`](file:///f:/AI-Bridge/browser-extension/):

### Key Capabilities:
- **Localhost HTTP Bridge**: Bound strictly to `127.0.0.1:45821` (never `0.0.0.0`).
- **One-Time Pairing Security**: Desktop generates an ephemeral 6-digit code with 5-minute TTL, exchanging a 64-char crypto token.
- **Zero API Credentials**: No session cookies, tokens, or auth headers are accessed or stored.
- **Semantic DOM Adapters**: Full automation adapters for ChatGPT, Claude, and Gemini with streaming detection, text stability polling, and stop generation controls.
- **Native `--context-file` Feeding**: When active context is imported, `main.js` saves a structured markdown document into Electron `userData/context/` and supplies `--context-file` to `ai_bridge.sh`.

### Installation:
1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `F:\AI-Bridge\browser-extension`.
4. Click **Pair Extension** in AI Bridge Desktop to generate the pairing code, and connect from the extension popup.

---

## 📂 Project Structure

```
F:\AI-Bridge\
├── ai_bridge.sh                 # Hardened canonical backend orchestrator (100% frozen)
├── package.json                 # Electron dependencies & scripts
├── main.js                      # Electron main process (HTTP bridge server, bash spawn, LLM Hub IPC)
├── preload.js                   # Secure contextBridge API (Run operations + LLM Hub APIs)
├── renderer/
│   ├── index.html               # 16:9 desktop layout matching masaüstü görünümü.png & LLM Hub
│   ├── styles.css               # Dark navy design system, glowing borders, A4 report styles
│   ├── app.js                   # Reactive UI controller, event dispatcher, LLM Hub controller & demo mode
│   └── tailwind.min.js          # Offline Tailwind CSS engine
├── browser-extension/           # Chrome / Edge Manifest V3 companion extension
│   ├── manifest.json            # MV3 configuration with minimum permissions
│   ├── background.js            # Background service worker & LLMHubOrchestrator
│   ├── popup.html / .js / .css  # Extension popup matching AI Bridge dark aesthetic
│   ├── content/
│   │   ├── common.js            # Shared DOM sanitization, code preserver & 250k truncation
│   │   ├── templates.js         # Multi-mode prompt template & consensus synthesis engine
│   │   ├── chatgpt.js           # Semantic ChatGPT extractor & automation adapter
│   │   ├── claude.js            # Semantic Claude extractor & automation adapter
│   │   └── gemini.js            # Semantic Gemini extractor & automation adapter
│   ├── icons/                   # Standard 16, 48, 128 px PNG icons
│   └── README.md                # Extension installation & developer guide
├── docs/
│   └── GUI_BACKEND_PROTOCOL.md  # NDJSON event specification & IPC schema
└── tests/
    ├── test_ai_bridge.sh        # 37/37 automated backend regression test suite
    ├── test_browser_bridge.js   # 52/52 automated browser extension & context test suite
    ├── test_frontend_audit.js   # 5/5 Electron frontend integration test suite
    ├── test_llm_orchestration.js# 63/63 LLM Hub orchestration & storage test suite
    └── fixtures/                # Sanitized HTML DOM test fixtures
```

---

## 📄 License
MIT

