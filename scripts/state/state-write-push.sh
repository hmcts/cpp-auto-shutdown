#!/usr/bin/env bash
set +x
set -uo pipefail
scratch=""
while (($#)); do
  (($# >= 2)) || { echo "Usage: state-write-push.sh --scratch-dir S" >&2; exit 2; }
  key="$1" value="$2"; shift 2
  [[ "$key" == --scratch-dir ]] || { echo "Unknown argument: $key" >&2; exit 2; }
  scratch="$value"
done
[[ -d "$scratch" ]] || { echo "Usage: state-write-push.sh --scratch-dir S" >&2; exit 2; }
STATE_REPO_DIR="${STATE_REPO_DIR:-$scratch/../state-repo}"; STATE_BRANCH="${STATE_BRANCH:-main}"
validation="$scratch/validate-result.json"; merge="$scratch/merge-result.json"
[[ -f "$validation" && -f "$merge" ]] || { echo "::error::Missing push input result" >&2; exit 1; }
base_sha="$(jq -er '.baseSha | select(type == "string")' "$validation")" || { echo "::error::Invalid validation result" >&2; exit 1; }
auth_header=""
if [[ -n "${STATE_WRITE_TOKEN:-}" ]]; then
  encoded="$(printf 'x-access-token:%s' "$STATE_WRITE_TOKEN" | base64 | tr -d '\r\n')" || exit 1
  auth_header="AUTHORIZATION: basic $encoded"
fi
git_auth() { if [[ -n "$auth_header" ]]; then git -c "http.extraheader=$auth_header" -C "$STATE_REPO_DIR" "$@"; else git -C "$STATE_REPO_DIR" "$@"; fi; }
finish() {
  outcome="$1" sha="$2" temporary="$scratch/push-result.json.tmp.$$"
  jq -cn --arg writeOutcome "$outcome" --arg writtenCommitSha "$sha" '{writeOutcome:$writeOutcome,writtenCommitSha:$writtenCommitSha}' > "$temporary" || exit 1
  mv "$temporary" "$scratch/push-result.json" || exit 1
  [[ "$outcome" == succeeded ]] && exit 0 || exit 1
}
for tool in git jq; do command -v "$tool" >/dev/null 2>&1 || { echo "::error::Missing required tool: $tool" >&2; finish git-failed ""; }; done
git_log="$scratch/push-git-output.txt"
if ! git_auth fetch --quiet origin "+refs/heads/$STATE_BRANCH:refs/remotes/origin/$STATE_BRANCH" >/dev/null 2>"$git_log"; then echo "::error::Could not fetch state branch" >&2; finish git-failed ""; fi
remote_sha="$(git -C "$STATE_REPO_DIR" rev-parse "refs/remotes/origin/$STATE_BRANCH" 2>/dev/null)" || finish git-failed ""
if [[ "$remote_sha" != "$base_sha" ]]; then echo "::warning::State branch moved after validation"; finish stale-base ""; fi
git -C "$STATE_REPO_DIR" config user.name "cpp-github-management[bot]" || finish git-failed ""
git -C "$STATE_REPO_DIR" config user.email "devops-team@hmcts.net" || finish git-failed ""
git -C "$STATE_REPO_DIR" add -- state/environments/ || finish git-failed ""
if git -C "$STATE_REPO_DIR" diff --cached --quiet; then echo "::warning::No state changes to push"; finish succeeded "$base_sha"; fi
stacks="$(jq -er '.acceptedStacks | join(",")' "$merge")" || finish git-failed ""
pipelines="$(jq -er '.sourcePipelines | map(tostring) | join(",")' "$merge")" || finish git-failed ""
runs="$(jq -er '.sourceRunIds | map(tostring) | join(",")' "$merge")" || finish git-failed ""
git -C "$STATE_REPO_DIR" commit -m "Update observed state: stacks=$stacks pipelines=$pipelines runs=$runs" >/dev/null 2>"$git_log" || finish git-failed ""
if git_auth push --porcelain origin "HEAD:refs/heads/$STATE_BRANCH" >"$git_log" 2>&1; then
  commit_sha="$(git -C "$STATE_REPO_DIR" rev-parse HEAD 2>/dev/null)" || finish git-failed ""
  echo "::notice::State update pushed"
  finish succeeded "$commit_sha"
fi
if grep -Fq '[remote rejected]' "$git_log"; then echo "::error::State branch rejected the update" >&2; finish git-failed ""; fi
if grep -Fq '[rejected]' "$git_log" || grep -Eiq 'non-fast-forward|fetch first' "$git_log"; then
  echo "::warning::State push was rejected because the base became stale"
  finish stale-base ""
fi
echo "::error::State push failed for a non-stale Git error" >&2
finish git-failed ""
