#!/usr/bin/env bash
# Build and install the `relayllm-api` command globally.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Node.js 22+ is required (e.g. brew install node@22)"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "Node.js 22+ is required (found $(node -v))"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required (e.g. brew install pnpm)"; exit 1; }
pnpm install --frozen-lockfile
pnpm --filter @relayllm/api build
tmp=$(mktemp -d)
(cd apps/api && npm pack --silent --pack-destination "$tmp" >/dev/null)
npm install -g "$tmp"/relayllm-api-*.tgz
rm -rf "$tmp"
echo
echo "Installed: $(command -v relayllm-api)"
echo "Next: relayllm-api pair '<link from: relayllm pair --invite>'"
