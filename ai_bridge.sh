#!/usr/bin/env bash
# ai_bridge.sh — Codex (Developer) -> Claude Code (Reviewer) -> Antigravity (Verifier & Fixer)
#
# CLI Syntax:
#   ai_bridge.sh run [options]
#   ai_bridge.sh status --project <path> [--run-id <id>]
#   ai_bridge.sh accept --project <path> [--run-id <id>] [--json-events]
#   ai_bridge.sh rollback --project <path> [--run-id <id>] [--json-events]
#   ai_bridge.sh report --project <path> [--run-id <id>]
#   ai_bridge.sh history --project <path> [--limit N]
#   ai_bridge.sh doctor
#
# Legacy Syntax (Backward compatible):
#   ./ai_bridge.sh "görev tanımı" [tur_sayısı] [proje_dizini]
#   ./ai_bridge.sh @gorev.md 3 /d/Projeler/X

set -uo pipefail

# ==================================================
# 1. ORTAM DEĞİŞKENLERİ VE VARSAYILANLAR
# ==================================================
TASK=""
TASK_FILE=""
CONTEXT_FILE=""
TURNS="${TURNS:-3}"
WORKDIR="${WORKDIR:-$(pwd)}"
AGENTS_ARG="${AGENTS_ARG:-codex,claude,agy}"
AUTO_APPROVE="${AUTO_APPROVE:-false}"
AGY_SANDBOX="${AGY_SANDBOX:-true}"
AUTO_BRANCH="${AUTO_BRANCH:-true}"
VERIFY_CMD="${VERIFY_CMD:-}"
AGY_TRANSPORT="${AGY_TRANSPORT:-stream}"
CODEX_MODEL="${CODEX_MODEL:-}"; CODEX_EFFORT="${CODEX_EFFORT:-}"
CLAUDE_MODEL="${CLAUDE_MODEL:-}"; CLAUDE_EFFORT="${CLAUDE_EFFORT:-}"
AGY_MODEL="${AGY_MODEL:-}"; AGY_EFFORT="${AGY_EFFORT:-}"
JSON_EVENTS="${JSON_EVENTS:-false}"

CODEX_TIMEOUT="${CODEX_TIMEOUT:-1500}"
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-900}"
AGY_TIMEOUT="${AGY_TIMEOUT:-1500}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-900}"
MAX_DIFF_CHARS="${MAX_DIFF_CHARS:-60000}"
MAX_CONTEXT_CHARS="${MAX_CONTEXT_CHARS:-100000}"
MAX_UNTRACKED_FILES="${MAX_UNTRACKED_FILES:-40}"

MIN_AGY_STREAM_VER="1.1.15"
MIN_AGY_VER="1.1.28"
REC_AGY_VER="1.2.6"
AGY_PROMPT_MAX=28000

START_EPOCH=$(date +%s)
START_ISO=""
RUN_ID=""
LOG_DIR=""
RUN_DIR=""
LOGFILE=""
BASE_HEAD=""
BRANCH=""
ORIG_REF=""
ORIG_ATTACHED=false
EXPECT_REF=""
HEAD_WARNED=""

CURRENT_STATUS="running"
CURRENT_DECISION="running"
CURRENT_VERIF="unknown"
CURRENT_AGENT="none"
VERIFY_SOURCE="none"
VERIFY_DURATION_SEC=0
LATEST_REVIEW_VERDICT="UNKNOWN"
LATEST_BLOCKER_COUNT=0
LATEST_MAJOR_COUNT=0
LATEST_MINOR_COUNT=0

CODEX_DURATION_TOTAL=0
CLAUDE_DURATION_TOTAL=0
AGY_DURATION_TOTAL=0

STATS_FILES=0
STATS_ADDED=0
STATS_REMOVED=0
STATS_BINARY=0

WARN_COUNT=0
WARNINGS_LIST=()
DECISION_WHY=()
TURN_LOG="[]"
TURNS_RUN=0
FINAL_MSG="Beklenmeyen çıkış"

ENABLE_CODEX=false
ENABLE_CLAUDE=false
ENABLE_AGY=false
AGENTS_JSON_ARRAY="[]"

PROCESSED_CONTEXT=""
CONTEXT_CHARS=0
CONTEXT_TRUNCATED=false

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1 && timeout --version 2>&1 | grep -qiE 'gnu|coreutils'; then TIMEOUT_BIN="timeout"; fi
run_t() { local secs=$1; shift; if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" --foreground -k 15 "$secs" "$@"; else "$@"; fi; }

iso_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ"
}

START_ISO=$(iso_timestamp)

normalize_file_path() {
  local p="$1"
  [ -z "$p" ] && return 0
  p="${p//\\//}"
  if [[ "$p" != /* ]] && [[ "$p" != [A-Za-z]:* ]]; then
    p="$(pwd)/$p"
  fi
  if command -v cygpath >/dev/null 2>&1; then
    p=$(cygpath -u "$p" 2>/dev/null || echo "$p")
  fi
  echo "$p"
}

# ==================================================
# 2. EVENT STREAMING VE LOGGING
# ==================================================
emit_event() {
  local event_type="$1"; shift
  local ts; ts=$(iso_timestamp)
  local json
  json=$(jq -cn \
    --arg ev "$event_type" \
    --arg ts "$ts" \
    --arg rid "${RUN_ID:-none}" \
    '{event: $ev, timestamp: $ts, run_id: $rid}' 2>/dev/null)

  while [[ $# -gt 0 ]]; do
    local k="$1"
    local v="$2"
    shift 2
    if [[ "$v" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || [[ "$v" == "true" ]] || [[ "$v" == "false" ]] || [[ "$v" == "null" ]] || [[ "$v" =~ ^\{.*\}$ ]] || [[ "$v" =~ ^\[.*\]$ ]]; then
      json=$(jq -c --arg k "$k" --argjson v "$v" '.[$k] = $v' <<<"$json" 2>/dev/null || jq -c --arg k "$k" --arg v "$v" '.[$k] = $v' <<<"$json")
    else
      json=$(jq -c --arg k "$k" --arg v "$v" '.[$k] = $v' <<<"$json")
    fi
  done

  if [ -n "${RUN_DIR:-}" ] && [ -d "$RUN_DIR" ]; then
    printf '%s\n' "$json" >> "$RUN_DIR/events.ndjson"
  fi

  if [ "${JSON_EVENTS:-false}" = true ]; then
    printf '%s\n' "$json"
  fi
}

emit_event_json() {
  local json_payload="$1"
  local ts; ts=$(iso_timestamp)
  local json
  json=$(jq -c \
    --arg ts "$ts" \
    --arg rid "${RUN_ID:-none}" \
    'if .timestamp == null then .timestamp = $ts else . end |
     if .run_id == null then .run_id = $rid else . end' <<<"$json_payload" 2>/dev/null || echo "$json_payload")

  if [ -n "${RUN_DIR:-}" ] && [ -d "$RUN_DIR" ]; then
    printf '%s\n' "$json" >> "$RUN_DIR/events.ndjson"
  fi

  if [ "${JSON_EVENTS:-false}" = true ]; then
    printf '%s\n' "$json"
  fi
}

log() {
  local ts line; ts=$(date +%H:%M:%S 2>/dev/null || date)
  while IFS= read -r line || [ -n "$line" ]; do
    local formatted="[$ts] $line"
    [ -n "${LOGFILE:-}" ] && printf '%s\n' "$formatted" >> "$LOGFILE" 2>/dev/null
    if [ "${JSON_EVENTS:-false}" = false ]; then
      printf '%s\n' "$formatted"
    else
      printf '%s\n' "$formatted" >&2
    fi
  done <<<"$*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  WARNINGS_LIST+=("$1")
  log "UYARI: $1"
  emit_event "warning" "message" "$1"
}

# ==================================================
# 3. STATE VE FINGERPRINT YÖNETİMİ
# ==================================================
update_state() {
  [ -z "${RUN_DIR:-}" ] && return 0
  [ -d "$RUN_DIR" ] || return 0

  local now_iso; now_iso=$(iso_timestamp)
  local elapsed=$(( $(date +%s) - START_EPOCH ))

  local state_json
  state_json=$(jq -n \
    --arg rid "$RUN_ID" \
    --arg proj "$WORKDIR" \
    --arg status "$CURRENT_STATUS" \
    --arg dec "$CURRENT_DECISION" \
    --arg verif "$CURRENT_VERIF" \
    --arg agent "$CURRENT_AGENT" \
    --arg started "$START_ISO" \
    --arg updated "$now_iso" \
    --arg base "$BASE_HEAD" \
    --arg branch "$BRANCH" \
    --arg orig "$ORIG_REF" \
    --argjson turn "${TURNS_RUN:-1}" \
    --argjson max "$TURNS" \
    --argjson files "${STATS_FILES:-0}" \
    --argjson added "${STATS_ADDED:-0}" \
    --argjson removed "${STATS_REMOVED:-0}" \
    --argjson warns "${WARN_COUNT:-0}" \
    --argjson elapsed "$elapsed" \
    --argjson agents "$AGENTS_JSON_ARRAY" \
    --argjson auto_branch "$AUTO_BRANCH" \
    '{
      run_id: $rid,
      project: $proj,
      status: $status,
      current_turn: $turn,
      max_turns: $max,
      current_agent: $agent,
      verification: $verif,
      decision: $dec,
      files_changed: $files,
      lines_added: $added,
      lines_removed: $removed,
      warnings: $warns,
      started_at: $started,
      updated_at: $updated,
      elapsed_sec: $elapsed,
      agents_enabled: $agents,
      auto_branch: $auto_branch,
      branch: $branch,
      base_head: $base,
      original_ref: $orig
    }' 2>/dev/null)

  printf '%s\n' "$state_json" > "${RUN_DIR}/state.json.tmp" 2>/dev/null && \
    mv -f "${RUN_DIR}/state.json.tmp" "${RUN_DIR}/state.json"

  # Geriye dönük last_run.json
  if [ -n "${LOG_DIR:-}" ] && [ -d "$LOG_DIR" ]; then
    printf '%s\n' "$state_json" > "${LOG_DIR}/last_run.json.tmp" 2>/dev/null && \
      mv -f "${LOG_DIR}/last_run.json.tmp" "${LOG_DIR}/last_run.json"
  fi
}

compute_fingerprint_hash() {
  local base_sha="$1"
  {
    git diff "$base_sha" -- . 2>/dev/null
    while IFS= read -r f || [ -n "$f" ]; do
      [ -z "$f" ] && continue
      [ -f "$f" ] || continue
      printf '=== UNTRACKED: %s ===\n' "$f"
      cat "$f" 2>/dev/null
    done < <(get_untracked)
  } | sha256sum | awk '{print $1}'
}

write_fingerprint() {
  [ -z "${RUN_DIR:-}" ] && return 0
  local fp_hash
  fp_hash=$(compute_fingerprint_hash "$BASE_HEAD")
  local fp_json
  fp_json=$(jq -n \
    --arg rid "$RUN_ID" \
    --arg base "$BASE_HEAD" \
    --arg branch "$BRANCH" \
    --arg orig "$ORIG_REF" \
    --argjson orig_att "$ORIG_ATTACHED" \
    --argjson auto_b "$AUTO_BRANCH" \
    --arg hash "$fp_hash" \
    --arg task "$TASK" \
    '{
      run_id: $rid,
      base_head: $base,
      branch: $branch,
      orig_ref: $orig,
      orig_attached: $orig_att,
      auto_branch: $auto_b,
      diff_hash: $hash,
      task: $task
    }')
  printf '%s\n' "$fp_json" > "${RUN_DIR}/fingerprint.json.tmp" 2>/dev/null && \
    mv -f "${RUN_DIR}/fingerprint.json.tmp" "${RUN_DIR}/fingerprint.json"
}

write_final_report() {
  [ -z "${RUN_DIR:-}" ] && return 0
  local decision_title=""
  case "$CURRENT_DECISION" in
    ready_for_approval) decision_title="READY FOR APPROVAL" ;;
    needs_manual_verification) decision_title="NEEDS MANUAL VERIFICATION" ;;
    needs_another_turn) decision_title="NEEDS ANOTHER TURN" ;;
    blocked) decision_title="BLOCKED" ;;
    max_turns) decision_title="MAX TURNS REACHED" ;;
    failed) decision_title="FAILED" ;;
    interrupted) decision_title="INTERRUPTED" ;;
    accepted) decision_title="ACCEPTED" ;;
    rolled_back) decision_title="ROLLED BACK" ;;
    *) decision_title="$(tr '[:lower:]' '[:upper:]' <<<"$CURRENT_DECISION")" ;;
  esac

  local changed_files_json="[]"
  local files_arr=()
  while IFS=$'\t' read -r status_code filepath || [ -n "$filepath" ]; do
    [ -z "$filepath" ] && continue
    files_arr+=("$(jq -cn --arg p "$filepath" --arg s "$status_code" '{path:$p, status:$s}')")
  done < <(git diff --name-status "$BASE_HEAD" -- 2>/dev/null)
  while IFS= read -r f || [ -n "$f" ]; do
    [ -z "$f" ] && continue
    files_arr+=("$(jq -cn --arg p "$f" --arg s "??" '{path:$p, status:$s}')")
  done < <(get_untracked)

  if [ ${#files_arr[@]} -gt 0 ]; then
    changed_files_json=$(printf '%s\n' "${files_arr[@]}" | jq -s '.' 2>/dev/null || echo "[]")
  fi

  local warns_json="[]"
  if [ ${#WARNINGS_LIST[@]} -gt 0 ]; then
    warns_json=$(printf '%s\n' "${WARNINGS_LIST[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]")
  fi

  local why_json="[]"
  if [ ${#DECISION_WHY[@]} -gt 0 ]; then
    why_json=$(printf '%s\n' "${DECISION_WHY[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]")
  fi

  local total_elapsed=$(( $(date +%s) - START_EPOCH ))

  local report_json
  report_json=$(jq -n \
    --arg rid "$RUN_ID" \
    --arg proj "$WORKDIR" \
    --arg task "$TASK" \
    --arg dec "$CURRENT_DECISION" \
    --arg dec_title "$decision_title" \
    --arg summary "${AGY_SUMMARY:-$FINAL_MSG}" \
    --arg base "$BASE_HEAD" \
    --arg branch "$BRANCH" \
    --arg orig "$ORIG_REF" \
    --arg started_at "${START_ISO:-$(iso_timestamp)}" \
    --arg finished_at "$(iso_timestamp)" \
    --argjson why "$why_json" \
    --arg rv "$LATEST_REVIEW_VERDICT" \
    --argjson blocker "${LATEST_BLOCKER_COUNT:-0}" \
    --argjson major "${LATEST_MAJOR_COUNT:-0}" \
    --argjson minor "${LATEST_MINOR_COUNT:-0}" \
    --arg v_status "$CURRENT_VERIF" \
    --arg v_src "${VERIFY_SOURCE:-none}" \
    --arg v_cmd "${VERIFY_CMD:-}" \
    --argjson v_sec "${VERIFY_DURATION_SEC:-0}" \
    --argjson files "${STATS_FILES:-0}" \
    --argjson added "${STATS_ADDED:-0}" \
    --argjson removed "${STATS_REMOVED:-0}" \
    --argjson binary "${STATS_BINARY:-0}" \
    --argjson total_sec "$total_elapsed" \
    --argjson codex_sec "$CODEX_DURATION_TOTAL" \
    --argjson claude_sec "$CLAUDE_DURATION_TOTAL" \
    --argjson agy_sec "$AGY_DURATION_TOTAL" \
    --argjson warns "$warns_json" \
    --argjson changed "$changed_files_json" \
    --argjson turns "$TURNS_RUN" \
    --argjson max_turns "$TURNS" \
    --argjson agents_enabled "$AGENTS_JSON_ARRAY" \
    --argjson context_chars "$CONTEXT_CHARS" \
    --arg context_file "${CONTEXT_FILE:-}" \
    '{
      run_id: $rid,
      project: $proj,
      task: $task,
      decision: $dec,
      decision_title: $dec_title,
      summary: $summary,
      started_at: $started_at,
      finished_at: $finished_at,
      why: $why,
      agents: {
        codex: {
          enabled: ($agents_enabled | index("codex") != null),
          duration_sec: $codex_sec
        },
        claude: {
          enabled: ($agents_enabled | index("claude") != null),
          verdict: $rv,
          duration_sec: $claude_sec,
          findings: {blocker: $blocker, major: $major, minor: $minor}
        },
        agy: {
          enabled: ($agents_enabled | index("agy") != null),
          duration_sec: $agy_sec
        }
      },
      review: {
        verdict: $rv,
        blocker: $blocker,
        major: $major,
        minor: $minor
      },
      verification: {
        status: $v_status,
        source: $v_src,
        command: $v_cmd,
        duration_sec: $v_sec
      },
      changes: {
        files_changed: $files,
        lines_added: $added,
        lines_removed: $removed,
        binary_files: $binary
      },
      duration: {
        total_sec: $total_sec,
        codex_sec: $codex_sec,
        claude_sec: $claude_sec,
        agy_sec: $agy_sec,
        verification_sec: $v_sec
      },
      warnings: $warns,
      changed_files: $changed,
      next_actions: ["accept", "rollback", "open_log"],
      metadata: {
        context_file: $context_file,
        context_chars: $context_chars,
        turns_run: $turns,
        max_turns: $max_turns,
        base_head: $base,
        branch: $branch,
        original_ref: $orig
      }
    }')

  printf '%s\n' "$report_json" > "${RUN_DIR}/final_report.json.tmp" 2>/dev/null && \
    mv -f "${RUN_DIR}/final_report.json.tmp" "${RUN_DIR}/final_report.json"
}

# ==================================================
# 4. SİNYAL VE GUARD YÖNETİMİ
# ==================================================
handle_interrupt() {
  local exit_code=130
  CURRENT_STATUS="interrupted"
  CURRENT_DECISION="interrupted"
  FINAL_MSG="Kullanıcı tarafından kesildi (INT/TERM)"
  log "!!! Kesildi (INT/TERM)."

  local pids
  pids=$(jobs -p 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill -TERM $pids 2>/dev/null || true
  fi

  local now_sec; now_sec=$(date +%s)
  local total_elapsed=$(( now_sec - START_EPOCH ))

  DECISION_WHY=("Kullanıcı veya GUI Stop butonu tarafından kesildi.")
  if [ -n "${RUN_DIR:-}" ] && [ -d "$RUN_DIR" ]; then
    update_state
    write_fingerprint
    write_final_report
  fi

  emit_event "decision" "status" "interrupted"
  emit_event "run_finished" "status" "interrupted" "duration_sec" "$total_elapsed" "exit_code" 130
  exit 130
}

trap handle_interrupt INT TERM

guard_check() {
  local agent_name="$1"
  local cur_head cur_ref
  cur_head=$(git rev-parse HEAD 2>/dev/null)
  if git symbolic-ref -q HEAD >/dev/null 2>&1; then cur_ref=$(git symbolic-ref --short HEAD); else cur_ref="(detached)"; fi
  if [ "$cur_ref" != "$EXPECT_REF" ]; then
    FINAL_MSG="$agent_name branch/HEAD durumunu değiştirdi (beklenen: $EXPECT_REF, şimdi: $cur_ref). Güvenlik için durduruldu."
    log "HATA: $FINAL_MSG"
    CURRENT_STATUS="failed"
    CURRENT_DECISION="failed"
    DECISION_WHY=("$agent_name git branch/HEAD durumunu değiştirdi.")
    update_state
    write_fingerprint
    write_final_report
    emit_event "agent_failed" "agent" "$(tr '[:upper:]' '[:lower:]' <<<"$agent_name")" "error" "git_tamper"
    emit_event "decision" "status" "failed"
    emit_event "run_finished" "status" "failed" "duration_sec" "$(( $(date +%s) - START_EPOCH ))" "exit_code" 1
    exit 1
  fi
  if [ "$cur_head" != "$BASE_HEAD" ] && [ "$cur_head" != "$HEAD_WARNED" ]; then
    HEAD_WARNED="$cur_head"
    warn "HEAD changed (after $agent_name): an agent may have committed. The diff is still taken against BASE_HEAD."
  fi
  return 0
}

# ==================================================
# 5. REPO İNCELEME VE DIFF FONKSİYONLARI
# ==================================================
DIFF_EXCLUDES=(':(exclude)package-lock.json' ':(exclude)yarn.lock' ':(exclude)pnpm-lock.yaml' ':(exclude)*.min.js')

get_untracked() { git ls-files --others --exclude-standard 2>/dev/null; }

get_file_list() {
  local files stat untracked f
  files=$(git diff --name-status "$BASE_HEAD" -- 2>/dev/null)
  stat=$(git diff --stat "$BASE_HEAD" -- 2>/dev/null)
  untracked=$(get_untracked)
  printf '=== DEĞİŞEN DOSYALAR (BAŞLANGIÇTAN BERİ) ===\n%s\n' "${files:-(İzlenen dosyalarda değişiklik yok)}"
  if [ -n "$untracked" ]; then
    printf '\n=== YENİ (untracked) DOSYALAR ===\n'
    while IFS= read -r f; do printf '??\t%s\n' "$f"; done <<<"$untracked"
  fi
  printf '\n=== DIFF İSTATİSTİĞİ (yalnızca izlenen dosyalar) ===\n%s\n' "${stat:-(Diff yok)}"
}

get_full_diff() {
  local d f n=0
  d=$(git diff "$BASE_HEAD" -- . "${DIFF_EXCLUDES[@]}" 2>/dev/null)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in package-lock.json|yarn.lock|pnpm-lock.yaml|*.min.js) continue ;; esac
    n=$((n + 1))
    if [ "$n" -gt "$MAX_UNTRACKED_FILES" ]; then d+=$'\n'"[... $MAX_UNTRACKED_FILES yeni dosyadan fazlası gösterilmiyor]"; break; fi
    d+=$'\n'"$(git diff --no-index --no-color -- /dev/null "$f" 2>/dev/null | head -c 12000)"
  done <<<"$(get_untracked)"
  if [ "${#d}" -gt "$MAX_DIFF_CHARS" ]; then
    printf '%s\n\n[DIFF KIRPILDI: %s karakterden %s gösteriliyor. Kalanı için dosyaları doğrudan oku.]\n' "${d:0:$MAX_DIFF_CHARS}" "${#d}" "$MAX_DIFF_CHARS"
  else
    printf '%s\n' "${d:-(Diff yok)}"
  fi
}

compute_repo_stats() {
  local added=0 removed=0 binary=0 files_cnt=0
  local f add del

  while IFS=$'\t' read -r add del f || [ -n "$f" ]; do
    [ -z "$f" ] && continue
    files_cnt=$((files_cnt + 1))
    if [ "$add" = "-" ] || [ "$del" = "-" ]; then
      binary=$((binary + 1))
    else
      added=$((added + add))
      removed=$((removed + del))
    fi
  done < <(git diff --numstat "$BASE_HEAD" -- . 2>/dev/null)

  while IFS= read -r f || [ -n "$f" ]; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    files_cnt=$((files_cnt + 1))
    local is_bin=false
    if command -v file >/dev/null 2>&1; then
      if file -b --mime-encoding "$f" 2>/dev/null | grep -qi "binary"; then
        is_bin=true
      fi
    elif perl -e 'exit( -B $ARGV[0] ? 0 : 1 )' "$f" 2>/dev/null; then
      is_bin=true
    fi

    if [ "$is_bin" = true ]; then
      binary=$((binary + 1))
    else
      local lines
      lines=$(wc -l < "$f" 2>/dev/null | tr -d ' ')
      added=$((added + ${lines:-0}))
    fi
  done < <(get_untracked)

  STATS_FILES=$files_cnt
  STATS_ADDED=$added
  STATS_REMOVED=$removed
  STATS_BINARY=$binary
}

# ==================================================
# 6. AJAN TALİMATLARI VE ROLLER
# ==================================================
read -r -d '' COMMON_RULES <<'EOF' || true
[ORTAK KURALLAR — tüm ajanlar için bağlayıcı]
1. GIT: commit, push, stash, checkout, switch, reset, restore, clean, rebase, merge, branch işlemi YAPMA. Yalnızca okuma amaçlı git status / diff / log / show serbest. Repo geçmişini, branch'i ve index'i değiştirme.
2. KAPSAM: Yalnızca görevin gerektirdiği dosyaları değiştir. İlgisiz refactor, toplu yeniden biçimlendirme, dosya taşıma/yeniden adlandırma, bağımlılık ekleme/güncelleme ve lockfile değişikliği YAPMA (görev açıkça istemedikçe).
3. MİMARİ: Mevcut mimariyi, isimlendirmeyi ve design pattern'leri koru. Yeni soyutlamayı yalnızca görev zorunlu kılıyorsa ekle.
4. KÖK NEDEN: Belirtiyi değil nedeni düzelt. Kök nedeni çözmeyen try/catch, null-guard, sleep/retry gibi yamalar ekleme.
5. GÜVENLİK: .env, secret, credential, token dosyalarını okuma/yazma/loglama. Repo dışına yazma. Yıkıcı komut (rm -rf, disk/registry işlemleri) ve ağdan indirilen kodu çalıştırma yok.
6. DÜRÜSTLÜK: Çalıştırmadığın testi "geçti" diye raporlama. Emin olmadığın şeyi "doğrulanmadı" diye belirt. Var olmayan dosya/fonksiyon/API adı uydurma; önce repoda ara.
7. DİL: Raporlarını Türkçe yaz. Kod, identifier ve kod yorumları projenin mevcut diline uysun.
EOF

read -r -d '' CODEX_ROLE <<'EOF' || true
[ROL: DEVELOPER (Codex)]
Amaç: Ana görevi repoda uygulamak.

İş akışı:
1. KEŞİF: İlgili dosyaları, çağrı zincirini ve mevcut testleri oku. Kod yazmadan önce kök nedeni / gereken değişikliği tespit et. Tahminle yazma.
2. PLAN: Hangi dosyalar neden değişecek, kısaca belirle.
3. UYGULA: Minimal ve güvenli değişiklik yap. Bug fix ise, proje test altyapısı varsa regresyon testi ekle; mevcut testleri gerektiği kadar güncelle.
4. KENDİ KONTROLÜN: Projede hızlı doğrulama komutu (build/test/lint) varsa çalıştır. Sandbox engellerse bunu raporla; sessizce atlama.
5. RAPOR (son mesajın): (a) kök neden, (b) değişen dosyalar ve nedenleri, (c) çalıştırılan/çalıştırılamayan komutlar ve sonuçları, (d) bilinen riskler ve yarım kalanlar.

Önceki tur geri bildirimi varsa: yalnızca listelenen açık sorunları çöz. Önceki turda doğrulanmış çalışan kısımları bozma; tekrar yazma.
EOF

read -r -d '' CLAUDE_ROLE <<'EOF' || true
[ROL: REVIEWER (Claude Code) — SALT OKUNUR]
Dosya değiştirme, yazma amaçlı komut çalıştırma. Aşağıdaki diff'i incele; gerekirse repodaki dosyaları oku (çağıran fonksiyonlar, testler, ilgili config).

İncelenecekler:
1. GÖREV UYUMU: Görev tam karşılandı mı? Eksik veya yanlış yorumlanan kısım var mı?
2. DOĞRULUK: Mantık hatası, off-by-one, null/boş durum, async/race, yanlış API kullanımı, syntax/derleme hatası, eksik import.
3. KÖK NEDEN: Değişiklik gerçek nedeni mi çözüyor, yoksa belirtiyi mi örtüyor?
4. REGRESYON: Değişen davranıştan etkilenen çağıranlar ve dosyalar; mevcut testleri kırar mı?
5. KAPSAM İHLALİ: İlgisiz değişiklik, gereksiz refactor, eklenmiş bağımlılık, lockfile değişimi.
6. TEST: Gereken test eklenmiş/güncellenmiş mi?

Çıktı formatı (aynen uy):
## Bulgular
Her bulgu tek madde: [BLOCKER|MAJOR|MINOR] dosya:satır — sorun — önerilen düzeltme.
Yalnızca kodu okuyarak doğruladığın bulguları yaz; doğrulayamadıklarını "[SPEKÜLASYON]" etiketiyle ayır. Bulgu yoksa "Bulgu yok." yaz.
## Antigravity için yapılacaklar
Numaralı, uygulanabilir liste (BLOCKER ve MAJOR öncelikli).
Son satır YALNIZCA şu iki değerden biri olmalı:
VERDICT: APPROVE
VERDICT: CHANGES_REQUESTED
(BLOCKER veya MAJOR varsa CHANGES_REQUESTED.)
EOF

read -r -d '' AGY_ROLE <<'EOF' || true
[ROL: VERIFIER & FIXER (Antigravity)]
Adımlar:
1. DOĞRULA: Reviewer bulgularını kodu okuyarak tek tek doğrula. Yanlış pozitifleri reddet ve summary'de belirt.
2. DÜZELT: Yalnızca doğrulanmış BLOCKER/MAJOR sorunları ve görevin gerektirip eksik kalan kısımları düzelt. Riskli MINOR'ları atla. Reviewer'ın önerisi mimariyi bozuyorsa aynı sonucu veren daha minimal bir çözüm uygula.
3. ÇALIŞTIR: Mümkünse projenin build/test/lint komutlarını çalıştır; her düzeltmeden sonra tekrar çalıştır.
4. KARAR: 'done' YALNIZCA şu koşulların hepsi doğruysa true: görev tam uygulanmış, doğrulanmış BLOCKER/MAJOR kalmamış, verification 'passed' veya 'not_applicable'.

JSON alanları (eksiksiz doldur):
- done: yukarıdaki KARAR koşulu sağlandıysa true, değilse false.
- verification: test/build çalıştı ve geçtiyse 'passed'; görev test gerektirmiyorsa (örn. sadece dokümantasyon) 'not_applicable'; çalıştı ama başarısızsa 'failed'; izin nedeniyle hiç çalıştırılamadıysa 'blocked'.
- permission_blocked: çalıştırılmak istenen bir komut yetki engeline takıldıysa true.
- summary: Türkçe, en fazla ~15 satır. Yapılanlar, reddedilen bulgular ve (done=false ise) Codex için net, madde madde kalan işler.
EOF

AGY_SCHEMA=$(jq -c . <<'EOF'
{
  "type": "object",
  "properties": {
    "done": { "type": "boolean" },
    "verification": { "type": "string", "enum": ["passed", "not_applicable", "failed", "blocked"] },
    "permission_blocked": { "type": "boolean" },
    "summary": { "type": "string" }
  },
  "required": ["done", "verification", "permission_blocked", "summary"]
}
EOF
)

AGY_LIVE_FILTER='fromjson?
  | select(.event=="step_update") | .step_update
  | select(.step_type=="tool" and .state=="DONE")
  | (.tool_info // {}) as $t
  | (try ([($t.parameters // {}) | to_entries[] | .value | tostring] | first // "") catch "") as $p
  | "  ● \(.tool_name // $t.name // "tool") \(($p | gsub("[\r\n]+"; " "))[0:110])"
    + (if $t.error then "  ✗ \($t.error.message // $t.error.type // "hata")" else "" end)'

ver_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]; }

run_agy() {
  local n=$1 errf="$RUN_DIR/t${1}_agy_stderr.txt" streamf="$RUN_DIR/t${1}_agy_stream.ndjson"
  local -a flags=(--mode accept-edits --json-schema "$AGY_SCHEMA" --print-timeout "$(( AGY_TIMEOUT / 60 ))m")
  [ -n "$AGY_MODEL" ]  && flags+=(--model "$AGY_MODEL")
  [ -n "$AGY_EFFORT" ] && flags+=(--effort "$AGY_EFFORT")
  [ "$AGY_SANDBOX" = true ]  && flags+=(--sandbox)
  [ "$AUTO_APPROVE" = true ] && flags+=(--dangerously-skip-permissions)
  AGY_ENV=""; AGY_RC=0

  if [ "$AGY_TRANSPORT" = stream ]; then
    jq -cn --arg c "$AGY_PROMPT" '{event:"user",message:{content:$c}}' \
      | run_t "$(( AGY_TIMEOUT + 60 ))" agy --input-format stream-json --output-format stream-json "${flags[@]}" 2>"$errf" \
      | tee "$streamf" \
      | while IFS= read -r line || [ -n "$line" ]; do
          [ -z "$line" ] && continue
          # Emit agent_tool event if this is a tool step
          local tool_info
          tool_info=$(jq -c 'fromjson? | select(.event=="step_update") | .step_update | select(.step_type=="tool" and .state=="DONE") | {name: (.tool_name // .tool_info.name // "tool"), param: (try ([((.tool_info.parameters // {}) | to_entries[] | .value | tostring)] | first // "") catch "")}' <<<"$line" 2>/dev/null)
          if [ -n "$tool_info" ]; then
            local t_name t_param
            t_name=$(jq -r '.name // "tool"' <<<"$tool_info" 2>/dev/null)
            t_param=$(jq -r '.param // ""' <<<"$tool_info" 2>/dev/null)
            emit_event "agent_tool" "agent" "agy" "turn" "$n" "tool" "$t_name" "summary" "${t_param:0:120}"
          fi
          # Human log
          local formatted
          formatted=$(jq --unbuffered -rR "$AGY_LIVE_FILTER" <<<"$line" 2>/dev/null)
          [ -n "$formatted" ] && log "$formatted"
        done
    AGY_RC=${PIPESTATUS[1]}
    AGY_ENV=$(jq -cR 'fromjson? | select(.event=="result") | .result' "$streamf" 2>/dev/null | tail -n 1)
  else
    AGY_ENV=$(run_t "$(( AGY_TIMEOUT + 60 ))" agy -p "$AGY_PROMPT" --output-format json "${flags[@]}" </dev/null 2>"$errf"); AGY_RC=$?
  fi

  cat "$errf" >> "$LOGFILE" 2>/dev/null
  if [ -n "$AGY_ENV" ]; then
    AGY_ENV=$(jq -c 'if (.structured_output|type)!="object" and (.response|type)=="string"
                     then (try (.structured_output = (.response|fromjson)) catch .) else . end' <<<"$AGY_ENV" 2>/dev/null || printf '%s' "$AGY_ENV")
  fi
}

# ==================================================
# 7. SUBCOMMANDS (DOCTOR, STATUS, REPORT, HISTORY, ACCEPT, ROLLBACK)
# ==================================================
doctor_cmd() {
  local git_avail=false git_ver="" git_path=""
  local codex_avail=false codex_ver="" codex_path=""
  local claude_avail=false claude_ver="" claude_path=""
  local agy_avail=false agy_ver="" agy_path=""
  local jq_avail=false jq_ver="" jq_path=""

  if command -v git >/dev/null 2>&1; then
    git_avail=true
    git_ver=$(git --version 2>/dev/null | head -n1 || echo "")
    git_path=$(which git 2>/dev/null || command -v git 2>/dev/null || echo "")
  fi
  if command -v codex >/dev/null 2>&1; then
    codex_avail=true
    codex_ver=$(codex --version 2>/dev/null | head -n1 || echo "")
    codex_path=$(which codex 2>/dev/null || command -v codex 2>/dev/null || echo "")
  fi
  if command -v claude >/dev/null 2>&1; then
    claude_avail=true
    claude_ver=$(claude --version 2>/dev/null | head -n1 || echo "")
    claude_path=$(which claude 2>/dev/null || command -v claude 2>/dev/null || echo "")
  fi
  if command -v agy >/dev/null 2>&1; then
    agy_avail=true
    agy_ver=$(agy --version 2>/dev/null | head -n1 || echo "")
    agy_path=$(which agy 2>/dev/null || command -v agy 2>/dev/null || echo "")
  fi
  if command -v jq >/dev/null 2>&1; then
    jq_avail=true
    jq_ver=$(jq --version 2>/dev/null | head -n1 || echo "")
    jq_path=$(which jq 2>/dev/null || command -v jq 2>/dev/null || echo "")
  fi

  local ready=false
  if [ "$git_avail" = true ] && [ "$jq_avail" = true ]; then
    if [ "$codex_avail" = true ] || [ "$claude_avail" = true ] || [ "$agy_avail" = true ]; then
      ready=true
    fi
  fi

  jq -n \
    --argjson git_avail "$git_avail" --arg git_ver "$git_ver" --arg git_path "$git_path" \
    --argjson codex_avail "$codex_avail" --arg codex_ver "$codex_ver" --arg codex_path "$codex_path" \
    --argjson claude_avail "$claude_avail" --arg claude_ver "$claude_ver" --arg claude_path "$claude_path" \
    --argjson agy_avail "$agy_avail" --arg agy_ver "$agy_ver" --arg agy_path "$agy_path" \
    --argjson jq_avail "$jq_avail" --arg jq_ver "$jq_ver" --arg jq_path "$jq_path" \
    --argjson ready "$ready" \
    '{
      git: {available: $git_avail, version: $git_ver, path: $git_path, auth: "unknown"},
      codex: {available: $codex_avail, version: $codex_ver, path: $codex_path, auth: "unknown"},
      claude: {available: $claude_avail, version: $claude_ver, path: $claude_path, auth: "unknown"},
      agy: {available: $agy_avail, version: $agy_ver, path: $agy_path, auth: "unknown"},
      jq: {available: $jq_avail, version: $jq_ver, path: $jq_path, auth: "unknown"},
      ready: $ready
    }'
}

status_cmd() {
  local project_dir=""
  local run_id="latest"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_dir="$2"; shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -z "$project_dir" ] && project_dir="$(pwd)"
  if command -v cygpath >/dev/null 2>&1; then project_dir=$(cygpath -u "$project_dir" 2>/dev/null || echo "$project_dir"); fi
  cd "$project_dir" 2>/dev/null || { echo '{"error":"directory_not_found"}' >&2; exit 1; }
  local git_dir
  git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || { echo '{"error":"not_a_git_repo"}' >&2; exit 1; }
  local target_run_dir=""
  if [ "$run_id" = "latest" ] || [ -z "$run_id" ]; then
    target_run_dir=$(find "${git_dir}/ai_bridge" -maxdepth 1 -name "run_*" -type d 2>/dev/null | sort -r | head -n1)
  else
    target_run_dir="${git_dir}/ai_bridge/run_${run_id}"
  fi
  if [ -n "$target_run_dir" ] && [ -f "$target_run_dir/state.json" ]; then
    cat "$target_run_dir/state.json"
  elif [[ "$run_id" == "latest" || -z "$run_id" ]] && [ -f "${git_dir}/ai_bridge/last_run.json" ]; then
    cat "${git_dir}/ai_bridge/last_run.json"
  else
    echo '{"error":"run_not_found"}' >&2
    exit 1
  fi
}

report_cmd() {
  local project_dir=""
  local run_id="latest"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_dir="$2"; shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -z "$project_dir" ] && project_dir="$(pwd)"
  if command -v cygpath >/dev/null 2>&1; then project_dir=$(cygpath -u "$project_dir" 2>/dev/null || echo "$project_dir"); fi
  cd "$project_dir" 2>/dev/null || { echo '{"error":"directory_not_found"}' >&2; exit 1; }
  local git_dir
  git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || { echo '{"error":"not_a_git_repo"}' >&2; exit 1; }
  local target_run_dir=""
  if [ "$run_id" = "latest" ] || [ -z "$run_id" ]; then
    target_run_dir=$(find "${git_dir}/ai_bridge" -maxdepth 1 -name "run_*" -type d 2>/dev/null | sort -r | head -n1)
  else
    target_run_dir="${git_dir}/ai_bridge/run_${run_id}"
  fi
  if [ -n "$target_run_dir" ] && [ -f "$target_run_dir/final_report.json" ]; then
    cat "$target_run_dir/final_report.json"
  else
    echo '{"error":"report_not_found"}' >&2
    exit 1
  fi
}

history_cmd() {
  local project_dir=""
  local limit=50
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_dir="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -z "$project_dir" ] && project_dir="$(pwd)"
  if command -v cygpath >/dev/null 2>&1; then project_dir=$(cygpath -u "$project_dir" 2>/dev/null || echo "$project_dir"); fi
  cd "$project_dir" 2>/dev/null || { echo '[]'; return 0; }
  local git_dir
  git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || { echo '[]'; return 0; }
  local bridge_dir="${git_dir}/ai_bridge"
  [ -d "$bridge_dir" ] || { echo '[]'; return 0; }

  local runs=()
  for r in "$bridge_dir"/run_*; do
    [ -d "$r" ] || continue
    runs+=("$r")
  done

  if [ ${#runs[@]} -eq 0 ]; then
    echo '[]'
    return 0
  fi

  local sorted_runs=()
  readarray -t sorted_runs < <(printf '%s\n' "${runs[@]}" | sort -r)

  local count=0
  local items=()
  for r in "${sorted_runs[@]}"; do
    [ -d "$r" ] || continue
    count=$((count + 1))
    [ "$count" -gt "$limit" ] && break

    local report_file="$r/final_report.json"
    local state_file="$r/state.json"
    local item=""
    if [ -f "$report_file" ]; then
      item=$(jq -c '{
        run_id: .run_id,
        task: (.task[0:120] // ""),
        date: (.started_at // .finished_at // .timestamp // ""),
        decision: (.decision // .status // "unknown"),
        duration_sec: (.duration.total_sec // 0),
        files_changed: (.changes.files_changed // 0),
        verification: (.verification.status // "unknown")
      }' "$report_file" 2>/dev/null)
    elif [ -f "$state_file" ]; then
      item=$(jq -c '{
        run_id: .run_id,
        task: (.task[0:120] // ""),
        date: (.started_at // .updated_at // ""),
        decision: (.decision // .status // "unknown"),
        duration_sec: (.elapsed_sec // 0),
        files_changed: (.files_changed // 0),
        verification: (.verification // "unknown")
      }' "$state_file" 2>/dev/null)
    fi
    [ -n "$item" ] && items+=("$item")
  done

  if [ ${#items[@]} -eq 0 ]; then
    echo '[]'
  else
    printf '%s\n' "${items[@]}" | jq -s '.' 2>/dev/null || echo '[]'
  fi
}

accept_cmd() {
  local project_dir=""
  local run_id="latest"
  local json_events=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_dir="$2"; shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      --json-events) json_events=true; shift ;;
      *) shift ;;
    esac
  done
  [ -z "$project_dir" ] && project_dir="$(pwd)"
  if command -v cygpath >/dev/null 2>&1; then project_dir=$(cygpath -u "$project_dir" 2>/dev/null || echo "$project_dir"); fi
  cd "$project_dir" || exit 1
  local git_dir
  git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || { echo "HATA: Git reposu değil." >&2; exit 1; }
  cd "$(git rev-parse --show-toplevel)" || exit 1

  local target_run_dir=""
  if [ "$run_id" = "latest" ] || [ -z "$run_id" ]; then
    target_run_dir=$(find "${git_dir}/ai_bridge" -maxdepth 1 -name "run_*" -type d 2>/dev/null | sort -r | head -n1)
  else
    target_run_dir="${git_dir}/ai_bridge/run_${run_id}"
  fi

  [ -n "$target_run_dir" ] && [ -d "$target_run_dir" ] || {
    echo "HATA: Run dizini bulunamadı ($run_id)." >&2
    exit 1
  }

  local state_file="$target_run_dir/state.json"
  local fp_file="$target_run_dir/fingerprint.json"
  [ -f "$state_file" ] && [ -f "$fp_file" ] || {
    echo "HATA: state.json veya fingerprint.json bulunamadı: $target_run_dir" >&2
    exit 1
  }

  local cur_status cur_decision
  cur_status=$(jq -r '.status // ""' "$state_file" 2>/dev/null)
  cur_decision=$(jq -r '.decision // ""' "$state_file" 2>/dev/null)

  # Status gate: Yalnız ready_for_approval kabul edilebilir
  if [ "$cur_status" != "ready_for_approval" ] && [ "$cur_decision" != "ready_for_approval" ]; then
    echo "HATA: Yalnızca onay bekleyen (ready_for_approval) bir run kabul edilebilir. Mevcut durum: status=$cur_status, decision=$cur_decision." >&2
    exit 1
  fi

  local fp_base fp_branch fp_auto_branch fp_orig_ref fp_orig_attached fp_hash fp_task
  fp_base=$(jq -r '.base_head // ""' "$fp_file")
  fp_branch=$(jq -r '.branch // ""' "$fp_file")
  fp_auto_branch=$(jq -r '.auto_branch // false' "$fp_file")
  fp_orig_ref=$(jq -r '.orig_ref // ""' "$fp_file")
  fp_orig_attached=$(jq -r '.orig_attached // false' "$fp_file")
  fp_hash=$(jq -r '.diff_hash // ""' "$fp_file")
  fp_task=$(jq -r '.task // "Task"' "$fp_file")

  # Parmak izi kontrolü
  local current_hash
  current_hash=$(compute_fingerprint_hash "$fp_base")
  if [ "$current_hash" != "$fp_hash" ]; then
    echo "HATA: Repo changed after run; manual intervention required." >&2
    exit 1
  fi

  local task_summary
  task_summary=$(printf '%s' "$fp_task" | head -n1 | tr '\r\n' ' ' | cut -c1-60)
  local commit_msg="AI Bridge: ${task_summary:-Gorev uygulandi}"

  if [ "$fp_auto_branch" = true ]; then
    local cur_branch
    cur_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "(detached)")
    if [ "$cur_branch" != "$fp_branch" ]; then
      echo "HATA: Beklenen branch'te değiliz (beklenen: $fp_branch, şu an: $cur_branch). Manuel kontrol gerekli." >&2
      exit 1
    fi
    git add -A || exit 1
    git commit -m "$commit_msg" >/dev/null 2>&1 || { echo "HATA: Commit oluşturulamadı." >&2; exit 1; }

    if [ "$fp_orig_attached" = true ]; then
      git switch "$fp_orig_ref" >/dev/null 2>&1 || { echo "HATA: Orijinal branch'e ($fp_orig_ref) geçilemedi." >&2; exit 1; }
      if git merge --ff-only "$fp_branch" >/dev/null 2>&1; then
        git branch -D "$fp_branch" >/dev/null 2>&1 || true
      else
        echo "UYARI: Fast-forward merge yapılamadı. Değişiklikler '$fp_branch' branch'inde korundu." >&2
      fi
    fi
  else
    git add -A || exit 1
    git commit -m "$commit_msg" >/dev/null 2>&1 || { echo "HATA: Commit oluşturulamadı." >&2; exit 1; }
  fi

  local now_iso; now_iso=$(iso_timestamp)
  # 1. state.json
  jq --arg s "accepted" --arg u "$now_iso" '.status = $s | .decision = $s | .updated_at = $u' "$state_file" > "$state_file.tmp" && mv -f "$state_file.tmp" "$state_file"

  # 2. final_report.json
  local rep_file="$target_run_dir/final_report.json"
  if [ -f "$rep_file" ]; then
    jq --arg s "accepted" --arg t "ACCEPTED" --arg u "$now_iso" \
      '.status = $s | .decision = $s | .decision_title = $t | .updated_at = $u | .next_actions = ["open_log"]' \
      "$rep_file" > "$rep_file.tmp" && mv -f "$rep_file.tmp" "$rep_file"
  fi

  # 3. last_run.json
  local lr_file="${git_dir}/ai_bridge/last_run.json"
  if [ -f "$lr_file" ]; then
    local lr_rid; lr_rid=$(jq -r '.run_id // ""' "$lr_file" 2>/dev/null)
    local cur_rid; cur_rid=$(jq -r '.run_id // ""' "$state_file" 2>/dev/null)
    if [ "$lr_rid" = "$cur_rid" ] || [ -z "$lr_rid" ]; then
      jq --arg s "accepted" --arg u "$now_iso" \
        '.status = $s | .decision = $s | .updated_at = $u' \
        "$lr_file" > "$lr_file.tmp" && mv -f "$lr_file.tmp" "$lr_file"
    fi
  fi

  if [ "$json_events" = true ]; then
    local ts; ts=$(iso_timestamp)
    local r_id; r_id=$(jq -r '.run_id // ""' "$state_file")
    printf '{"event":"decision","timestamp":"%s","run_id":"%s","status":"accepted","message":"Değişiklikler kabul edildi ve commit yapıldı."}\n' "$ts" "$r_id"
  else
    echo "BAŞARILI: Değişiklikler kabul edildi ve commit oluşturuldu."
  fi
}

rollback_cmd() {
  local project_dir=""
  local run_id="latest"
  local json_events=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_dir="$2"; shift 2 ;;
      --run-id) run_id="$2"; shift 2 ;;
      --json-events) json_events=true; shift ;;
      *) shift ;;
    esac
  done
  [ -z "$project_dir" ] && project_dir="$(pwd)"
  if command -v cygpath >/dev/null 2>&1; then project_dir=$(cygpath -u "$project_dir" 2>/dev/null || echo "$project_dir"); fi
  cd "$project_dir" || exit 1
  local git_dir
  git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || { echo "HATA: Git reposu değil." >&2; exit 1; }
  cd "$(git rev-parse --show-toplevel)" || exit 1

  local target_run_dir=""
  if [ "$run_id" = "latest" ] || [ -z "$run_id" ]; then
    target_run_dir=$(find "${git_dir}/ai_bridge" -maxdepth 1 -name "run_*" -type d 2>/dev/null | sort -r | head -n1)
  else
    target_run_dir="${git_dir}/ai_bridge/run_${run_id}"
  fi

  [ -n "$target_run_dir" ] && [ -d "$target_run_dir" ] || {
    echo "HATA: Run dizini bulunamadı ($run_id)." >&2
    exit 1
  }

  local state_file="$target_run_dir/state.json"
  local fp_file="$target_run_dir/fingerprint.json"
  [ -f "$state_file" ] && [ -f "$fp_file" ] || {
    echo "HATA: state.json veya fingerprint.json bulunamadı: $target_run_dir" >&2
    exit 1
  }

  local cur_status
  cur_status=$(jq -r '.status // ""' "$state_file" 2>/dev/null)

  # Rollback guard: accepted run rollback edilemez
  if [ "$cur_status" = "accepted" ]; then
    echo "HATA: Kabul edilmiş (accepted) bir run geri alınamaz." >&2
    exit 1
  fi

  if [ "$cur_status" = "rolled_back" ]; then
    if [ "$json_events" = true ]; then
      local ts; ts=$(iso_timestamp)
      local r_id; r_id=$(jq -r '.run_id // ""' "$state_file")
      printf '{"event":"decision","timestamp":"%s","run_id":"%s","status":"rolled_back","message":"Bu run zaten geri alınmış."}\n' "$ts" "$r_id"
    else
      echo "BİLGİ: Bu run zaten geri alınmış (status=rolled_back)." >&2
    fi
    exit 0
  fi

  local fp_base fp_branch fp_auto_branch fp_orig_ref fp_orig_attached fp_hash
  fp_base=$(jq -r '.base_head // ""' "$fp_file")
  fp_branch=$(jq -r '.branch // ""' "$fp_file")
  fp_auto_branch=$(jq -r '.auto_branch // false' "$fp_file")
  fp_orig_ref=$(jq -r '.orig_ref // ""' "$fp_file")
  fp_orig_attached=$(jq -r '.orig_attached // false' "$fp_file")
  fp_hash=$(jq -r '.diff_hash // ""' "$fp_file")

  # Parmak izi kontrolü
  local current_hash
  current_hash=$(compute_fingerprint_hash "$fp_base")
  if [ "$current_hash" != "$fp_hash" ]; then
    echo "HATA: Repo changed after run; manual intervention required." >&2
    exit 1
  fi

  if [ "$fp_auto_branch" = true ]; then
    git reset --hard "$fp_base" >/dev/null 2>&1 || true
    git clean -fd >/dev/null 2>&1 || true
    if [ "$fp_orig_attached" = true ]; then
      git switch -f "$fp_orig_ref" >/dev/null 2>&1 || git checkout -f "$fp_orig_ref" >/dev/null 2>&1 || true
    else
      git switch -f --detach "$fp_base" >/dev/null 2>&1 || git checkout -f "$fp_base" >/dev/null 2>&1 || true
    fi
    git branch -D "$fp_branch" >/dev/null 2>&1 || true
  else
    git reset --hard "$fp_base" >/dev/null 2>&1 || true
    git clean -fd >/dev/null 2>&1 || true
  fi

  local now_iso; now_iso=$(iso_timestamp)
  # 1. state.json
  jq --arg s "rolled_back" --arg u "$now_iso" '.status = $s | .decision = $s | .updated_at = $u' "$state_file" > "$state_file.tmp" && mv -f "$state_file.tmp" "$state_file"

  # 2. final_report.json
  local rep_file="$target_run_dir/final_report.json"
  if [ -f "$rep_file" ]; then
    jq --arg s "rolled_back" --arg t "ROLLED BACK" --arg u "$now_iso" \
      '.status = $s | .decision = $s | .decision_title = $t | .updated_at = $u | .next_actions = ["open_log"]' \
      "$rep_file" > "$rep_file.tmp" && mv -f "$rep_file.tmp" "$rep_file"
  fi

  # 3. last_run.json
  local lr_file="${git_dir}/ai_bridge/last_run.json"
  if [ -f "$lr_file" ]; then
    local lr_rid; lr_rid=$(jq -r '.run_id // ""' "$lr_file" 2>/dev/null)
    local cur_rid; cur_rid=$(jq -r '.run_id // ""' "$state_file" 2>/dev/null)
    if [ "$lr_rid" = "$cur_rid" ] || [ -z "$lr_rid" ]; then
      jq --arg s "rolled_back" --arg u "$now_iso" \
        '.status = $s | .decision = $s | .updated_at = $u' \
        "$lr_file" > "$lr_file.tmp" && mv -f "$lr_file.tmp" "$lr_file"
    fi
  fi

  if [ "$json_events" = true ]; then
    local ts; ts=$(iso_timestamp)
    local r_id; r_id=$(jq -r '.run_id // ""' "$state_file")
    printf '{"event":"decision","timestamp":"%s","run_id":"%s","status":"rolled_back","message":"Değişiklikler geri alındı."}\n' "$ts" "$r_id"
  else
    echo "BAŞARILI: Değişiklikler temizlendi ve geri alındı."
  fi
}

show_help() {
  cat <<'EOF'
AI Bridge — Multi-Agent Coding Orchestration Backend

Kullanım:
  ai_bridge.sh run [options]
  ai_bridge.sh status --project <path> [--run-id <id>]
  ai_bridge.sh accept --project <path> [--run-id <id>] [--json-events]
  ai_bridge.sh rollback --project <path> [--run-id <id>] [--json-events]
  ai_bridge.sh report --project <path> [--run-id <id>]
  ai_bridge.sh history --project <path> [--limit N]
  ai_bridge.sh doctor

Run Seçenekleri:
  --project <path>            Hedef git repo dizini (varsayılan: aktif dizin)
  --task <text>               Görev prompt metni
  --task-file <path>          Görev prompt dosyası (@dosya)
  --context-file <path>       ChatGPT / Web context dosyası
  --turns <N>                 Maksimum tur sayısı (varsayılan: 3)
  --agents <list>             Aktif ajanlar: codex,claude,agy (varsayılan: codex,claude,agy)
  --verify-cmd <cmd>          Bağımsız doğrulama komutu (örn. 'npm test', 'pytest -q')
  --agy-transport <s|j>       stream (varsayılan) veya json
  --codex-model/--codex-effort    Codex modeli ve reasoning seviyesi (boş = varsayılan)
  --claude-model/--claude-effort  Claude modeli (sonnet|opus|haiku|tam ad) ve effort (low|medium|high|xhigh|max)
  --agy-model/--agy-effort        Antigravity modeli ve effort (low|medium|high)
  --auto-approve <bool>       Antigravity'ye --dangerously-skip-permissions ekle (true/false)
  --auto-branch <bool>        ai-bridge/<zaman> geçici branch'i aç (true/false)
  --json-events               stdout'a yalnızca NDJSON olay akışı basar (GUI modu)

Legacy Kullanım:
  ai_bridge.sh "görev metni" [tur_sayısı] [proje_dizini]
EOF
}

# ==================================================
# 8. SUBCOMMAND YÖNLENDİRME
# ==================================================
MODE="run"
if [ $# -gt 0 ]; then
  case "$1" in
    doctor)
      doctor_cmd
      exit 0
      ;;
    status)
      shift
      status_cmd "$@"
      exit 0
      ;;
    report)
      shift
      report_cmd "$@"
      exit 0
      ;;
    history)
      shift
      history_cmd "$@"
      exit 0
      ;;
    accept)
      shift
      accept_cmd "$@"
      exit 0
      ;;
    rollback)
      shift
      rollback_cmd "$@"
      exit 0
      ;;
    run)
      MODE="run"
      shift
      ;;
    -h|--help|help)
      show_help
      exit 0
      ;;
    *)
      if [[ "$1" == --* ]]; then
        MODE="run"
      else
        MODE="legacy"
      fi
      ;;
  esac
fi

# ==================================================
# 9. RUN ARGÜMAN PARSING
# ==================================================
if [ "$MODE" = "legacy" ]; then
  TASK="${1:-}"
  TURNS="${2:-3}"
  WORKDIR="${3:-$(pwd)}"
  if [ -z "$TASK" ]; then
    echo "HATA: İlk argüman olarak görev/prompt girmelisin." >&2
    exit 1
  fi
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) WORKDIR="$2"; shift 2 ;;
      --task) TASK="$2"; shift 2 ;;
      --task-file) TASK_FILE="$2"; shift 2 ;;
      --context-file) CONTEXT_FILE="$2"; shift 2 ;;
      --turns) TURNS="$2"; shift 2 ;;
      --agents) AGENTS_ARG="$2"; shift 2 ;;
      --verify-cmd) VERIFY_CMD="$2"; shift 2 ;;
      --agy-transport) AGY_TRANSPORT="$2"; shift 2 ;;
      --codex-model) CODEX_MODEL="$2"; shift 2 ;;
      --codex-effort) CODEX_EFFORT="$2"; shift 2 ;;
      --claude-model) CLAUDE_MODEL="$2"; shift 2 ;;
      --claude-effort) CLAUDE_EFFORT="$2"; shift 2 ;;
      --agy-model) AGY_MODEL="$2"; shift 2 ;;
      --agy-effort) AGY_EFFORT="$2"; shift 2 ;;
      --auto-approve) AUTO_APPROVE="$2"; shift 2 ;;
      --auto-branch) AUTO_BRANCH="$2"; shift 2 ;;
      --json-events) JSON_EVENTS=true; shift ;;
      *) echo "HATA: Bilinmeyen parametre: $1" >&2; exit 1 ;;
    esac
  done
fi

# Görev doğrulaması
if [ -n "$TASK" ] && [ -n "$TASK_FILE" ]; then
  if [ "$JSON_EVENTS" = true ]; then
    emit_event "preflight_failed" "reason" "argument_error" "message" "--task and --task-file cannot be used together."
  fi
  echo "HATA: --task ve --task-file aynı anda verilemez." >&2
  exit 1
fi

if [ -n "$TASK_FILE" ]; then
  TASK_FILE=$(normalize_file_path "$TASK_FILE")
  if [ ! -f "$TASK_FILE" ]; then
    if [ "$JSON_EVENTS" = true ]; then
      emit_event "preflight_failed" "reason" "argument_error" "message" "Task file not found: $TASK_FILE"
    fi
    echo "HATA: Task dosyası bulunamadı: $TASK_FILE" >&2
    exit 1
  fi
  TASK=$(<"$TASK_FILE")
fi

if [[ "$TASK" == @* ]]; then
  legacy_task_path=$(normalize_file_path "${TASK:1}")
  if [ -f "$legacy_task_path" ]; then
    TASK=$(<"$legacy_task_path")
  fi
fi
TASK=${TASK//$'\r'/}

if [ -z "$TASK" ]; then
  if [ "$JSON_EVENTS" = true ]; then
    emit_event "preflight_failed" "reason" "argument_error" "message" "A task description is required."
  fi
  echo "HATA: Görev tanımı zorunludur (--task veya --task-file)." >&2
  exit 1
fi

[[ "$TURNS" =~ ^[1-9][0-9]*$ ]] || { echo "HATA: TURNS pozitif tamsayı olmalı." >&2; exit 1; }
[[ "$AGY_TRANSPORT" =~ ^(stream|json)$ ]] || { echo "HATA: AGY_TRANSPORT 'stream' veya 'json' olmalı." >&2; exit 1; }

# Ajan seçimi ayrıştırma
ENABLE_CODEX=false
ENABLE_CLAUDE=false
ENABLE_AGY=false
agents_tmp=()

IFS=',' read -ra AGENT_LIST <<< "$AGENTS_ARG"
for a in "${AGENT_LIST[@]}"; do
  a=$(echo "$a" | tr '[:upper:]' '[:lower:]' | xargs 2>/dev/null || echo "$a" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
  case "$a" in
    codex)
      ENABLE_CODEX=true
      agents_tmp+=('"codex"')
      ;;
    claude|claude-code|reviewer)
      ENABLE_CLAUDE=true
      agents_tmp+=('"claude"')
      ;;
    agy|antigravity)
      ENABLE_AGY=true
      agents_tmp+=('"agy"')
      ;;
    *)
      ;;
  esac
done

if [ "$ENABLE_CODEX" = false ] && [ "$ENABLE_CLAUDE" = false ] && [ "$ENABLE_AGY" = false ]; then
  if [ "$JSON_EVENTS" = true ]; then
    emit_event "preflight_failed" "reason" "argument_error" "message" "At least one agent must be enabled (--agents codex,claude,agy)."
  fi
  echo "HATA: En az bir ajan aktif olmalıdır (--agents codex,claude,agy)." >&2
  exit 1
fi

AGENTS_JSON_ARRAY="[$(IFS=,; echo "${agents_tmp[*]}")]"

# ==================================================
# 10. ÖN KONTROLLER VE REPO BAŞLANGICI
# ==================================================
required_bins=(git jq)
[ "$ENABLE_CODEX" = true ] && required_bins+=(codex)
[ "$ENABLE_CLAUDE" = true ] && required_bins+=(claude)
[ "$ENABLE_AGY" = true ] && required_bins+=(agy)

for c in "${required_bins[@]}"; do
  command -v "$c" >/dev/null 2>&1 || {
    if [ "$JSON_EVENTS" = true ]; then
      emit_event "preflight_failed" "reason" "missing_dependency" "dependency" "$c" "message" "'$c' was not found (it must be on PATH)."
    fi
    echo "HATA: '$c' bulunamadı (PATH'te olmalı)." >&2
    exit 1
  }
done

if [ -n "$CONTEXT_FILE" ]; then
  CONTEXT_FILE=$(normalize_file_path "$CONTEXT_FILE")
fi

if command -v cygpath >/dev/null 2>&1; then WORKDIR=$(cygpath -u "$WORKDIR" 2>/dev/null || echo "$WORKDIR"); fi
cd "$WORKDIR" || { echo "HATA: Dizin bulunamadı: $WORKDIR" >&2; exit 1; }

GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || {
  if [ "$JSON_EVENTS" = true ]; then
    emit_event "preflight_failed" "reason" "not_a_git_repo" "message" "$WORKDIR is not a git repository/worktree."
  fi
  echo "HATA: $WORKDIR Git reposu/worktree değil." >&2
  exit 1
}

cd "$(git rev-parse --show-toplevel)" || exit 1
BASE_HEAD=$(git rev-parse --verify HEAD 2>/dev/null) || {
  if [ "$JSON_EVENTS" = true ]; then
    emit_event "preflight_failed" "reason" "no_initial_commit" "message" "The repository has no commits yet."
  fi
  echo "HATA: Repoda hiç commit yok. Önce bir başlangıç commit'i oluştur." >&2
  exit 1
}

if [ -n "$(git status --porcelain)" ]; then
  if [ "$JSON_EVENTS" = true ]; then
    emit_event "preflight_failed" "reason" "dirty_repository" "message" "The repository has uncommitted changes. Commit or stash them first."
  fi
  echo "HATA: Repoda kaydedilmemiş değişiklikler var. Önce commit veya stash yapın." >&2
  exit 1
fi

# Başlangıç branch'i + çalışma branch'i
ORIG_ATTACHED=false
if git symbolic-ref -q HEAD >/dev/null 2>&1; then
  ORIG_ATTACHED=true
  ORIG_REF=$(git symbolic-ref --short HEAD)
else
  ORIG_REF="$BASE_HEAD"
fi

# Log ve Run dizini kurulumu (Unique RUN_ID: timestamp + PID + random hex)
rand_hex=$(printf '%04x' "$(( (RANDOM ^ $$) & 0xffff ))")
RUN_ID="$(date +%Y%m%d_%H%M%S)_${$}_${rand_hex}"

BRANCH="$ORIG_REF"
if [ "$AUTO_BRANCH" = true ]; then
  BRANCH="ai-bridge/${RUN_ID}"
  git switch -c "$BRANCH" >/dev/null 2>&1 || git checkout -b "$BRANCH" >/dev/null 2>&1 \
    || { echo "HATA: '$BRANCH' branch'i açılamadı." >&2; exit 1; }
fi

if git symbolic-ref -q HEAD >/dev/null 2>&1; then EXPECT_REF=$(git symbolic-ref --short HEAD); else EXPECT_REF="(detached)"; fi

LOG_DIR="${GIT_DIR}/ai_bridge"
RUN_DIR="${LOG_DIR}/run_${RUN_ID}"
mkdir -p "$RUN_DIR"
LOGFILE="${LOG_DIR}/bridge_${RUN_ID}.log"

# Chat context işleme
if [ -n "$CONTEXT_FILE" ]; then
  if [ ! -f "$CONTEXT_FILE" ]; then
    warn "Context file not found: $CONTEXT_FILE"
  else
    raw_ctx=$(<"$CONTEXT_FILE")
    raw_ctx=${raw_ctx//$'\r'/}
    CONTEXT_CHARS=${#raw_ctx}
    if [ "$CONTEXT_CHARS" -gt "$MAX_CONTEXT_CHARS" ]; then
      CONTEXT_TRUNCATED=true
      keep_offset=$(( CONTEXT_CHARS - MAX_CONTEXT_CHARS ))
      raw_ctx="${raw_ctx:$keep_offset:$MAX_CONTEXT_CHARS}"
      warn "Context file has $CONTEXT_CHARS chars, exceeding MAX_CONTEXT_CHARS ($MAX_CONTEXT_CHARS); truncated keeping the most recent part."
      PROCESSED_CONTEXT="[CHAT CONTEXT KIRPILDI: İlk $keep_offset karakter kesildi; son $MAX_CONTEXT_CHARS karakter referans olarak korunuyor.]
$raw_ctx"
    else
      PROCESSED_CONTEXT="$raw_ctx"
    fi
  fi
fi

# Sinyal yakalama
trap handle_interrupt INT TERM

# İlk state ve run_started event
update_state
emit_event "run_started" \
  "project" "$WORKDIR" \
  "max_turns" "$TURNS" \
  "agents" "$AGENTS_JSON_ARRAY" \
  "auto_branch" "$AUTO_BRANCH" \
  "branch" "$BRANCH"

AGY_VER=""
if [ "$ENABLE_AGY" = true ]; then
  AGY_VER=$(run_t 20 agy --version 2>/dev/null </dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -n "$AGY_VER" ]; then
    if [ "$AGY_TRANSPORT" = stream ] && ver_lt "$AGY_VER" "$MIN_AGY_STREAM_VER"; then
      warn "agy $AGY_VER does not support stdin stream-json input (>= $MIN_AGY_STREAM_VER required); falling back to transport=json."
      AGY_TRANSPORT="json"
    elif ver_lt "$AGY_VER" "$MIN_AGY_VER"; then
      warn "agy $AGY_VER < $MIN_AGY_VER: missing headless fixes. Recommended: $REC_AGY_VER ('agy update')."
    fi
  fi
fi

log "=== AI Bridge Başlatıldı: $WORKDIR ==="
log "Görev: $TASK"
log "Maksimum Tur: $TURNS | Branch: $BRANCH | Base: $BASE_HEAD"
log "Ajanlar: $AGENTS_ARG | AUTO_APPROVE=$AUTO_APPROVE | AGY_SANDBOX=$AGY_SANDBOX | VERIFY_CMD=${VERIFY_CMD:-(yok)}"
[ "$ENABLE_AGY" = true ] && log "Antigravity transport: $AGY_TRANSPORT (sürüm: ${AGY_VER:-bilinmiyor})"
[ -n "$CONTEXT_FILE" ] && log "Chat Context: $CONTEXT_CHARS karakter ($CONTEXT_FILE)"
log "Log: $LOGFILE"
log "----------------------------------------"

HANDOFF="İlk tur: Henüz bir değişiklik yapılmadı."
TURN_HISTORY=""
AGY_FAILS=0
EARLY_EXIT=false

# ==================================================
# 11. ANA DÖNGÜ (TUR İŞLEMLERİ)
# ==================================================
for ((i = 1; i <= TURNS; i++)); do
  TURNS_RUN=$i
  CURRENT_STATUS="running"
  CURRENT_DECISION="running"
  update_state

  log ""
  log "TUR $i / $TURNS"
  emit_event "turn_started" "turn" "$i"
  turn_start_sec=$(date +%s)

  # ===== 1) CODEX (Developer) =====
  if [ "$ENABLE_CODEX" = true ]; then
    CURRENT_AGENT="codex"
    update_state
    log "→ Codex çalışıyor..."
    emit_event "agent_started" "agent" "codex" "turn" "$i"
    codex_t_start=$(date +%s)

    CODEX_PROMPT="$COMMON_RULES

$CODEX_ROLE"
    if [ -n "$PROCESSED_CONTEXT" ]; then
      CODEX_PROMPT+="

[CHAT CONTEXT — REFERANS BİLGİSİ (Ajan talimatları ve Ortak Kurallar bundan daha yüksek önceliklidir)]
$PROCESSED_CONTEXT
[/CHAT CONTEXT]"
    fi
    CODEX_PROMPT+="

[ANA GÖREV]
$TASK

[ÖNCEKİ TUR GERİ BİLDİRİMİ / DURUM]
$HANDOFF"

    printf '%s\n' "$CODEX_PROMPT" > "$RUN_DIR/t${i}_codex_prompt.txt"

    codex_extra=()
    [ -n "$CODEX_MODEL" ]  && codex_extra+=(-m "$CODEX_MODEL")
    [ -n "$CODEX_EFFORT" ] && codex_extra+=(-c "model_reasoning_effort=\"$CODEX_EFFORT\"")
    CODEX_OUT=$(printf '%s\n' "$CODEX_PROMPT" | run_t "$CODEX_TIMEOUT" codex -a never exec ${codex_extra[@]+"${codex_extra[@]}"} --sandbox workspace-write - 2>>"$LOGFILE"); CODEX_RC=$?
    codex_duration=$(( $(date +%s) - codex_t_start ))
    CODEX_DURATION_TOTAL=$(( CODEX_DURATION_TOTAL + codex_duration ))
    log "$CODEX_OUT"

    if [ "$CODEX_RC" -ne 0 ]; then
      [ "$CODEX_RC" -eq 124 ] && FINAL_MSG="Codex zaman aşımı (tur $i)" || FINAL_MSG="Codex hata kodu $CODEX_RC (tur $i)"
      log "HATA: $FINAL_MSG"
      emit_event "agent_failed" "agent" "codex" "turn" "$i" "error" "$FINAL_MSG" "duration_sec" "$codex_duration"
      CURRENT_STATUS="failed"
      CURRENT_DECISION="failed"
      DECISION_WHY+=("Codex başarısız oldu: $FINAL_MSG")
      update_state
      write_fingerprint
      write_final_report
      emit_event "decision" "status" "failed"
      emit_event "run_finished" "status" "failed" "duration_sec" "$(( $(date +%s) - START_EPOCH ))" "exit_code" 1
      exit 1
    fi

    emit_event "agent_finished" "agent" "codex" "turn" "$i" "duration_sec" "$codex_duration"
    guard_check "Codex"
    if [ -z "$(git status --porcelain)" ] && git diff --quiet "$BASE_HEAD" -- 2>/dev/null; then
      warn "Codex did not change any files."
    fi
  else
    log "→ Codex ATLANDI (devre dışı)"
    emit_event "agent_skipped" "agent" "codex" "turn" "$i" "reason" "agent_disabled"
  fi

  # Repo istatistiklerini hesapla ve yayınla
  compute_repo_stats
  update_state
  emit_event "repo_stats" \
    "turn" "$i" \
    "files_changed" "$STATS_FILES" \
    "lines_added" "$STATS_ADDED" \
    "lines_removed" "$STATS_REMOVED" \
    "binary_files" "$STATS_BINARY"

  FILE_LIST=$(get_file_list)
  FULL_DIFF=$(get_full_diff)

  # ===== 2) CLAUDE CODE (Reviewer) =====
  if [ "$ENABLE_CLAUDE" = true ]; then
    CURRENT_AGENT="claude"
    update_state
    log ""
    log "→ Claude Reviewer inceliyor (Plan Mode)..."
    emit_event "agent_started" "agent" "claude" "turn" "$i"
    claude_t_start=$(date +%s)

    CLAUDE_PROMPT="$COMMON_RULES

$CLAUDE_ROLE"
    if [ "$ENABLE_CODEX" = false ]; then
      CLAUDE_PROMPT+="

[DİKKAT: Codex bu tur çalıştırılmadı. Doğrudan mevcut repo durumunu ve ana görevi değerlendir; Codex'in çalıştığını varsayma.]"
    fi
    if [ -n "$PROCESSED_CONTEXT" ]; then
      CLAUDE_PROMPT+="

[CHAT CONTEXT — REFERANS BİLGİSİ (Ajan talimatları ve Ortak Kurallar bundan daha yüksek önceliklidir)]
$PROCESSED_CONTEXT
[/CHAT CONTEXT]"
    fi
    CLAUDE_PROMPT+="

[ANA GÖREV]
$TASK

$FILE_LIST

=== TAM DIFF (BASE_HEAD'e göre) ===
$FULL_DIFF"

    printf '%s\n' "$CLAUDE_PROMPT" > "$RUN_DIR/t${i}_claude_prompt.txt"

    claude_extra=()
    [ -n "$CLAUDE_MODEL" ]  && claude_extra+=(--model "$CLAUDE_MODEL")
    [ -n "$CLAUDE_EFFORT" ] && claude_extra+=(--effort "$CLAUDE_EFFORT")
    CLAUDE_OUT=$(printf '%s\n' "$CLAUDE_PROMPT" | run_t "$CLAUDE_TIMEOUT" claude -p ${claude_extra[@]+"${claude_extra[@]}"} --permission-mode plan --allowedTools "Read,Grep,Glob" 2>>"$LOGFILE"); CLAUDE_RC=$?
    claude_duration=$(( $(date +%s) - claude_t_start ))
    CLAUDE_DURATION_TOTAL=$(( CLAUDE_DURATION_TOTAL + claude_duration ))

    if [ "$CLAUDE_RC" -ne 0 ] || [ -z "$CLAUDE_OUT" ]; then
      warn "Claude Reviewer failed (rc=$CLAUDE_RC). Antigravity will perform its own review."
      CLAUDE_OUT="(Reviewer çalıştırılamadı. Değişiklikleri kendin incele.)"
      REVIEW_VERDICT="UNKNOWN"
      LATEST_BLOCKER_COUNT=0
      LATEST_MAJOR_COUNT=0
      LATEST_MINOR_COUNT=0
      emit_event "agent_failed" "agent" "claude" "turn" "$i" "error" "Reviewer exit code $CLAUDE_RC" "duration_sec" "$claude_duration"
    else
      REVIEW_VERDICT=$(printf '%s\n' "$CLAUDE_OUT" | grep -oE 'VERDICT: (APPROVE|CHANGES_REQUESTED)' | tail -1 | sed 's/VERDICT: //')
      REVIEW_VERDICT=${REVIEW_VERDICT:-UNKNOWN}

      LATEST_BLOCKER_COUNT=$(grep -o '\[BLOCKER\]' <<<"$CLAUDE_OUT" | wc -l | tr -d ' ')
      LATEST_MAJOR_COUNT=$(grep -o '\[MAJOR\]' <<<"$CLAUDE_OUT" | wc -l | tr -d ' ')
      LATEST_MINOR_COUNT=$(grep -o '\[MINOR\]' <<<"$CLAUDE_OUT" | wc -l | tr -d ' ')

      emit_event "review_finished" \
        "turn" "$i" \
        "verdict" "$REVIEW_VERDICT" \
        "blocker" "$LATEST_BLOCKER_COUNT" \
        "major" "$LATEST_MAJOR_COUNT" \
        "minor" "$LATEST_MINOR_COUNT"
      emit_event "agent_finished" "agent" "claude" "turn" "$i" "duration_sec" "$claude_duration"
    fi
    log "$CLAUDE_OUT"
    log "Reviewer kararı: $REVIEW_VERDICT (Blocker: $LATEST_BLOCKER_COUNT, Major: $LATEST_MAJOR_COUNT, Minor: $LATEST_MINOR_COUNT)"
    LATEST_REVIEW_VERDICT="$REVIEW_VERDICT"
    guard_check "Claude"
  else
    log ""
    log "→ Claude Reviewer ATLANDI (devre dışı)"
    emit_event "agent_skipped" "agent" "claude" "turn" "$i" "reason" "agent_disabled"
    REVIEW_VERDICT="SKIPPED"
    LATEST_REVIEW_VERDICT="SKIPPED"
    LATEST_BLOCKER_COUNT=0
    LATEST_MAJOR_COUNT=0
    LATEST_MINOR_COUNT=0
    CLAUDE_OUT="(Claude Reviewer bu tur pasif / atlandı. İncelemeyi ve doğrulamayı doğrudan repodaki kodları okuyarak kendin yap.)"
  fi

  # ===== 3) ANTIGRAVITY (Verifier & Fixer) =====
  if [ "$ENABLE_AGY" = true ]; then
    CURRENT_AGENT="agy"
    update_state
    log ""
    log "→ Antigravity doğruluyor ve düzeltiyor... (transport=$AGY_TRANSPORT)"
    emit_event "agent_started" "agent" "agy" "turn" "$i"
    agy_t_start=$(date +%s)

    AGY_ROLE_ADAPTED="$AGY_ROLE"
    if [ "$ENABLE_CODEX" = false ]; then
      AGY_ROLE_ADAPTED="[ROL: PRIMARY IMPLEMENTER & VERIFIER (Antigravity)]
Codex bu tur devre dışı bırakılmıştır.
1. UYGULA: Ana görev henüz repoya uygulanmamışsa veya eksikse, gerekli dosyaları oluştur/düzenle.
2. DOĞRULA VE DÜZELT: Reviewer bulgularını ve kod doğruluğunu denetle.
3. ÇALIŞTIR: Test/derleme komutlarını çalıştır.
4. KARAR: 'done' YALNIZCA görev tam uygulandı ve doğrulandıysa true olmalıdır."
    fi

    if [ "$AGY_TRANSPORT" = stream ]; then
      AGY_PROMPT="$COMMON_RULES

$AGY_ROLE_ADAPTED"
      if [ -n "$PROCESSED_CONTEXT" ]; then
        AGY_PROMPT+="

[CHAT CONTEXT — REFERANS BİLGİSİ (Ajan talimatları ve Ortak Kurallar bundan daha yüksek önceliklidir)]
$PROCESSED_CONTEXT
[/CHAT CONTEXT]"
      fi
      AGY_PROMPT+="

[ANA GÖREV]
$TASK

[CLAUDE REVIEW]
${CLAUDE_OUT:0:30000}

$FILE_LIST

=== TAM DIFF (BASE_HEAD'e göre) ===
$FULL_DIFF"
    else
      AGY_PROMPT="$COMMON_RULES

$AGY_ROLE_ADAPTED"
      if [ -n "$PROCESSED_CONTEXT" ]; then
        AGY_PROMPT+="

[CHAT CONTEXT — REFERANS BİLGİSİ]
${PROCESSED_CONTEXT:0:8000}
[/CHAT CONTEXT]"
      fi
      AGY_PROMPT+="

[ANA GÖREV]
$TASK

[CLAUDE REVIEW]
${CLAUDE_OUT:0:14000}

${FILE_LIST:0:4000}"
      [ "${#AGY_PROMPT}" -gt "$AGY_PROMPT_MAX" ] && AGY_PROMPT="${AGY_PROMPT:0:$AGY_PROMPT_MAX}
[PROMPT KIRPILDI]"
    fi

    printf '%s\n' "$AGY_PROMPT" > "$RUN_DIR/t${i}_agy_prompt.txt"

    run_agy "$i"
    agy_duration=$(( $(date +%s) - agy_t_start ))
    AGY_DURATION_TOTAL=$(( AGY_DURATION_TOTAL + agy_duration ))

    printf '%s\n' "$AGY_ENV" > "$RUN_DIR/t${i}_agy_raw.json"
    guard_check "Antigravity"

    AGY_STATUS=$(jq -r '.status // "INVALID"' <<<"$AGY_ENV" 2>/dev/null) || AGY_STATUS="INVALID"
    [ -z "$AGY_STATUS" ] && AGY_STATUS="INVALID"
    AGY_DONE=$(jq -r 'if (.structured_output.done|type)=="boolean" then .structured_output.done else false end' <<<"$AGY_ENV" 2>/dev/null) || AGY_DONE="false"
    AGY_BLOCKED=$(jq -r 'if (.structured_output.permission_blocked|type)=="boolean" then .structured_output.permission_blocked else true end' <<<"$AGY_ENV" 2>/dev/null) || AGY_BLOCKED="true"
    AGY_VERIF=$(jq -r '.structured_output.verification // "failed"' <<<"$AGY_ENV" 2>/dev/null) || AGY_VERIF="failed"
    AGY_SUMMARY=$(jq -r '.structured_output.summary // ""' <<<"$AGY_ENV" 2>/dev/null) || AGY_SUMMARY=""
    [ -z "$AGY_DONE" ] && AGY_DONE="false"; [ -z "$AGY_BLOCKED" ] && AGY_BLOCKED="true"; [ -z "$AGY_VERIF" ] && AGY_VERIF="failed"

    AGY_HAS_SO=$(jq -r 'if (.structured_output|type)=="object" then "yes" else "no" end' <<<"$AGY_ENV" 2>/dev/null) || AGY_HAS_SO="no"

    if [ "$AGY_STATUS" != "SUCCESS" ] || [ "$AGY_RC" -ne 0 ] || [ "$AGY_HAS_SO" != "yes" ]; then
      AGY_FAILS=$((AGY_FAILS + 1))
      warn "Antigravity returned invalid/empty output (rc=$AGY_RC, status=$AGY_STATUS, structured_output=$AGY_HAS_SO)."
      AGY_DONE="false"; AGY_VERIF="failed"; AGY_BLOCKED="true"
      AGY_SUMMARY="Antigravity bu turda geçerli sonuç üretmedi; doğrulama yapılamadı."
      emit_event "agent_failed" "agent" "agy" "turn" "$i" "error" "invalid_output" "duration_sec" "$agy_duration"
      if [ "$AGY_FAILS" -ge 2 ]; then
        FINAL_MSG="Antigravity art arda 2 turda geçerli sonuç üretmedi"
        log "HATA: $FINAL_MSG"
        CURRENT_STATUS="failed"
        CURRENT_DECISION="failed"
        DECISION_WHY+=("Antigravity art arda 2 turda geçerli sonuç üretemedi.")
        update_state
        write_fingerprint
        write_final_report
        emit_event "decision" "status" "failed"
        emit_event "run_finished" "status" "failed" "duration_sec" "$(( $(date +%s) - START_EPOCH ))" "exit_code" 1
        exit 1
      fi
    else
      AGY_FAILS=0
      emit_event "agent_finished" "agent" "agy" "turn" "$i" "duration_sec" "$agy_duration"
    fi

    log "Antigravity: done=$AGY_DONE | verification=$AGY_VERIF | permission_blocked=$AGY_BLOCKED"
    [ -n "$AGY_SUMMARY" ] && log "Özet: $AGY_SUMMARY"

    # denied_actions: model beyanından üstündür
    AGY_DENIED=$(jq -c '.denied_actions // empty' <<<"$AGY_ENV" 2>/dev/null)
    [ -n "$AGY_DENIED" ] && log "Engellenen eylemler (denied_actions): $AGY_DENIED"

    AGY_HAS_DENIED=false
    if jq -e '
      (.denied_actions? // null) as $d
      | if $d == null then false
        elif (($d|type) == "array" or ($d|type) == "object" or ($d|type) == "string")
          then ($d|length > 0)
        elif ($d|type) == "boolean"
          then $d
        else true
        end
    ' <<<"$AGY_ENV" >/dev/null 2>&1; then
      AGY_HAS_DENIED=true
      AGY_BLOCKED=true
      warn "Antigravity reported denied_actions; permission_blocked was forced to true."
    fi
  else
    log ""
    log "→ Antigravity ATLANDI (devre dışı)"
    emit_event "agent_skipped" "agent" "agy" "turn" "$i" "reason" "agent_disabled"
    AGY_DONE="false"
    AGY_VERIF="unknown"
    AGY_BLOCKED="false"
    AGY_HAS_DENIED=false
    AGY_SUMMARY="Antigravity devre dışı bırakıldı."
  fi

  # Repo stats güncelle
  compute_repo_stats

  # ===== 4) BAĞIMSIZ DOĞRULAMA (VERIFY_CMD) =====
  VERIFY_STATE="tanımlı değil"
  VERIFY_TAIL=""
  VERIFY_RC=""
  if [ -n "$VERIFY_CMD" ]; then
    CURRENT_AGENT="verifier"
    log ""
    log "→ Bağımsız doğrulama: $VERIFY_CMD"
    emit_event "verification_started" "turn" "$i" "command" "$VERIFY_CMD"
    v_t_start=$(date +%s)
    VERIFY_OUT=$(run_t "$VERIFY_TIMEOUT" bash -c "$VERIFY_CMD" 2>&1 </dev/null); VERIFY_RC=$?
    v_duration=$(( $(date +%s) - v_t_start ))
    VERIFY_DURATION_SEC=$v_duration
    printf '%s\n' "$VERIFY_OUT" > "$RUN_DIR/t${i}_verify.txt"
    VERIFY_TAIL=$(printf '%s\n' "$VERIFY_OUT" | tail -n 40)

    if [ "$VERIFY_RC" -eq 0 ]; then
      VERIFY_STATE="GEÇTİ"
      emit_event "verification_finished" "turn" "$i" "status" "passed" "duration_sec" "$v_duration"
    else
      VERIFY_STATE="BAŞARISIZ (rc=$VERIFY_RC)"
      emit_event "verification_finished" "turn" "$i" "status" "failed" "duration_sec" "$v_duration"
    fi
    log "Doğrulama sonucu: $VERIFY_STATE ($v_duration sn)"
    [ "$VERIFY_RC" -ne 0 ] && log "$VERIFY_TAIL"
  fi

  # ===== 5) KARAR MEKANİZMASI =====
  CURRENT_AGENT="none"
  DECISION_WHY=()

  if [ "$ENABLE_AGY" = true ]; then
    VERIFY_SOURCE="ANTIGRAVITY"
    CURRENT_VERIF="$AGY_VERIF"

    if [ "$AGY_STATUS" = "SUCCESS" ] && [ "$AGY_DONE" = "true" ]; then
      if [ -n "$VERIFY_CMD" ]; then
        VERIFY_SOURCE="VERIFY_CMD"
        if [ "$VERIFY_RC" -eq 0 ]; then
          EARLY_EXIT=true
          CURRENT_DECISION="ready_for_approval"
          CURRENT_STATUS="ready_for_approval"
          CURRENT_VERIF="passed(VERIFY_CMD)"
          DECISION_WHY+=("Antigravity done=true bildirdi." "VERIFY_CMD ($VERIFY_CMD) basariyla gecti (rc=0).")
        else
          CURRENT_DECISION="needs_another_turn"
          CURRENT_VERIF="failed"
          DECISION_WHY+=("Antigravity done bildirdi ancak VERIFY_CMD basarisiz oldu (rc=$VERIFY_RC).")
        fi
      elif [ "$AGY_BLOCKED" = "true" ] || [ "$AGY_HAS_DENIED" = "true" ]; then
        CURRENT_DECISION="blocked"
        DECISION_WHY+=("Antigravity yetki engeline takildi (permission_blocked / denied_actions).")
      elif [ "$AGY_VERIF" = "passed" ] || [ "$AGY_VERIF" = "not_applicable" ]; then
        EARLY_EXIT=true
        CURRENT_DECISION="ready_for_approval"
        CURRENT_STATUS="ready_for_approval"
        DECISION_WHY+=("Antigravity tarafindan basariyla dogrulandi (verification=$AGY_VERIF).")
      else
        CURRENT_DECISION="needs_another_turn"
        DECISION_WHY+=("Antigravity dogrulamasi gecmedi (verification=$AGY_VERIF).")
      fi
    elif [ "$AGY_BLOCKED" = "true" ] || [ "$AGY_HAS_DENIED" = "true" ]; then
      CURRENT_DECISION="blocked"
      DECISION_WHY+=("Antigravity yetki engeline takildi.")
    else
      CURRENT_DECISION="needs_another_turn"
      DECISION_WHY+=("Antigravity islemleri henuz tamamlamadi (done=$AGY_DONE).")
    fi
  else
    # Antigravity Devre Dışı Senaryoları
    if [ -n "$VERIFY_CMD" ]; then
      VERIFY_SOURCE="VERIFY_CMD"
      if [ "$VERIFY_RC" -eq 0 ]; then
        CURRENT_VERIF="passed(VERIFY_CMD)"
        if [ "$ENABLE_CODEX" = true ]; then
          if [ "$ENABLE_CLAUDE" = true ] && [ "$REVIEW_VERDICT" != "APPROVE" ]; then
            CURRENT_DECISION="needs_another_turn"
            DECISION_WHY+=("VERIFY_CMD gecti ancak Claude Reviewer CHANGES_REQUESTED verdi.")
          else
            EARLY_EXIT=true
            CURRENT_DECISION="ready_for_approval"
            CURRENT_STATUS="ready_for_approval"
            DECISION_WHY+=("Codex calisti ve VERIFY_CMD basariyla gecti.")
          fi
        else
          CURRENT_DECISION="needs_manual_verification"
          DECISION_WHY+=("VERIFY_CMD gecti ancak Codex calismadi.")
        fi
      else
        CURRENT_VERIF="failed"
        CURRENT_DECISION="needs_another_turn"
        DECISION_WHY+=("VERIFY_CMD basarisiz oldu (rc=$VERIFY_RC).")
      fi
    else
      CURRENT_VERIF="unknown"
      if [ "$ENABLE_CODEX" = true ]; then
        if [ "$ENABLE_CLAUDE" = true ] && [ "$REVIEW_VERDICT" = "APPROVE" ]; then
          EARLY_EXIT=true
          CURRENT_DECISION="needs_manual_verification"
          CURRENT_STATUS="needs_manual_verification"
          DECISION_WHY+=("Codex ve Claude tamamlandi ancak otomatik test/Antigravity olmadigi icin manuel kontrol gerekir.")
        elif [ "$ENABLE_CLAUDE" = false ]; then
          EARLY_EXIT=true
          CURRENT_DECISION="needs_manual_verification"
          CURRENT_STATUS="needs_manual_verification"
          DECISION_WHY+=("Codex degisiklikleri uyguladi; otomatik dogrulayici olmadigi icin manuel kontrol gerekir.")
        else
          CURRENT_DECISION="needs_another_turn"
          DECISION_WHY+=("Claude degisiklik talep etti.")
        fi
      else
        CURRENT_DECISION="needs_another_turn"
        DECISION_WHY+=("Hicbir uygulayici ajan calismadi.")
      fi
    fi
  fi

  turn_duration=$(( $(date +%s) - turn_start_sec ))
  emit_event "decision" "status" "$CURRENT_DECISION"
  emit_event "turn_finished" "turn" "$i" "duration_sec" "$turn_duration"

  update_state
  write_fingerprint

  if [ "$EARLY_EXIT" = true ]; then
    FINAL_STATUS="$CURRENT_DECISION"
    FINAL_MSG="Görev doğrulandı (tur $i)"
    log ""
    log ">>> [ERKEN ÇIKIŞ] $FINAL_MSG. Karar: $CURRENT_DECISION (verification=$CURRENT_VERIF)"
    break
  fi

  TURN_HISTORY="${TURN_HISTORY}
Tur $i: reviewer=$REVIEW_VERDICT, antigravity(done=$AGY_DONE, verification=$AGY_VERIF), VERIFY_CMD=$VERIFY_STATE"
  HANDOFF="Tur $i sonucu — tamamlanmadı, aşağıdaki açık işleri çöz.
- Reviewer kararı: $REVIEW_VERDICT
- Antigravity: done=$AGY_DONE, verification=$AGY_VERIF, blocked=$AGY_BLOCKED
- Bağımsız doğrulama: $VERIFY_STATE

[Antigravity özeti]
$AGY_SUMMARY

[Reviewer bulguları]
${CLAUDE_OUT:0:6000}
$( [ -n "$VERIFY_TAIL" ] && [ "$VERIFY_RC" != "0" ] && printf '\n[Doğrulama çıktısı (son satırlar)]\n%s\n' "$VERIFY_TAIL" )
[Şimdiye kadarki turlar]$TURN_HISTORY

Repo şu an (BASE_HEAD'e göre):
$(get_file_list)"
done

# ==================================================
# 12. KAPANIŞ VE RAPOR
# ==================================================
log ""
if [ "$EARLY_EXIT" = true ]; then
  EXIT_CODE=0
else
  if [ "$CURRENT_DECISION" = "running" ] || [ "$CURRENT_DECISION" = "needs_another_turn" ]; then
    CURRENT_DECISION="max_turns"
    CURRENT_STATUS="max_turns"
    FINAL_MSG="Tur limiti doldu, görev doğrulanmadı. Manuel kontrol gerekli."
    DECISION_WHY+=("Maksimum tur ($TURNS) limitine ulasildi.")
  fi
  log "!!! $FINAL_MSG"
  EXIT_CODE=2
fi

update_state
write_fingerprint
write_final_report

total_run_duration=$(( $(date +%s) - START_EPOCH ))
emit_event "run_finished" \
  "status" "$CURRENT_DECISION" \
  "duration_sec" "$total_run_duration" \
  "exit_code" "$EXIT_CODE"

log "=== İşlem Tamamlandı ($CURRENT_DECISION). Log: $LOGFILE ==="
log "İncele : git -C \"$WORKDIR\" diff $BASE_HEAD   (yeni dosyalar: git status)"
log "Kabul  : ai_bridge.sh accept --project \"$WORKDIR\" --run-id \"$RUN_ID\""
log "Reddet : ai_bridge.sh rollback --project \"$WORKDIR\" --run-id \"$RUN_ID\""
[ "$AUTO_BRANCH" = true ] && log "NOT    : Commit etmeden 'git switch' yapmak değişiklikleri orijinal branch'e TAŞIR; geri alma sayılmaz."

exit "$EXIT_CODE"
