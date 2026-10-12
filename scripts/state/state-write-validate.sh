#!/usr/bin/env bash
set +x
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
observations="" expected_ids="" scratch=""
usage() { echo "Usage: state-write-validate.sh --observations-dir D --expected-run-ids A,B --scratch-dir S" >&2; }
fail() { echo "::error::$1" >&2; exit 1; }
while (($#)); do
  if (($# < 2)); then usage; exit 2; fi
  key="$1" value="$2"; shift 2
  case "$key" in
    --observations-dir) observations="$value" ;;
    --expected-run-ids) expected_ids="$value" ;;
    --scratch-dir) scratch="$value" ;;
    *) usage; exit 2 ;;
  esac
done
[[ -d "$observations" && -n "$expected_ids" && -n "$scratch" ]] || { usage; exit 2; }
for tool in git jq node; do command -v "$tool" >/dev/null 2>&1 || fail "required tool is missing: $tool"; done
mkdir -p "$scratch" || fail "cannot create scratch directory"
STATE_BRANCH="${STATE_BRANCH:-main}"
STATE_REPO_DIR="${STATE_REPO_DIR:-$scratch/../state-repo}"
STATE_REPO_URL="${STATE_REPO_URL:-https://github.com/hmcts/cpp-auto-shutdown.git}"
if [[ -n "${STATE_WRITE_TOKEN:-}" ]]; then
  encoded="$(printf 'x-access-token:%s' "$STATE_WRITE_TOKEN" | base64 | tr -d '\r\n')" || fail "cannot encode Git token"
  auth_header="AUTHORIZATION: basic $encoded"
else
  auth_header=""
fi
git_repo() {
  if [[ -n "$auth_header" ]]; then git -c "http.extraheader=$auth_header" -C "$STATE_REPO_DIR" "$@"; else git -C "$STATE_REPO_DIR" "$@"; fi
}
if [[ ! -d "$STATE_REPO_DIR/.git" ]]; then
  if [[ -e "$STATE_REPO_DIR" ]]; then fail "state repository path is not a Git checkout"; fi
  mkdir -p "$(dirname "$STATE_REPO_DIR")" || fail "cannot create repository parent"
  if [[ -n "$auth_header" ]]; then
    git -c "http.extraheader=$auth_header" clone --quiet --branch "$STATE_BRANCH" "$STATE_REPO_URL" "$STATE_REPO_DIR" >/dev/null 2>&1 || fail "state repository clone failed"
  else
    git clone --quiet --branch "$STATE_BRANCH" "$STATE_REPO_URL" "$STATE_REPO_DIR" >/dev/null 2>&1 || fail "state repository clone failed"
  fi
fi
git_repo fetch --quiet origin "$STATE_BRANCH" >/dev/null 2>&1 || fail "state repository fetch failed"
git_repo reset --hard "origin/$STATE_BRANCH" >/dev/null 2>&1 || fail "state repository reset failed"
git_repo clean -fd >/dev/null 2>&1 || fail "state repository clean failed"
base_sha="$(git_repo rev-parse HEAD 2>/dev/null)" || fail "cannot determine state repository base"
[[ "$base_sha" =~ ^[0-9a-f]{40,64}$ ]] || fail "invalid state repository base SHA"
files="$scratch/observation-files.txt"
candidates="$scratch/observation-candidates.txt"
sorted="$scratch/observation-sorted.txt"
survivors="$scratch/observation-survivors.txt"
rejected_file="$scratch/rejected-stacks.txt"
: > "$candidates"; : > "$rejected_file"
find "$observations" -type f -name observation.json | LC_ALL=C sort > "$files" || fail "cannot list observations"
is_expected() { case ",$expected_ids," in *",$1,"*) return 0;; *) return 1;; esac; }
while IFS= read -r file; do
  folder="$(basename "$(dirname "$file")")"
  path_stack="${folder#observation-}"
  if [[ "$path_stack" =~ _[0-9]+$ ]]; then path_stack="${path_stack%_*}"; fi
  path_stack="$(printf '%s' "$path_stack" | tr '[:lower:]' '[:upper:]')"
  record_run="$(jq -er '.sourceRunId | select(type == "number" and floor == .)' "$file" 2>/dev/null)"
  if [[ -z "$record_run" ]]; then printf '%s\n' "$path_stack" >> "$rejected_file"; continue; fi
  if ! is_expected "$record_run"; then rm -f "$file" || fail "cannot discard non-child observation"; continue; fi
  timestamp="$(jq -er '.observedAt | select(type == "string")' "$file" 2>/dev/null)"
  millis="$(node -e 'const value=Date.parse(process.argv[1]); if(!Number.isFinite(value)) process.exit(1); process.stdout.write(String(value))' "$timestamp" 2>/dev/null)" || { printf '%s\n' "$path_stack" >> "$rejected_file"; continue; }
  printf '%s\t%s\t%s\t%s\n' "$path_stack" "$millis" "$record_run" "$file" >> "$candidates"
done < "$files"
LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2nr -k3,3nr "$candidates" > "$sorted" || fail "cannot sort observation candidates"
: > "$survivors"
previous=""
while IFS="$(printf '\t')" read -r path_stack millis record_run file; do
  if [[ "$path_stack" == "$previous" ]]; then rm -f "$file" || fail "cannot discard duplicate observation"; else printf '%s\t%s\n' "$path_stack" "$file" >> "$survivors"; previous="$path_stack"; fi
done < "$sorted"
while IFS="$(printf '\t')" read -r path_stack file; do
  record="$(jq -c . "$file" 2>/dev/null)" || { printf '%s\n' "$path_stack" >> "$rejected_file"; continue; }
  record_stack="$(printf '%s' "$record" | jq -r '.stack // empty')"
  if [[ "$record_stack" != "$path_stack" ]]; then printf '%s\n' "$path_stack" >> "$rejected_file"; continue; fi
  metadata="$(node "$ROOT/scripts/state/config-stack.mjs" "$STATE_REPO_DIR/config/stacks.yaml" "$path_stack" 2>/dev/null)" || { printf '%s\n' "$path_stack" >> "$rejected_file"; continue; }
  environment="$(printf '%s' "$metadata" | jq -r '.environment')"
  wrapper="$scratch/schema-check.json"
  jq -cn --arg environment "$environment" --argjson record "$record" '{environment:$environment,stacks:{($record.stack):$record}}' > "$wrapper" || fail "cannot prepare observation schema check"
  node "$ROOT/scripts/state/schema-validate.mjs" "$STATE_REPO_DIR/schemas/environment-state.schema.json" "$wrapper" >/dev/null 2>&1
  schema_status=$?
  if [[ "$schema_status" -eq 2 ]]; then fail "state schema could not be loaded"; elif [[ "$schema_status" -ne 0 ]]; then printf '%s\n' "$path_stack" >> "$rejected_file"; continue; fi
  live="$STATE_REPO_DIR/state/environments/$environment.json"
  if [[ -f "$live" ]]; then
    node "$ROOT/scripts/state/schema-validate.mjs" "$STATE_REPO_DIR/schemas/environment-state.schema.json" "$live" >/dev/null 2>&1 || fail "live state document is invalid: $environment"
    live_time="$(jq -r --arg stack "$path_stack" '.stacks[$stack].observedAt // empty' "$live")"
    if [[ -n "$live_time" ]]; then
      is_newer="$(node -e 'process.stdout.write(String(Date.parse(process.argv[1]) > Date.parse(process.argv[2])))' "$(printf '%s' "$record" | jq -r '.observedAt')" "$live_time")" || fail "cannot compare observation timestamps"
      [[ "$is_newer" == true ]] || { printf '%s\n' "$path_stack" >> "$rejected_file"; continue; }
    fi
  fi
done < "$survivors"
rejected_json="$(LC_ALL=C sort -u "$rejected_file" | jq -Rsc 'split("\n") | map(select(length > 0))')" || fail "cannot encode rejected stacks"
temporary="$scratch/validate-result.json.tmp.$$"
jq -cn --argjson rejectedStacks "$rejected_json" --arg baseSha "$base_sha" '{rejectedStacks:$rejectedStacks,baseSha:$baseSha}' > "$temporary" || fail "cannot write validation result"
mv "$temporary" "$scratch/validate-result.json" || fail "cannot publish validation result"
echo "::notice::Validated observations against state base $base_sha"
