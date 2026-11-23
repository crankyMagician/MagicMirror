#!/bin/sh
# Started by sway. Runs MagicMirror, then ends the sway session when MagicMirror
# exits. systemd restarts the session (see magicmirror-kiosk.service).
#
# MagicMirror's output goes to the journal: journalctl -t magicmirror
cd "$(dirname "$0")/../.." || exit 1
MM_DIR=$(pwd -P)

# systemd-cat connects MagicMirror's output straight to the journal. A shell
# pipe here would keep this script waiting for as long as any leftover child
# process held the pipe open.
systemd-cat -t magicmirror npm start

# When Electron dies abnormally it can leave helper processes behind. They
# would keep the camera and the display, so clear them before the session ends.
pkill -u "$(id -u)" -f "$MM_DIR/node_modules/electron/dist/electron"
pkill -u "$(id -u)" -f "$MM_DIR/mirror/services/presence.py"
swaymsg exit
