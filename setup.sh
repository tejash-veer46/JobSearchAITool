#!/usr/bin/env bash
# JobApplyAI setup / update for macOS and Linux:  ./setup.sh
# First time: installs everything. Later: pulls the latest code from GitHub and updates.
# Your own files (resume, config/profile.yaml, config/search.yaml, data, reports, .env)
# are git-ignored, so this never changes or deletes them.
set -euo pipefail
cd "$(dirname "$0")"
echo
echo "=== JobApplyAI setup / update ==="
echo

command -v git >/dev/null || { echo "[X] Git is not installed: https://git-scm.com/downloads"; exit 1; }
command -v node >/dev/null || { echo "[X] Node.js is not installed: https://nodejs.org (LTS)"; exit 1; }
[ -d .git ] || { echo "[X] Not a git clone. Download with: git clone https://github.com/tejash-veer46/JobSearchAITool.git"; exit 1; }

# Changes to the tool's own files would block the update: keep them safe in a git stash.
stashed=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[i] You changed some of the tool's own files. Saving them aside (git stash) so the update can go ahead..."
  git stash push -m "setup.sh backup $(date)"
  stashed=1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "[i] Switching from branch $branch to main..."
  git checkout main
fi

echo "[1/4] Getting the latest code from GitHub..."
git fetch origin main
if ! git merge --ff-only origin/main; then
  echo "[X] Your copy has commits that are not on GitHub, so it cannot be updated automatically."
  echo "    To discard them and match GitHub exactly, run:  git reset --hard origin/main"
  exit 1
fi

echo "[2/4] Installing / updating dependencies..."
npm install --no-audit --no-fund

echo "[3/4] Updating your config with new companies and settings..."
npm run -s cli -- sync-config

echo "[4/4] Checking the tool starts..."
npm run -s cli -- --help >/dev/null

echo
echo "[OK] Up to date: $(git log -1 --format='%h  %s  (%cr)')"
[ -n "$stashed" ] && echo "[i] Your earlier changes are saved. To bring them back:  git stash pop"
echo "Start the dashboard with:  npm run dashboard"
