#!/usr/bin/env bash
set +x
set -uo pipefail
emit() { if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf '%s\n' "$1" >> "$GITHUB_OUTPUT"; else printf '%s\n' "$1"; fi; }
fail() { echo "::error::$1" >&2; emit "alertRequired=true"; exit 1; }
for tool in jq; do command -v "$tool" >/dev/null 2>&1 || fail "Missing required tool: $tool"; done
[[ -n "${WRITE_OUTCOME:-}" ]] || fail "WRITE_OUTCOME is required"
requested="${REQUESTED_STACKS:-[]}"; rejected="${REJECTED_STACKS:-[]}"; states="${REQUESTED_STATES:-}"
[[ -n "$states" ]] || states='{}'
jq -e 'type == "array" and all(.[]; type == "string")' <<< "$requested" >/dev/null 2>&1 || fail "REQUESTED_STACKS must be a JSON string array"
jq -e 'type == "array" and all(.[]; type == "string")' <<< "$rejected" >/dev/null 2>&1 || fail "REJECTED_STACKS must be a JSON string array"
jq -e 'type == "object"' <<< "$states" >/dev/null 2>&1 || fail "REQUESTED_STATES must be a JSON object"
case "$WRITE_OUTCOME" in
  partial|rejected) selected="$rejected" ;;
  stale-base) selected="$requested" ;;
  succeeded) selected='[]' ;;
  *) echo "::warning::Unrecognized write outcome; reconciling all requested stacks"; selected="$requested" ;;
esac
targets="$(jq -cn --argjson stacks "$selected" --argjson states "$states" 'if all($stacks[]; . as $stack | ($states[$stack] == "started" or $states[$stack] == "stopped")) then [$stacks[] as $stack | {stack:$stack,expectedState:$states[$stack]}] else error("missing or invalid expected state") end' 2>/dev/null)" || fail "A reconciliation target has no valid expected state"
matrix="$(jq -cn --argjson include "$targets" '{include:$include}')" || fail "Cannot encode reconciliation matrix"
emit "stacksJson=$targets"
emit "matrix=$matrix"
emit "alertRequired=false"
