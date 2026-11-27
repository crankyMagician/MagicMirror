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
	avahi-daemon dbus-user-session \
	python3-venv v4l-utils alsa-utils libatomic1 ffmpeg

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
	# Add names that a newer sample has and the Pi's copy lacks. config.js fails
	# to load when a \${NAME} in it has no value.
	grep -E '^[A-Z_]+=' mirror/config/config.env.sample | while IFS= read -r line; do
		grep -q \"^\${line%%=*}=\" config/config.env || printf '%s\\n' \"\$line\" >> config/config.env
	done
	if [ -d mirror/modules ]; then
		for dir in mirror/modules/*/; do
			[ -d \"\$dir\" ] || continue
			ln -sfn \"../\$dir\" \"modules/\$(basename \"\$dir\")\"
			# Our own modules with packages (MMM-Ask) install them from the lock file.
			if [ -f \"\$dir/package-lock.json\" ]; then
				(cd \"\$dir\" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
			fi
		done
	fi
	mkdir -p '$MIRROR_HOME/mirror-data'
"

echo "==> Third-party modules"
as_user "'$DEPLOY_DIR/install-modules.sh'"

echo "==> Face recognition service"
DATA_DIR="$MIRROR_HOME/mirror-data"
MODEL_BASE=https://github.com/opencv/opencv_zoo/raw/main/models
as_user "
	set -e
	mkdir -p '$DATA_DIR/models' '$DATA_DIR/faces'
	chmod 700 '$DATA_DIR/faces'
	[ -x '$DATA_DIR/venv/bin/python' ] || python3 -m venv '$DATA_DIR/venv'
	'$DATA_DIR/venv/bin/pip' install --quiet --disable-pip-version-check -r '$MM_DIR/mirror/services/requirements.txt'
	fetch_model() {
		[ -s \"$DATA_DIR/models/\$2\" ] || curl -fsSL -o \"$DATA_DIR/models/\$2\" \"$MODEL_BASE/\$1/\$2\"
	}
	fetch_model face_detection_yunet face_detection_yunet_2023mar.onnx
	fetch_model face_recognition_sface face_recognition_sface_2021dec.onnx
	cd '$DATA_DIR/models' && sha256sum -c '$DEPLOY_DIR/models.sha256'
"

echo "==> Speech recognition model"
VOSK_MODEL=vosk-model-small-en-us-0.15
VOSK_SHA256=30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498
as_user "
	set -e
	cd '$DATA_DIR/models'
	if [ ! -d $VOSK_MODEL ]; then
		curl -fsSL -o $VOSK_MODEL.zip https://alphacephei.com/vosk/models/$VOSK_MODEL.zip
		echo '$VOSK_SHA256  $VOSK_MODEL.zip' | sha256sum -c -
		python3 -c \"import zipfile; zipfile.ZipFile('$VOSK_MODEL.zip').extractall('.')\"
		rm $VOSK_MODEL.zip
	fi
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
# Two units: the server (settings page, camera, voice) and the kiosk, which
# is only the screen. The server keeps running when the kiosk cannot start,
# for example with no monitor attached.
render "$DEPLOY_DIR/magicmirror-server.service" > /etc/systemd/system/magicmirror-server.service
render "$DEPLOY_DIR/magicmirror-kiosk.service" > /etc/systemd/system/magicmirror-kiosk.service
systemctl daemon-reload
# The kiosk owns tty1. A login prompt is still available on tty2 (Ctrl+Alt+F2).
systemctl disable --now getty@tty1.service 2>/dev/null || true
systemctl enable magicmirror-server.service magicmirror-kiosk.service
# Stop the kiosk first. An older kiosk ran the server inside itself and
# would hold its ports.
systemctl stop magicmirror-kiosk.service
systemctl restart magicmirror-server.service
systemctl start magicmirror-kiosk.service

echo "==> Done. Check it with: systemctl status magicmirror-server magicmirror-kiosk"
