#!/usr/bin/env bash
#
# The deploy. Run it by hand the first time; GitHub Actions runs the same file
# afterwards. One script rather than steps duplicated in a workflow, so CI can
# never drift from what actually works on the box.
#
#   ssh <admin>@vps 'sudo /opt/brain-app/deploy/deploy.sh'
#
# Run as root. The checkout and the build belong to root and are read-only to
# the service user, so the running app cannot rewrite its own code.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/brain-app}"
SERVICE="${SERVICE:-brain-app}"
SERVICE_USER="${SERVICE_USER:-brain}"
BRANCH="${BRANCH:-main}"
# Must match Environment=PORT in brain-app.service and the Traefik service URL.
PORT="${PORT:-3003}"

cd "$APP_DIR"

echo "==> Fetching"
git fetch --prune origin
git reset --hard "origin/$BRANCH"

echo "==> Installing"
# `npm ci` not `npm install`: it installs exactly the lockfile and fails loudly
# if package.json and the lock have drifted, rather than quietly resolving to
# something that was never tested.
#
# NOT --omit=dev. We build on this box, and the build needs typescript,
# tailwindcss and postcss, all of which are devDependencies. Without typescript
# Next cannot read the `paths` mapping out of tsconfig.json, so every `@/…`
# import fails to resolve and the error reads as missing source files rather
# than a missing compiler.
#
# --include=dev is not redundant: npm silently omits devDependencies whenever
# NODE_ENV=production is in the environment, and the deploy runs through a
# login shell that may well export it.
npm ci --include=dev --ignore-scripts=false

# Fail loudly here rather than 40 lines later with "Module not found: @/lib/…",
# which is what a missing typescript actually looks like.
if [ ! -d node_modules/typescript ]; then
	echo "!! typescript did not install — Next cannot resolve tsconfig paths without it." >&2
	echo "!! NODE_ENV in this shell is: '${NODE_ENV:-unset}'" >&2
	exit 1
fi

echo "==> Advisories"
# Printed, not enforced. A new advisory should be read by a person, and should
# not be what stops a fix from going out.
npm audit --omit=dev --audit-level=high || echo "!! Read the advisories above before relying on this deploy."

echo "==> Checking"
# Before the build, not after. The build replaces the files the running server
# hands out, so anything that can stop the deploy has to stop it before that.
#
# These run against the local stand-in for the agent, in a throwaway folder.
# They never touch the wiki or the Claude login.
CLAUDE_CMD=node CLAUDE_ARGS=scripts/fake-claude.mjs CLAUDE_CONFIG_DIR= npm run check

echo "==> Building"
# Needs outbound network for the Google fonts. If an egress firewall is ever
# added, allowlist fonts.googleapis.com and fonts.gstatic.com or the build
# starts failing here for a reason that will look unrelated.
npm run build

echo "==> Permissions"
# Next writes its cache while serving. Nothing else under the app is writable
# by the service.
mkdir -p "$APP_DIR/.next/cache"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/.next/cache"
if [ -f "$APP_DIR/.env" ]; then
	chown root:root "$APP_DIR/.env"
	chmod 600 "$APP_DIR/.env"
fi

echo "==> Restarting"
systemctl restart "$SERVICE"

echo "==> Waiting for it to answer"
for i in $(seq 1 30); do
	# The login page, not `/`. Without a session `/` answers with a redirect;
	# the login page is the one page that has to render for anyone.
	if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login"; then
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
