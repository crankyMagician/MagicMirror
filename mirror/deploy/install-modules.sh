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
	git_options=(-c credential.interactive=false)
	if [ "$name" = "MMM-UniFi" ]; then
		# This repository is private. Use its own read-only deploy key, never
		# a GitHub token embedded in the lock file or clone URL.
		key="${UNIFI_DEPLOY_KEY:-$HOME/.ssh/mmm-unifi-deploy}"
		if [ ! -r "$key" ]; then
			echo "Missing MMM-UniFi deploy key at $key (see mirror/README.md)." >&2
			exit 1
		fi
		git_options=(-c "core.sshCommand=ssh -i '$key' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes")
	fi
	if [ ! -d "$dir/.git" ]; then
		git "${git_options[@]}" clone --quiet "$url" "$dir"
	fi
	# A module can move to another repository, for example to our fork.
	git -C "$dir" remote set-url origin "$url"
	if [ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]; then
		git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null || git "${git_options[@]}" -C "$dir" fetch --quiet origin
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
