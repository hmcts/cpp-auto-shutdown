#!/usr/bin/env bash
# Manual authentication proof only. Never start/stop environments or write state.
set +x
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "${GITHUB_REPOSITORY:-}" == 'hmcts/cpp-auto-shutdown' ]] || fail 'Unexpected repository'
[[ "${GITHUB_REF:-}" == 'refs/heads/main' ]] || fail 'Probe must run from main'
[[ "${GITHUB_EVENT_NAME:-}" == 'workflow_dispatch' ]] || fail 'Probe must be dispatched manually'
[[ "${CONFIRM_WRITE:-}" == 'true' ]] || fail 'Explicit write acknowledgement is required'
[[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid GitHub run ID'
[[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] || fail 'Invalid GitHub run attempt'
[[ -n "${APP_TOKEN:-}" ]] || fail 'GitHub App token is missing'
[[ "${APP_SLUG:-}" == 'cpp-github-management' ]] || fail 'Unexpected GitHub App'
[[ "${EXPECTED_INSTALLATION_ID:-}" =~ ^[1-9][0-9]*$ ]] || fail 'Expected installation ID is missing or invalid'
[[ "${APP_INSTALLATION_ID:-}" == "$EXPECTED_INSTALLATION_ID" ]] || fail 'Unexpected GitHub App installation'

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cat > "$workdir/askpass" <<'SH'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$APP_TOKEN" ;;
  *) exit 1 ;;
esac
SH
chmod 700 "$workdir/askpass"
export APP_TOKEN GIT_ASKPASS="$workdir/askpass" GIT_TERMINAL_PROMPT=0

git -c credential.helper= clone --quiet --single-branch --branch main \
  https://github.com/hmcts/cpp-auto-shutdown.git "$workdir/repo"
cd "$workdir/repo"
marker="app-write-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.txt"
[[ ! -e "$marker" ]] || fail 'Probe marker already exists'
printf 'GitHub Actions run %s, attempt %s\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" > "$marker"
git config user.name 'cpp-github-management[bot]'
git config user.email 'devops-team@hmcts.net'
git add -- "$marker"
[[ "$(git diff --cached --name-only)" == "$marker" ]] || fail 'Unexpected staged files'
git commit -m "Probe GitHub App write access (${GITHUB_RUN_ID}/${GITHUB_RUN_ATTEMPT})"
commit="$(git rev-parse HEAD)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid probe commit SHA'
git -c credential.helper= push origin HEAD:refs/heads/main

remote="$(git -c credential.helper= ls-remote origin refs/heads/main)"
[[ "$remote" == "$commit"$'\trefs/heads/main' ]] || fail 'Push completed, but main no longer points at the probe commit'
printf 'Verified main at %s, marker %s\n' "$commit" "$marker"