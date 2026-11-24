#!/bin/sh
# Started by sway. Shows the MagicMirror page in Electron, then ends the sway
# session when Electron exits. systemd restarts the session (see
# magicmirror-kiosk.service).
#
# The page comes from magicmirror-server.service, which runs apart from this
# session. Electron is only the screen.
#
# The screen's output goes to the journal: journalctl -t magicmirror-screen
cd "$(dirname "$0")/../.." || exit 1
MM_DIR=$(pwd -P)

# The server answers on this machine only, at the IPv6 loopback address. It is
# written with brackets on purpose: MagicMirror's clientonly refuses the plain
# names of this machine ("localhost", "::1"), and Electron would start a
# second server of its own for them.
SERVER='[::1]'
PORT=8080

# Wait for the server, up to two minutes. Without it there is nothing to show.
tries=0
until curl -fsS -o /dev/null --max-time 3 "http://$SERVER:$PORT/config/"; do
	tries=$((tries + 1))
	[ "$tries" -ge 60 ] && break
	sleep 2
done

# Turn the picture the way the settings page last saved it, before anything
# is drawn. With nothing saved, output.conf has already decided.
rotation=$(node mirror/deploy/saved-rotation.js 2>/dev/null)
if [ -n "$rotation" ]; then
	swaymsg output '*' transform "$rotation"
fi

# systemd-cat connects the output straight to the journal. A shell pipe here
# would keep this script waiting for as long as any leftover child process
# held the pipe open.
systemd-cat -t magicmirror-screen node clientonly --address "$SERVER" --port "$PORT"

# When Electron dies abnormally it can leave helper processes behind. They
# would keep the display, so clear them before the session ends.
pkill -u "$(id -u)" -f "$MM_DIR/node_modules/electron/dist/electron"
swaymsg exit
