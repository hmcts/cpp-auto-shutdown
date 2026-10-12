#!/usr/bin/env bash
set +x
set -uo pipefail
# Test-only race seam: enabled only with STATE_WRITE_TEST_MODE=1; hook is invoked once before push.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
outcome=script-failure accepted='[]' rejected='[]' base_sha=""
requested='[]' requested_states='{}' output_target="${GITHUB_OUTPUT:-}"
fatal() { echo "::error::$1" >&2; outcome=script-failure; accepted='[]'; rejected='[]'; exit 1; }
emit_outputs() {
  local status=$? alert=false reconcile=false values
  trap - EXIT
  case "$outcome" in partial|rejected|stale-base) reconcile=true;; git-failed|script-failure) alert=true;; succeeded) ;; *) outcome=script-failure; alert=true;; esac
  values="$(jq -cn --arg outcome "$outcome" --argjson alert "$alert" --argjson reconcile "$reconcile" --argjson requested "$requested" --argjson states "$requested_states" --argjson accepted "$accepted" --argjson rejected "$rejected" --arg base "$base_sha" '{writeOutcome:$outcome,alertRequired:$alert,reconciliationRequired:$reconcile,requestedStacks:$requested,requestedStates:$states,acceptedStacks:$accepted,rejectedStacks:$rejected,baseSha:$base}')" || values=''
  if [[ -n "$values" ]]; then
    requested_count="$(printf '%s' "$requested" | jq 'length')"
    accounted_count="$(jq -n --argjson a "$accepted" --argjson r "$rejected" '$a + $r | unique | length')"
    [[ "$requested_count" == "$accounted_count" ]] || echo "::warning::Requested and accounted stack counts differ" >&2
    if [[ -n "$output_target" ]]; then
      printf '%s\n' "$values" | jq -r 'to_entries[] | "\(.key)=\(.value|if type == "string" then . else tojson end)"' >> "$output_target" || echo "::error::Could not write GitHub outputs" >&2
    else
      printf '%s\n' "$values" | jq -r 'to_entries[] | "\(.key)=\(.value|if type == "string" then . else tojson end)"'
    fi
  else
    echo "::error::Could not serialize state writer outputs" >&2
  fi
  return "$status"
}
trap emit_outputs EXIT
for tool in jq node git; do command -v "$tool" >/dev/null 2>&1 || fatal "Required tool is missing: $tool"; done
if [[ -z "${OBSERVATIONS_DIR:-}" || -z "${RESULTS_DIR:-}" ]]; then fatal "OBSERVATIONS_DIR and RESULTS_DIR must be set"; fi
# No artifact downloaded (every child unverifiable) is an empty directory, not a fault.
mkdir -p "$OBSERVATIONS_DIR" || fatal "Cannot create observations directory"
mkdir -p "$RESULTS_DIR" || fatal "Cannot create results directory"
normalized="$(node --input-type=module - "${REQUESTED_STACKS:-}" <<'NODE'
const raw = process.argv[2] ?? "";
let stacks = [];
let states = {};
if (raw.trim().startsWith("[")) {
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("requested stack array must contain strings");
  stacks = values.map(value => value.trim().toUpperCase());
} else if (raw.trim()) {
  for (const item of raw.split(",")) {
    const [name, state, ...rest] = item.trim().split(":");
    const stack = name?.trim().toUpperCase();
    if (!stack || rest.length || !["started", "stopped"].includes(state)) throw new Error("requested stack must use stack:started|stopped");
    stacks.push(stack); states[stack] = state;
  }
}
if (stacks.some(stack => !/^[A-Z0-9_-]+$/.test(stack))) throw new Error("invalid requested stack name");
stacks = [...new Set(stacks)].sort();
states = Object.fromEntries(Object.entries(states).sort(([a], [b]) => a.localeCompare(b)));
process.stdout.write(JSON.stringify({ stacks, states }));
NODE
)" || fatal "Invalid REQUESTED_STACKS"
requested="$(printf '%s' "$normalized" | jq -c '.stacks')"
requested_states="$(printf '%s' "$normalized" | jq -c '.states')"
MAX_RETRIES="${MAX_RETRIES:-3}"; RETRY_SLEEP_MIN="${RETRY_SLEEP_MIN:-2}"; RETRY_SLEEP_MAX="${RETRY_SLEEP_MAX:-10}"
[[ "$MAX_RETRIES" =~ ^[1-9][0-9]*$ && "$RETRY_SLEEP_MIN" =~ ^[0-9]+$ && "$RETRY_SLEEP_MAX" =~ ^[0-9]+$ ]] || fatal "Retry settings must be non-negative integers and MAX_RETRIES positive"
(( RETRY_SLEEP_MAX >= RETRY_SLEEP_MIN )) || fatal "RETRY_SLEEP_MAX must be at least RETRY_SLEEP_MIN"
EXPECTED_RUN_IDS="${EXPECTED_RUN_IDS:-${GITHUB_RUN_ID:-}}"
[[ -n "$EXPECTED_RUN_IDS" ]] || fatal "EXPECTED_RUN_IDS is required"
STATE_BRANCH="${STATE_BRANCH:-main}"
STATE_REPO_DIR="${STATE_REPO_DIR:-$RESULTS_DIR/../state-repo}"
hook_used=false
for ((attempt=1; attempt<=MAX_RETRIES; attempt++)); do
  scratch="$RESULTS_DIR/attempt-$attempt"
  mkdir -p "$scratch" || fatal "Cannot create attempt scratch directory"
  bash "$ROOT/scripts/state/state-write-validate.sh" --observations-dir "$OBSERVATIONS_DIR" --expected-run-ids "$EXPECTED_RUN_IDS" --scratch-dir "$scratch" || fatal "Observation validation failed"
  base_sha="$(jq -er '.baseSha | select(type == "string")' "$scratch/validate-result.json")" || fatal "Validation result is missing or invalid"
  rejected="$(jq -c '.rejectedStacks | unique' "$scratch/validate-result.json")" || fatal "Validation result has invalid rejected stacks"
  bash "$ROOT/scripts/state/state-write-merge.sh" --observations-dir "$OBSERVATIONS_DIR" --scratch-dir "$scratch" || fatal "State merge failed"
  merged="$(jq -er '.acceptedStacks | select(type == "array") | unique' "$scratch/merge-result.json")" || fatal "Merge result is missing or invalid"
  accounted="$(jq -cn --argjson requested "$requested" --argjson merged "$merged" --argjson rejected "$rejected" '$merged + $rejected | unique')" || fatal "Cannot combine stack outcomes"
  missing="$(jq -cn --argjson requested "$requested" --argjson accounted "$accounted" '$requested | map(select(. as $s | $accounted | index($s) == null))')" || fatal "Cannot identify missing observations"
  rejected="$(jq -cn --argjson rejected "$rejected" --argjson missing "$missing" '$rejected + $missing | unique')" || fatal "Cannot combine rejected stacks"
  if [[ "$merged" == '[]' ]]; then outcome=rejected; accepted='[]'; exit 0; fi
  if [[ "${STATE_WRITE_TEST_MODE:-}" == 1 && "$hook_used" == false && -n "${STATE_WRITE_TEST_HOOK_BEFORE_PUSH:-}" ]]; then
    [[ -x "$STATE_WRITE_TEST_HOOK_BEFORE_PUSH" ]] || fatal "Test hook is not executable"
    "$STATE_WRITE_TEST_HOOK_BEFORE_PUSH" || fatal "Test race hook failed"
    hook_used=true
  fi
  bash "$ROOT/scripts/state/state-write-push.sh" --scratch-dir "$scratch"
  push_status=$?
  push_outcome="$(jq -er '.writeOutcome | select(type == "string")' "$scratch/push-result.json" 2>/dev/null)" || fatal "Push result is missing or invalid"
  case "$push_outcome" in
    succeeded)
      accepted="$merged"
      if [[ "$rejected" == '[]' ]]; then outcome=succeeded; else outcome=partial; fi
      exit 0
      ;;
    stale-base)
      accepted='[]'; rejected="$(jq -cn --argjson rejected "$rejected" --argjson merged "$merged" '$rejected + $merged | unique')"
      outcome=stale-base
      if (( attempt < MAX_RETRIES )); then
        range=$((RETRY_SLEEP_MAX - RETRY_SLEEP_MIN + 1)); delay=$((RETRY_SLEEP_MIN + RANDOM % range))
        sleep "$delay"
        continue
      fi
      exit 0
      ;;
    git-failed)
      accepted='[]'; rejected="$(jq -cn --argjson rejected "$rejected" --argjson merged "$merged" '$rejected + $merged | unique')"
      outcome=git-failed; exit 1
      ;;
    *) fatal "Unrecognized push outcome";;
  esac
done
outcome=stale-base; accepted='[]'; exit 0
