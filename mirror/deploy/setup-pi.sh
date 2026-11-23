#!/usr/bin/env bash
# Sets up the MagicMirror kiosk on the Pi (Ubuntu Server 24.04, arm64).
# It is safe to run again after pulling new code.
#
# Usage, on the Pi, after cloning the fork to ~/MagicMirror:
#   sudo ~/MagicMirror/mirror/deploy/setup-pi.sh
set -euo pipefail

MIRROR_USER="${SUDO_USER:-sam}"
MIRROR_HOME="$(getent passwd "$MIRROR_USER" | cut -d: -f6)"
MM_DIR="$MIRROR_HOME/MagicMirror"
DEPLOY_DIR="$MM_DIR/mirror/deploy"
ETC_DIR=/etc/magicmirror-kiosk
NODE_MAJOR=24

if [ "$(id -u)" -ne 0 ]; then
	echo "Run this script with sudo." >&2
	exit 1
fi
if [ ! -d "$DEPLOY_DIR" ]; then
	echo "Missing $DEPLOY_DIR. Clone the fork to $MM_DIR first." >&2
	exit 1
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt_get() { apt-get -y -o DPkg::Lock::Timeout=600 "$@"; }
as_user() { sudo -u "$MIRROR_USER" -H bash -c "$1"; }
render() { sed -e "s|@MM_DIR@|$MM_DIR|g" -e "s|@USER@|$MIRROR_USER|g" -e "s|@ETC_DIR@|$ETC_DIR|g" "$1"; }

echo "==> Node.js $NODE_MAJOR"
current_major="$(command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo none)"
if [ "$current_major" != "$NODE_MAJOR" ]; then
	install -d -m 0755 /etc/apt/keyrings
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
		| gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
	echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
		> /etc/apt/sources.list.d/nodesource.list
	apt_get update
	apt_get install nodejs
fi
node --version

echo "==> Display stack and Electron libraries"
apt_get install --no-install-recommends \
	sway wlr-randr grim \
	libgl1-mesa-dri libgles2 libegl1 libgbm1 \
	libgtk-3-0t64 libnss3 libasound2t64 libxss1 libxtst6 libnotify4 \
	fonts-dejavu-core fonts-noto-color-emoji \
	avahi-daemon dbus-user-session

echo "==> MagicMirror dependencies"
as_user "cd '$MM_DIR' && npm run install-mm"

echo "==> Config and module links"
as_user "
	set -e
	cd '$MM_DIR'
	ln -sfn ../mirror/config/config.js config/config.js
	ln -sfn ../mirror/config/custom.css config/custom.css
	[ -f config/config.env ] || cp mirror/config/config.env.sample config/config.env
	chmod 600 config/config.env
	if [ -d mirror/modules ]; then
		for dir in mirror/modules/*/; do
			[ -d \"\$dir\" ] || continue
			ln -sfn \"../\$dir\" \"modules/\$(basename \"\$dir\")\"
		done
	fi
	mkdir -p '$MIRROR_HOME/mirror-data'
"

echo "==> AppArmor profile for the Electron sandbox"
render "$DEPLOY_DIR/apparmor-magicmirror-electron" > /etc/apparmor.d/magicmirror-electron
apparmor_parser -r /etc/apparmor.d/magicmirror-electron

echo "==> Kiosk session"
install -d -m 0755 "$ETC_DIR"
render "$DEPLOY_DIR/sway.conf" > "$ETC_DIR/sway.conf"
# output.conf holds the rotation. It is written once and then left alone,
# so a change made on the Pi survives later runs of this script.
if [ ! -f "$ETC_DIR/output.conf" ]; then
	cp "$DEPLOY_DIR/output.conf" "$ETC_DIR/output.conf"
fi
chmod 755 "$DEPLOY_DIR/kiosk-session.sh"
render "$DEPLOY_DIR/magicmirror-kiosk.service" > /etc/systemd/system/magicmirror-kiosk.service
systemctl daemon-reload
# The kiosk owns tty1. A login prompt is still available on tty2 (Ctrl+Alt+F2).
systemctl disable --now getty@tty1.service 2>/dev/null || true
systemctl enable magicmirror-kiosk.service
systemctl restart magicmirror-kiosk.service

echo "==> Done. Check it with: systemctl status magicmirror-kiosk"
