#!/usr/bin/env bash
set +x
set -uo pipefail
case_name="" details=""
usage() { echo "Usage: state-write-alert.sh --case CASE [--details TEXT]" >&2; }
while (($#)); do
  if (($# < 2)); then usage; exit 2; fi
  key="$1" value="$2"; shift 2
  case "$key" in --case) case_name="$value";; --details) details="$value";; *) usage; exit 2;; esac
done
[[ -n "$case_name" ]] || { usage; exit 2; }
case "$case_name" in
  git-failed) title="State write failed"; body="Git could not push the observed state." ;;
  script-failure) title="State writer script failed"; body="The state write could not complete because a writer script failed." ;;
  partial) title="State write was partial"; body="Some requested stacks were rejected and need reconciliation." ;;
  rejected) title="State write was rejected"; body="No requested observation was accepted; reconciliation is required." ;;
  stale-base) title="State write base remained stale"; body="The state branch kept moving while the writer retried." ;;
  reconciliation-resolve-failed) title="Reconciliation targets could not be resolved"; body="A target lacked a valid expected state." ;;
  reconciliation-invoke-failed) title="Reconciliation could not be invoked"; body="The reconciliation workflow did not start successfully." ;;
  *) title="State writer alert: $case_name"; body="An unrecognized state-writer outcome needs investigation." ;;
esac
details="${details//$'\r'/ }"; details="${details//$'\n'/ }"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}"
message="$body"
[[ -n "$details" ]] && message="$message Details: $details"
echo "::error::$title: $message Run: $run_url"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '## %s\n\n%s\n\nRun: %s\n' "$title" "$message" "$run_url" >> "$GITHUB_STEP_SUMMARY" || { echo "::warning::Could not append the step summary"; }
fi
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  payload="$(jq -cn --arg title "$title" --arg message "$message" --arg url "$run_url" '{text:("*"+$title+"*\n"+$message+"\n"+$url)}')" || { echo "::warning::Could not encode Slack alert"; exit 0; }
  if ! command -v curl >/dev/null 2>&1 || ! curl --silent --show-error --fail --max-time 10 -H 'Content-Type: application/json' --data "$payload" "$SLACK_WEBHOOK_URL" >/dev/null 2>&1; then
    echo "::warning::Slack alert delivery failed"
  fi
fi
