#!/usr/bin/env bash
set +x
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stack="" pipeline="" expected="" simulate="" output_dir="" run_id="${GITHUB_RUN_ID:-0}" requested="true"
config="$ROOT/config/stacks.yaml"
usage() { echo "Usage: observation-create.sh --stack S --pipeline 402|404 --expected-state started|stopped --simulate MODE --output-dir D [--run-id N] [--requested true|false] [--config FILE]" >&2; }
fail() { echo "::error::$1" >&2; exit "${2:-2}"; }
while (($#)); do
  if (($# < 2)); then usage; exit 2; fi
  key="$1" value="$2"; shift 2
  case "$key" in
    --stack) stack="$value" ;;
    --pipeline) pipeline="$value" ;;
    --expected-state) expected="$value" ;;
    --simulate) simulate="$value" ;;
    --output-dir) output_dir="$value" ;;
    --run-id) run_id="$value" ;;
    --requested) requested="$value" ;;
    --config) config="$value" ;;
    *) usage; exit 2 ;;
  esac
done
[[ -n "$stack" && -n "$pipeline" && -n "$expected" && -n "$simulate" && -n "$output_dir" ]] || { usage; exit 2; }
[[ "$pipeline" == 402 || "$pipeline" == 404 ]] || fail "pipeline must be 402 or 404"
[[ "$expected" == started || "$expected" == stopped ]] || fail "expected state must be started or stopped"
[[ "$run_id" =~ ^[0-9]+$ ]] || fail "run id must be a non-negative integer"
[[ "$requested" == true || "$requested" == false ]] || fail "requested must be true or false"
case "$simulate" in success|action-failed|partial) ;; unverifiable:*) ;; *) fail "unsupported simulation mode: $simulate";; esac
metadata="$(node "$ROOT/scripts/state/config-stack.mjs" "$config" "$stack")" || exit "$?"
stack_id="$(printf '%s' "$metadata" | jq -r '.id')"
environment="$(printf '%s' "$metadata" | jq -r '.environment')"
declared="$(printf '%s' "$metadata" | jq -c '.components')"
first="$(printf '%s' "$declared" | jq -r '.[0]')"
unverifiable=""
if [[ "$simulate" == unverifiable:* ]]; then
  unverifiable="${simulate#unverifiable:}"
  case "$unverifiable" in aks|iaas|paas) ;; *) fail "unknown component in unverifiable mode: $unverifiable";; esac
  if ! printf '%s' "$declared" | jq -e --arg name "$unverifiable" 'any(.[]; ascii_downcase == $name)' >/dev/null; then
    fail "unverifiable component is not declared for $stack_id: $unverifiable"
  fi
fi
mkdir -p "$output_dir/observation-$(printf '%s' "$stack" | tr '[:upper:]' '[:lower:]')" || fail "cannot create observation directory" 1
directory="$output_dir/observation-$(printf '%s' "$stack" | tr '[:upper:]' '[:lower:]')"
if [[ -n "$unverifiable" ]]; then
  echo "::warning::No observation created because $unverifiable could not be verified"
  exit 1
fi
components='{}'
aggregate=""
for component in $(printf '%s' "$declared" | jq -r '.[]'); do
  key="$(printf '%s' "$component" | tr '[:upper:]' '[:lower:]')"
  status="$expected"
  if [[ "$simulate" == action-failed ]] || { [[ "$simulate" == partial && "$component" == "$first" ]]; }; then
    [[ "$expected" == started ]] && status=stopped || status=started
  fi
  reason="Simulated observation reports $status"
  [[ "$simulate" == action-failed ]] && reason="Simulated action failure; observed $status"
  [[ "$simulate" == partial && "$component" == "$first" ]] && reason="Simulated partial observation reports $status"
  fragment="$(jq -cn --argjson requested "$requested" --arg status "$status" --arg reason "$reason" '{requested:$requested,status:$status,verified:true,reason:$reason}')" || fail "cannot create component fragment" 1
  components="$(printf '%s' "$components" | jq -c --arg key "$key" --argjson fragment "$fragment" '. + {($key):$fragment}')" || fail "cannot assemble component fragment" 1
  if [[ -z "$aggregate" ]]; then aggregate="$status"; elif [[ "$aggregate" != "$status" ]]; then aggregate=partial; fi
done
[[ -n "$aggregate" ]] || fail "stack has no declared components"
for key in aks iaas paas; do
  if ! printf '%s' "$declared" | jq -e --arg key "$key" 'any(.[]; ascii_downcase == $key)' >/dev/null; then
    components="$(printf '%s' "$components" | jq -c --arg key "$key" '. + {($key):null}')" || fail "cannot add unused component" 1
  fi
done
observed_at="$(node -e 'process.stdout.write(new Date().toISOString())')" || fail "cannot create observation timestamp" 1
record="$(jq -cn --arg stack "$stack_id" --argjson declared "$declared" --arg aggregate "$aggregate" --arg observedAt "$observed_at" --argjson pipeline "$pipeline" --argjson runId "$run_id" --argjson components "$components" '{stack:$stack,stackComponents:$declared,aggregateStatus:$aggregate,observedAt:$observedAt,sourcePipeline:$pipeline,sourceRunId:$runId,components:$components}')" || fail "cannot create observation" 1
temporary="$directory/observation.json.tmp.$$"
validation="$directory/validation.json.tmp.$$"
jq -cn --arg environment "$environment" --argjson record "$record" '{environment:$environment,stacks:{($record.stack):$record}}' > "$validation" || fail "cannot wrap observation for validation" 1
if ! node "$ROOT/scripts/state/schema-validate.mjs" "$ROOT/schemas/environment-state.schema.json" "$validation"; then
  rm -f "$validation" "$temporary"
  fail "assembled observation failed schema validation" 1
fi
rm -f "$validation"
printf '%s\n' "$record" > "$temporary" || fail "cannot write observation" 1
mv "$temporary" "$directory/observation.json" || fail "cannot publish observation" 1
echo "::notice::Created simulated observation for $stack_id ($aggregate)"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'observationPath=%s\naggregateStatus=%s\n' "$directory/observation.json" "$aggregate" >> "$GITHUB_OUTPUT"
else
  printf 'observationPath=%s\naggregateStatus=%s\n' "$directory/observation.json" "$aggregate"
fi
