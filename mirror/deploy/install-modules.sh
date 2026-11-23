#!/usr/bin/env bash
# Installs the third-party modules listed in mirror/modules.lock into
# ~/MagicMirror/modules, each at its pinned commit. Run as the mirror user.
# It is safe to run again: a module already at its pin is left alone.
#
# npm runs with --ignore-scripts, so no module's install script executes.
set -euo pipefail

MM_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
LOCK="$MM_DIR/mirror/modules.lock"

while read -r name url commit install; do
	case "$name" in "" | \#*) continue ;; esac
	dir="$MM_DIR/modules/$name"
	if [ -L "$dir" ]; then
		echo "skip $name: modules/$name is a link to one of our own modules" >&2
		continue
	fi
	if [ ! -d "$dir/.git" ]; then
		git clone --quiet "$url" "$dir"
	fi
	if [ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]; then
		git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$dir" fetch --quiet origin
		git -C "$dir" checkout --quiet --detach "$commit"
		rm -rf "$dir/node_modules"
	fi
	if [ "$install" = "npm" ] && [ ! -d "$dir/node_modules" ]; then
		if [ -f "$dir/package-lock.json" ]; then
			(cd "$dir" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
		else
			(cd "$dir" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)
		fi
	fi
	echo "$name at ${commit:0:8}"
done < "$LOCK"
