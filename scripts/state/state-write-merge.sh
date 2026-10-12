#!/usr/bin/env bash
set +x
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
observations="" scratch=""
usage() { echo "Usage: state-write-merge.sh --observations-dir D --scratch-dir S" >&2; }
fail() { echo "::error::$1" >&2; exit 1; }
while (($#)); do
  if (($# < 2)); then usage; exit 2; fi
  key="$1" value="$2"; shift 2
  case "$key" in --observations-dir) observations="$value";; --scratch-dir) scratch="$value";; *) usage; exit 2;; esac
done
[[ -d "$observations" && -d "$scratch" ]] || { usage; exit 2; }
STATE_REPO_DIR="${STATE_REPO_DIR:-$scratch/../state-repo}"
validation="$scratch/validate-result.json"
[[ -f "$validation" ]] || fail "missing validation result"
rejected="$(jq -er '.rejectedStacks | select(type == "array")' "$validation")" || fail "invalid validation result"
files="$scratch/merge-observation-files.txt"
accepted_file="$scratch/merge-accepted.txt"
pipelines_file="$scratch/merge-pipelines.txt"
runs_file="$scratch/merge-runs.txt"
: > "$accepted_file"; : > "$pipelines_file"; : > "$runs_file"
find "$observations" -mindepth 2 -maxdepth 2 -type f -name observation.json | LC_ALL=C sort > "$files" || fail "cannot list observations"
while IFS= read -r file; do
  folder="$(basename "$(dirname "$file")")"
  stack="${folder#observation-}"
  if [[ "$stack" =~ _[0-9]+$ ]]; then stack="${stack%_*}"; fi
  stack="$(printf '%s' "$stack" | tr '[:lower:]' '[:upper:]')"
  if printf '%s' "$rejected" | jq -e --arg stack "$stack" 'index($stack) != null' >/dev/null; then continue; fi
  record="$(jq -c . "$file" 2>/dev/null)" || fail "accepted observation is invalid JSON: $stack"
  [[ "$(printf '%s' "$record" | jq -r '.stack // empty')" == "$stack" ]] || fail "observation path does not match record stack: $stack"
  metadata="$(node "$ROOT/scripts/state/config-stack.mjs" "$STATE_REPO_DIR/config/stacks.yaml" "$stack" 2>/dev/null)" || fail "accepted stack is not configured: $stack"
  environment="$(printf '%s' "$metadata" | jq -r '.environment')"
  state_file="$STATE_REPO_DIR/state/environments/$environment.json"
  node --input-type=module - "$state_file" "$environment" "$stack" "$record" <<'NODE' || fail "cannot merge state record: $stack"
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [path, environment, stack, text] = process.argv.slice(2);
let document;
try { document = JSON.parse(readFileSync(path, "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  document = { environment, stacks: {} };
}
const record = JSON.parse(text);
document.stacks[stack] = record;
const temporary = `${path}.tmp.${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
renameSync(temporary, path);
NODE
  node "$ROOT/scripts/state/schema-validate.mjs" "$STATE_REPO_DIR/schemas/environment-state.schema.json" "$state_file" >/dev/null 2>&1 || fail "merged state failed schema validation: $environment"
  printf '%s\n' "$stack" >> "$accepted_file"
  printf '%s\n' "$(printf '%s' "$record" | jq -r '.sourcePipeline')" >> "$pipelines_file"
  printf '%s\n' "$(printf '%s' "$record" | jq -r '.sourceRunId')" >> "$runs_file"
done < "$files"
accepted_json="$(LC_ALL=C sort -u "$accepted_file" | jq -Rsc 'split("\n") | map(select(length > 0))')" || fail "cannot encode accepted stacks"
pipelines_json="$(LC_ALL=C sort -nu "$pipelines_file" | jq -Rsc 'split("\n") | map(select(length > 0) | tonumber)')" || fail "cannot encode source pipelines"
runs_json="$(LC_ALL=C sort -nu "$runs_file" | jq -Rsc 'split("\n") | map(select(length > 0) | tonumber)')" || fail "cannot encode source run ids"
temporary="$scratch/merge-result.json.tmp.$$"
jq -cn --argjson acceptedStacks "$accepted_json" --argjson sourcePipelines "$pipelines_json" --argjson sourceRunIds "$runs_json" '{acceptedStacks:$acceptedStacks,sourcePipelines:$sourcePipelines,sourceRunIds:$sourceRunIds}' > "$temporary" || fail "cannot write merge result"
mv "$temporary" "$scratch/merge-result.json" || fail "cannot publish merge result"
echo "::notice::Merged accepted state observations"
