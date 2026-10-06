#!/usr/bin/env bash
# tests/test_ai_bridge.sh — Full Regression Test Suite for AI Bridge Backend
#
# Tests 28 distinct scenarios with mock CLI binaries.
# No live API keys or external credits required.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_BRIDGE_SH="$(cd "$SCRIPT_DIR/.." && pwd)/ai_bridge.sh"

if [ ! -f "$AI_BRIDGE_SH" ]; then
  echo "HATA: ai_bridge.sh bulunamadı: $AI_BRIDGE_SH" >&2
  exit 1
fi

TEST_TMP_DIR=$(mktemp -d /tmp/ai_bridge_tests_XXXXXX)
MOCK_BIN="$TEST_TMP_DIR/mock_bin"
mkdir -p "$MOCK_BIN"

cleanup_all() {
  rm -rf "$TEST_TMP_DIR"
}
trap cleanup_all EXIT

# ==========================================
# 1. SETUP MOCK BINARIES
# ==========================================
cat <<'EOF' > "$MOCK_BIN/codex"
#!/usr/bin/env bash
if [ "${MOCK_CODEX_FAIL:-0}" = "1" ]; then
  echo "Mock Codex Error" >&2
  exit 1
fi
if [ -n "${MOCK_SLEEP:-}" ] && [ "$MOCK_SLEEP" -gt 0 ] 2>/dev/null; then
  sleep "$MOCK_SLEEP"
fi
if [ -n "${MOCK_CODEX_TOUCH:-}" ]; then
  echo "Codex content" >> "$MOCK_CODEX_TOUCH"
fi
if [ "${MOCK_CODEX_TAMPER:-0}" = "1" ]; then
  git checkout -b unauthorized_branch >/dev/null 2>&1 || true
fi
echo "Mock Codex completed."
exit 0
EOF
chmod +x "$MOCK_BIN/codex"

cat <<'EOF' > "$MOCK_BIN/claude"
#!/usr/bin/env bash
if [ "${MOCK_CLAUDE_FAIL:-0}" = "1" ]; then
  echo "Mock Claude Error" >&2
  exit 1
fi
verdict="${MOCK_CLAUDE_VERDICT:-APPROVE}"
echo "## Bulgular"
if [ "$verdict" = "CHANGES_REQUESTED" ]; then
  echo "[BLOCKER] test.py:10 — Critical issue — fix it"
  echo "[MAJOR] test.py:20 — Major issue — fix it"
else
  echo "[MINOR] test.py:30 — Minor issue — fix it"
fi
echo "## Antigravity için yapılacaklar"
echo "1. Fix issues"
echo "VERDICT: $verdict"
exit 0
EOF
chmod +x "$MOCK_BIN/claude"

cat <<'EOF' > "$MOCK_BIN/agy"
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "1.2.7"
  exit 0
fi
if [ -n "${MOCK_SLEEP:-}" ] && [ "$MOCK_SLEEP" -gt 0 ] 2>/dev/null; then
  sleep "$MOCK_SLEEP"
fi
if [ "${MOCK_AGY_FAIL:-0}" = "1" ]; then
  echo "Mock AGY Error" >&2
  exit 1
fi
if [ "${MOCK_AGY_MALFORMED:-0}" = "1" ]; then
  echo '{"malformed_json": true'
  exit 0
fi
if [ -n "${MOCK_AGY_TOUCH:-}" ]; then
  echo "AGY content" >> "$MOCK_AGY_TOUCH"
fi

done_val="${MOCK_AGY_DONE:-true}"
verif_val="${MOCK_AGY_VERIF:-passed}"
blocked_val="${MOCK_AGY_BLOCKED:-false}"
denied_val="${MOCK_AGY_DENIED:-0}"
summary_val="${MOCK_AGY_SUMMARY:-Mock Antigravity summary}"

denied_actions="[]"
if [ "$denied_val" = "1" ]; then
  denied_actions='[{"action":"command","display_name":"RunCommand"}]'
fi

if [[ "$*" == *"--input-format stream-json"* ]]; then
  echo '{"event":"step_update","step_update":{"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pytest -q"}}}}'
  cat <<SUB_EOF
{"event":"result","result":{"status":"SUCCESS","duration_seconds":1.0,"num_turns":1,"denied_actions":$denied_actions,"structured_output":{"done":$done_val,"verification":"$verif_val","permission_blocked":$blocked_val,"summary":"$summary_val"}}}
SUB_EOF
else
  cat <<SUB_EOF
{"status":"SUCCESS","duration_seconds":1.0,"num_turns":1,"denied_actions":$denied_actions,"structured_output":{"done":$done_val,"verification":"$verif_val","permission_blocked":$blocked_val,"summary":"$summary_val"}}
SUB_EOF
fi
exit 0
EOF
chmod +x "$MOCK_BIN/agy"

ORIG_PATH="$PATH"
export PATH="$MOCK_BIN:$PATH"

TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

init_test_repo() {
  local repo_dir="$TEST_TMP_DIR/repo_$1"
  rm -rf "$repo_dir"
  mkdir -p "$repo_dir"
  cd "$repo_dir" || exit 1
  git init -q
  git config user.name "BridgeTester"
  git config user.email "test@bridge.local"
  echo "# Test Repo" > README.md
  git add README.md
  git commit -m "initial commit" -q
  echo "$repo_dir"
}

run_test() {
  local num="$1"
  local desc="$2"
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  printf '[%02d/37] %s ... ' "$num" "$desc"
}

pass_test() {
  PASSED_TESTS=$((PASSED_TESTS + 1))
  printf '\e[32mPASSED\e[0m\n'
}

fail_test() {
  local reason="${1:-}"
  FAILED_TESTS=$((FAILED_TESTS + 1))
  printf '\e[31mFAILED\e[0m (%s)\n' "$reason"
}

# ==================================================
# TEST SCENARIOS (1 - 28)
# ==================================================

# 1. Legacy CLI syntax
run_test 1 "Legacy CLI syntax: ./ai_bridge.sh 'task' 1 '/repo'"
repo=$(init_test_repo 1)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" "Test task" 1 "$repo" >/dev/null 2>&1
if [ $? -eq 0 ] && [ -f "$repo/.git/ai_bridge/last_run.json" ]; then
  pass_test
else
  fail_test "Exit code or last_run.json missing"
fi

# 2. Run new CLI parse
run_test 2 "New CLI parse: ai_bridge.sh run --project ... --task ... --turns 1"
repo=$(init_test_repo 2)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "New syntax task" --turns 1 >/dev/null 2>&1
if [ $? -eq 0 ]; then pass_test; else fail_test "Exit code non-zero"; fi

# 3. JSON-events stdout yalnız valid NDJSON
run_test 3 "--json-events stdout contains ONLY valid NDJSON lines"
repo=$(init_test_repo 3)
out=$(MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "JSON test" --turns 1 --json-events)
invalid_lines=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  if ! jq -e . >/dev/null 2>&1 <<<"$line"; then
    invalid_lines=$((invalid_lines + 1))
  fi
done <<<"$out"
if [ "$invalid_lines" -eq 0 ] && [ -n "$out" ]; then pass_test; else fail_test "$invalid_lines invalid json lines found"; fi

# 4. Context file reading & embedding
run_test 4 "context-file reading and embedding in prompt"
repo=$(init_test_repo 4)
echo "User chat discussion about bug" > "$TEST_TMP_DIR/chat_ctx_4.txt"
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Context task" --context-file "$TEST_TMP_DIR/chat_ctx_4.txt" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
if grep -q "User chat discussion about bug" "$run_dir"/t1_*_prompt.txt 2>/dev/null; then
  pass_test
else
  fail_test "Context text not found in generated prompts"
fi

# 5. Context truncation
run_test 5 "context truncation when > MAX_CONTEXT_CHARS"
repo=$(init_test_repo 5)
printf '%200s' "" | tr ' ' 'A' > "$TEST_TMP_DIR/large_ctx_5.txt"
MAX_CONTEXT_CHARS=100 MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Truncate task" --context-file "$TEST_TMP_DIR/large_ctx_5.txt" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
if grep -q "CHAT CONTEXT KIRPILDI" "$run_dir"/t1_*_prompt.txt 2>/dev/null; then
  pass_test
else
  fail_test "Truncation message missing from prompt"
fi

# 6. Codex disabled
run_test 6 "Codex disabled (--agents claude,agy)"
repo=$(init_test_repo 6)
out=$(MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "No codex" --agents claude,agy --turns 1 --json-events)
if grep -q '"event":"agent_skipped".*"agent":"codex"' <<<"$out"; then
  pass_test
else
  fail_test "Codex agent_skipped event not found"
fi

# 7. Claude disabled
run_test 7 "Claude disabled (--agents codex,agy)"
repo=$(init_test_repo 7)
out=$(MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "No claude" --agents codex,agy --turns 1 --json-events)
if grep -q '"event":"agent_skipped".*"agent":"claude"' <<<"$out"; then
  pass_test
else
  fail_test "Claude agent_skipped event not found"
fi

# 8. AGY disabled + VERIFY_CMD pass => ready_for_approval
run_test 8 "AGY disabled + VERIFY_CMD pass => ready_for_approval"
repo=$(init_test_repo 8)
bash "$AI_BRIDGE_SH" run --project "$repo" --task "AGY off with verify pass" --agents codex,claude --verify-cmd "exit 0" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
dec=$(jq -r '.decision // ""' "$run_dir/state.json" 2>/dev/null)
if [ "$dec" = "ready_for_approval" ]; then pass_test; else fail_test "Expected ready_for_approval, got: $dec"; fi

# 9. AGY disabled + no VERIFY_CMD => needs_manual_verification
run_test 9 "AGY disabled + no VERIFY_CMD => needs_manual_verification"
repo=$(init_test_repo 9)
bash "$AI_BRIDGE_SH" run --project "$repo" --task "AGY off no verify" --agents codex,claude --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
dec=$(jq -r '.decision // ""' "$run_dir/state.json" 2>/dev/null)
if [ "$dec" = "needs_manual_verification" ]; then pass_test; else fail_test "Expected needs_manual_verification, got: $dec"; fi

# 10. Reviewer APPROVE
run_test 10 "Reviewer APPROVE parsing"
repo=$(init_test_repo 10)
out=$(MOCK_CLAUDE_VERDICT=APPROVE MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Approve test" --turns 1 --json-events)
if grep -q '"event":"review_finished".*"verdict":"APPROVE"' <<<"$out"; then pass_test; else fail_test "APPROVE verdict not parsed"; fi

# 11. Reviewer CHANGES_REQUESTED
run_test 11 "Reviewer CHANGES_REQUESTED parsing"
repo=$(init_test_repo 11)
out=$(MOCK_CLAUDE_VERDICT=CHANGES_REQUESTED MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Changes req test" --turns 1 --json-events)
if grep -q '"event":"review_finished".*"verdict":"CHANGES_REQUESTED"' <<<"$out"; then pass_test; else fail_test "CHANGES_REQUESTED not parsed"; fi

# 12. Denied actions precedence => blocked
run_test 12 "denied_actions overrides model declaration => blocked"
repo=$(init_test_repo 12)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed MOCK_AGY_BLOCKED=false MOCK_AGY_DENIED=1 bash "$AI_BRIDGE_SH" run --project "$repo" --task "Denied actions" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
dec=$(jq -r '.decision // ""' "$run_dir/state.json" 2>/dev/null)
if [ "$dec" = "blocked" ]; then pass_test; else fail_test "Expected blocked, got: $dec"; fi

# 13. AGY malformed JSON on turn 1 handled gracefully
run_test 13 "AGY malformed JSON handled gracefully without crashing"
repo=$(init_test_repo 13)
MOCK_AGY_MALFORMED=1 bash "$AI_BRIDGE_SH" run --project "$repo" --task "Malformed json" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
warns=$(jq -r '.warnings // 0' "$run_dir/state.json" 2>/dev/null)
if [ "$warns" -ge 1 ]; then pass_test; else fail_test "Expected warning count >= 1"; fi

# 14. AGY 2 consecutive invalid outputs => exit 1
run_test 14 "AGY 2 consecutive invalid outputs => run failed exit 1"
repo=$(init_test_repo 14)
MOCK_AGY_MALFORMED=1 bash "$AI_BRIDGE_SH" run --project "$repo" --task "Consecutive fail" --turns 2 >/dev/null 2>&1
rc=$?
if [ $rc -eq 1 ]; then pass_test; else fail_test "Expected exit code 1, got $rc"; fi

# 15. VERIFY_CMD success
run_test 15 "VERIFY_CMD success integration"
repo=$(init_test_repo 15)
out=$(MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Verify success" --verify-cmd "echo 'tests passed'" --turns 1 --json-events)
if grep -q '"event":"verification_finished".*"status":"passed"' <<<"$out"; then pass_test; else fail_test "verification_finished passed event missing"; fi

# 16. VERIFY_CMD failure
run_test 16 "VERIFY_CMD failure integration"
repo=$(init_test_repo 16)
out=$(MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Verify failure" --verify-cmd "exit 1" --turns 1 --json-events)
if grep -q '"event":"verification_finished".*"status":"failed"' <<<"$out"; then pass_test; else fail_test "verification_finished failed event missing"; fi

# 17. Dirty repository refusal
run_test 17 "Dirty repository refusal"
repo=$(init_test_repo 17)
echo "uncommitted change" >> "$repo/README.md"
out=$(bash "$AI_BRIDGE_SH" run --project "$repo" --task "Dirty repo" --turns 1 --json-events 2>/dev/null)
rc=$?
if [ $rc -eq 1 ] && grep -q '"reason":"dirty_repository"' <<<"$out"; then pass_test; else fail_test "Expected exit 1 and preflight_failed dirty_repository"; fi

# 18. Branch / HEAD tamper guard
run_test 18 "branch/HEAD tamper guard triggers failure"
repo=$(init_test_repo 18)
MOCK_CODEX_TAMPER=1 bash "$AI_BRIDGE_SH" run --project "$repo" --task "Tamper test" --turns 1 >/dev/null 2>&1
rc=$?
if [ $rc -eq 1 ]; then pass_test; else fail_test "Expected exit code 1 on tamper guard, got $rc"; fi

# 19. Untracked file stats
run_test 19 "untracked file stats calculated without index modification"
repo=$(init_test_repo 19)
MOCK_CODEX_TOUCH="$repo/untracked_file.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Untracked stats" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
files_cnt=$(jq -r '.changes.files_changed // 0' "$run_dir/final_report.json" 2>/dev/null)
if [ "$files_cnt" -ge 1 ]; then pass_test; else fail_test "Untracked file not included in stats ($files_cnt)"; fi

# 20. Early exit on verification passed
run_test 20 "Early exit on verification passed"
repo=$(init_test_repo 20)
out=$(MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Early exit" --turns 3 --json-events)
ran_turns=$(grep -c '"event":"turn_started"' <<<"$out")
if [ "$ran_turns" -eq 1 ]; then pass_test; else fail_test "Expected 1 turn, ran $ran_turns"; fi

# 21. Max turns exit code 2
run_test 21 "Max turns reached produces exit code 2"
repo=$(init_test_repo 21)
MOCK_AGY_DONE=false bash "$AI_BRIDGE_SH" run --project "$repo" --task "Max turns test" --turns 2 >/dev/null 2>&1
rc=$?
if [ $rc -eq 2 ]; then pass_test; else fail_test "Expected exit code 2, got $rc"; fi

# 22. Ctrl+C => exit code 130
run_test 22 "INT signal interrupt handler => exit 130"
repo=$(init_test_repo 22)
(
  set -m
  MOCK_SLEEP=4 bash "$AI_BRIDGE_SH" run --project "$repo" --task "Interrupt test" --turns 5 >/dev/null 2>&1 &
  pid=$!
  sleep 2
  kill -INT "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null
  exit $?
)
rc=$?
if [ $rc -eq 130 ]; then pass_test; else fail_test "Expected exit 130, got $rc"; fi

# 23. state.json atomic update validity
run_test 23 "state.json structure and atomic update"
repo=$(init_test_repo 23)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Atomic state" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
state_file="$run_dir/state.json"
if [ -f "$state_file" ] && jq -e '.run_id and .status and .verification and .decision' "$state_file" >/dev/null 2>&1; then
  pass_test
else
  fail_test "state.json invalid schema";
fi

# 24. final_report.json validity
run_test 24 "final_report.json schema validity"
repo=$(init_test_repo 24)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Final report" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | sort -r | head -1)
rep_file="$run_dir/final_report.json"
if [ -f "$rep_file" ] && jq -e '.run_id and .decision_title and .changes and .duration and .agents' "$rep_file" >/dev/null 2>&1; then
  pass_test
else
  fail_test "final_report.json missing required keys";
fi

# 25. accept subcommand success
run_test 25 "accept subcommand commits changes"
repo=$(init_test_repo 25)
MOCK_CODEX_TOUCH="$repo/mod.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Accept test" --turns 1 >/dev/null 2>&1
bash "$AI_BRIDGE_SH" accept --project "$repo" >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ -f "$repo/mod.txt" ] && [ -z "$(git -C "$repo" status --porcelain)" ]; then
  pass_test
else
  fail_test "Accept failed or repo not clean (rc=$rc)";
fi

# 26. rollback subcommand success
run_test 26 "rollback subcommand reverts changes cleanly"
repo=$(init_test_repo 26)
MOCK_CODEX_TOUCH="$repo/revert_me.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Rollback test" --turns 1 >/dev/null 2>&1
bash "$AI_BRIDGE_SH" rollback --project "$repo" >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ ! -f "$repo/revert_me.txt" ] && [ -z "$(git -C "$repo" status --porcelain)" ]; then
  pass_test
else
  fail_test "Rollback failed or file still exists (rc=$rc)";
fi

# 27. accept fingerprint mismatch => refuse
run_test 27 "accept fingerprint mismatch => refuse"
repo=$(init_test_repo 27)
MOCK_CODEX_TOUCH="$repo/fp1.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "FP mismatch accept" --turns 1 >/dev/null 2>&1
echo "tamper external edit" >> "$repo/README.md"
out=$(bash "$AI_BRIDGE_SH" accept --project "$repo" 2>&1)
rc=$?
if [ $rc -eq 1 ] && grep -q "Repo changed after run; manual intervention required." <<<"$out"; then
  pass_test
else
  fail_test "Did not refuse on fingerprint mismatch (rc=$rc)";
fi

# 28. rollback fingerprint mismatch => refuse
run_test 28 "rollback fingerprint mismatch => refuse"
repo=$(init_test_repo 28)
MOCK_CODEX_TOUCH="$repo/fp2.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "FP mismatch rollback" --turns 1 >/dev/null 2>&1
echo "tamper external edit" >> "$repo/README.md"
out=$(bash "$AI_BRIDGE_SH" rollback --project "$repo" 2>&1)
rc=$?
if [ $rc -eq 1 ] && grep -q "Repo changed after run; manual intervention required." <<<"$out"; then
  pass_test
else
  fail_test "Did not refuse on fingerprint mismatch (rc=$rc)";
fi

# 29. accepted run rollback => REFUSE, commit korunur
run_test 29 "accepted run rollback => REFUSE, commit korunur"
repo=$(init_test_repo 29)
MOCK_CODEX_TOUCH="$repo/accepted_file.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 29" --turns 1 >/dev/null 2>&1
bash "$AI_BRIDGE_SH" accept --project "$repo" >/dev/null 2>&1
head_before=$(git -C "$repo" rev-parse HEAD)
out=$(bash "$AI_BRIDGE_SH" rollback --project "$repo" 2>&1)
rc=$?
head_after=$(git -C "$repo" rev-parse HEAD)
if [ $rc -eq 1 ] && [ "$head_before" = "$head_after" ] && [ -f "$repo/accepted_file.txt" ]; then
  pass_test
else
  fail_test "Rollback was not refused or commit was altered (rc=$rc)"
fi

# 30. failed/max_turns run accept => REFUSE
run_test 30 "failed/max_turns run accept => REFUSE"
repo=$(init_test_repo 30)
MOCK_AGY_DONE=false bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 30" --turns 1 >/dev/null 2>&1
out=$(bash "$AI_BRIDGE_SH" accept --project "$repo" 2>&1)
rc=$?
if [ $rc -eq 1 ] && grep -q "Yalnızca onay bekleyen" <<<"$out"; then
  pass_test
else
  fail_test "Accept was not refused on max_turns run (rc=$rc)"
fi

# 31. accept --json-events stdout yalnız NDJSON
run_test 31 "accept --json-events stdout contains ONLY valid NDJSON lines"
repo=$(init_test_repo 31)
MOCK_CODEX_TOUCH="$repo/t31.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 31" --turns 1 >/dev/null 2>&1
out=$(bash "$AI_BRIDGE_SH" accept --project "$repo" --json-events 2>/dev/null)
rc=$?
invalid=0
lines_count=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  lines_count=$((lines_count + 1))
  if ! jq -e . >/dev/null 2>&1 <<<"$line"; then
    invalid=$((invalid + 1))
  fi
done <<<"$out"
if [ $rc -eq 0 ] && [ "$invalid" -eq 0 ] && [ "$lines_count" -ge 1 ]; then
  pass_test
else
  fail_test "$invalid invalid json lines, count=$lines_count, rc=$rc"
fi

# 32. rollback --json-events stdout yalnız NDJSON
run_test 32 "rollback --json-events stdout contains ONLY valid NDJSON lines"
repo=$(init_test_repo 32)
MOCK_CODEX_TOUCH="$repo/t32.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 32" --turns 1 >/dev/null 2>&1
out=$(bash "$AI_BRIDGE_SH" rollback --project "$repo" --json-events 2>/dev/null)
rc=$?
invalid=0
lines_count=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  lines_count=$((lines_count + 1))
  if ! jq -e . >/dev/null 2>&1 <<<"$line"; then
    invalid=$((invalid + 1))
  fi
done <<<"$out"
if [ $rc -eq 0 ] && [ "$invalid" -eq 0 ] && [ "$lines_count" -ge 1 ]; then
  pass_test
else
  fail_test "$invalid invalid json lines, count=$lines_count, rc=$rc"
fi

# 33. accept sonrası report/history == accepted
run_test 33 "accept updates final_report and history to accepted"
repo=$(init_test_repo 33)
MOCK_CODEX_TOUCH="$repo/t33.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 33" --turns 1 >/dev/null 2>&1
bash "$AI_BRIDGE_SH" accept --project "$repo" >/dev/null 2>&1
rep=$(bash "$AI_BRIDGE_SH" report --project "$repo" 2>/dev/null)
hist=$(bash "$AI_BRIDGE_SH" history --project "$repo" --limit 1 2>/dev/null)
rep_dec=$(jq -r '.decision // ""' <<<"$rep")
rep_title=$(jq -r '.decision_title // ""' <<<"$rep")
hist_dec=$(jq -r '.[0].decision // ""' <<<"$hist")
if [ "$rep_dec" = "accepted" ] && [ "$rep_title" = "ACCEPTED" ] && [ "$hist_dec" = "accepted" ]; then
  pass_test
else
  fail_test "Expected accepted: rep_dec=$rep_dec, rep_title=$rep_title, hist_dec=$hist_dec"
fi

# 34. rollback sonrası report/history == rolled_back
run_test 34 "rollback updates final_report and history to rolled_back"
repo=$(init_test_repo 34)
MOCK_CODEX_TOUCH="$repo/t34.txt" MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 34" --turns 1 >/dev/null 2>&1
bash "$AI_BRIDGE_SH" rollback --project "$repo" >/dev/null 2>&1
rep=$(bash "$AI_BRIDGE_SH" report --project "$repo" 2>/dev/null)
hist=$(bash "$AI_BRIDGE_SH" history --project "$repo" --limit 1 2>/dev/null)
rep_dec=$(jq -r '.decision // ""' <<<"$rep")
rep_title=$(jq -r '.decision_title // ""' <<<"$rep")
hist_dec=$(jq -r '.[0].decision // ""' <<<"$hist")
if [ "$rep_dec" = "rolled_back" ] && [ "$rep_title" = "ROLLED BACK" ] && [ "$hist_dec" = "rolled_back" ]; then
  pass_test
else
  fail_test "Expected rolled_back: rep_dec=$rep_dec, rep_title=$rep_title, hist_dec=$hist_dec"
fi

# 35. explicit nonexistent status run-id => run_not_found
run_test 35 "explicit nonexistent status run-id => run_not_found + non-zero exit"
repo=$(init_test_repo 35)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task "Test 35" --turns 1 >/dev/null 2>&1
out=$(bash "$AI_BRIDGE_SH" status --project "$repo" --run-id "nonexistent_run_id_9999" 2>&1)
rc=$?
if [ $rc -ne 0 ] && grep -q '"error":"run_not_found"' <<<"$out"; then
  pass_test
else
  fail_test "Expected non-zero exit and run_not_found error, got rc=$rc, out=$out"
fi

# 36. aynı saniyede iki run unique run_id
run_test 36 "two runs in the same second produce unique run_ids and branches"
repo36a=$(init_test_repo 36a)
repo36b=$(init_test_repo 36b)
(
  MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo36a" --task "Task A" --turns 1 >/dev/null 2>&1 &
  pid_a=$!
  MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo36b" --task "Task B" --turns 1 >/dev/null 2>&1 &
  pid_b=$!
  wait "$pid_a" "$pid_b"
)
run_dir_a=$(find "$repo36a/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | head -n1)
run_dir_b=$(find "$repo36b/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | head -n1)
rid_a=$(basename "$run_dir_a")
rid_b=$(basename "$run_dir_b")
if [ -n "$rid_a" ] && [ -n "$rid_b" ] && [ "$rid_a" != "$rid_b" ]; then
  pass_test
else
  fail_test "Run IDs collided or empty: rid_a=$rid_a, rid_b=$rid_b"
fi

# 37. Windows/MSYS task-file normalization
run_test 37 "Windows/MSYS task-file path normalization (--task-file and @file)"
repo=$(init_test_repo 37)
echo "Normalized task text from file" > "$TEST_TMP_DIR/task_win.txt"
win_style_path=$(cygpath -w "$TEST_TMP_DIR/task_win.txt" 2>/dev/null || echo "$TEST_TMP_DIR/task_win.txt")
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo" --task-file "$win_style_path" --turns 1 >/dev/null 2>&1
run_dir=$(find "$repo/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | head -n1)
rep=$(cat "$run_dir/final_report.json" 2>/dev/null)
task_val=$(jq -r '.task // ""' <<<"$rep")

echo "Normalized legacy task text" > "$TEST_TMP_DIR/task_leg.txt"
leg_win_path=$(cygpath -w "$TEST_TMP_DIR/task_leg.txt" 2>/dev/null || echo "$TEST_TMP_DIR/task_leg.txt")
repo37b=$(init_test_repo 37b)
MOCK_AGY_DONE=true MOCK_AGY_VERIF=passed bash "$AI_BRIDGE_SH" run --project "$repo37b" --task "@$leg_win_path" --turns 1 >/dev/null 2>&1
run_dir_b=$(find "$repo37b/.git/ai_bridge" -maxdepth 1 -name "run_*" -type d | head -n1)
rep_b=$(cat "$run_dir_b/final_report.json" 2>/dev/null)
leg_val=$(jq -r '.task // ""' <<<"$rep_b")

if [ "$task_val" = "Normalized task text from file" ] && [ "$leg_val" = "Normalized legacy task text" ]; then
  pass_test
else
  fail_test "Task files not correctly read: task_val='$task_val', leg_val='$leg_val'"
fi

echo "=========================================="
echo "TEST RESULTS: $PASSED_TESTS / $TOTAL_TESTS PASSED ($FAILED_TESTS FAILED)"
echo "=========================================="

if [ "$FAILED_TESTS" -eq 0 ]; then
  exit 0
else
  exit 1
fi
