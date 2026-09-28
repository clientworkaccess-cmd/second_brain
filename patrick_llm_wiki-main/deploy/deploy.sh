#!/usr/bin/env bash
#
# The deploy. Run it by hand the first time; GitHub Actions runs the same file
# afterwards. One script rather than steps duplicated in a workflow, so CI can
# never drift from what actually works on the box.
#
#   ssh root@vps '/opt/dashboard/deploy/deploy.sh'

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dashboard}"
SERVICE="${SERVICE:-dashboard}"
# Must match Environment=PORT in dashboard.service and the Traefik service URL.
# 3002 because another app on this box owns 3000.
PORT="${PORT:-3002}"

cd "$APP_DIR"

echo "==> Fetching"
git fetch --all --prune
git reset --hard origin/main

echo "==> Installing"
# `npm ci` not `npm install`: it installs exactly the lockfile and fails loudly
# if package.json and the lock have drifted, rather than quietly resolving to
# something that was never tested.
#
# NOT --omit=dev. We build on this box, and the build needs typescript,
# tailwindcss and postcss, all of which are devDependencies. Without typescript
# Next cannot read the `paths` mapping out of tsconfig.json, so every `@/…`
# import fails to resolve and the error reads as missing source files rather
# than a missing compiler. --omit=dev only belongs here if the build artifact
# is produced elsewhere and shipped in.
#
# --include=dev is not redundant: npm silently omits devDependencies whenever
# NODE_ENV=production is in the environment, and the deploy runs through a
# login shell that may well export it. Dropping --omit=dev alone did nothing;
# this forces the issue.

npm ci --include=dev --ignore-scripts=false

# Fail loudly here rather than 40 lines later with "Module not found: @/lib/…",
# which is what a missing typescript actually looks like.
if [ ! -d node_modules/typescript ]; then
	echo "!! typescript did not install — Next cannot resolve tsconfig paths without it." >&2
	echo "!! NODE_ENV in this shell is: '${NODE_ENV:-unset}'" >&2
	exit 1
fi

echo "==> Building"
# Needs outbound network for the three Google fonts. When the egress firewall
# lands (T0), allowlist fonts.googleapis.com and fonts.gstatic.com or the build
# starts failing here for a reason that will look unrelated.
npm run build

echo "==> Restarting"
systemctl restart "$SERVICE"

echo "==> Waiting for it to answer"
for i in $(seq 1 30); do
	if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
		echo "==> Up"
		exit 0
	fi
	sleep 1
done

# Never exit 0 on a dead service — a green pipeline over a down site is worse
# than a red one.
echo "!! Did not come up within 30s. Recent logs:" >&2
journalctl -u "$SERVICE" -n 40 --no-pager >&2
exit 1
