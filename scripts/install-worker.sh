#!/usr/bin/env bash
# Build the RelayLLM worker and install the `relayllm` command globally.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Node.js 22+ is required (e.g. brew install node@22)"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "Node.js 22+ is required (found $(node -v))"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required (e.g. brew install pnpm)"; exit 1; }
pnpm install --frozen-lockfile
pnpm --filter @relayllm/worker build
tmp=$(mktemp -d)
(cd apps/worker && npm pack --silent --pack-destination "$tmp" >/dev/null)
npm install -g "$tmp"/relayllm-worker-*.tgz
rm -rf "$tmp"
echo
echo "Installed: $(command -v relayllm)"
echo "Next: relayllm init"
