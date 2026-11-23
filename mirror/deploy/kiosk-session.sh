#!/bin/sh
# Started by sway. Runs MagicMirror, then ends the sway session when MagicMirror
# exits. systemd restarts the session (see magicmirror-kiosk.service).
#
# MagicMirror's output goes to the journal: journalctl -t magicmirror
cd "$(dirname "$0")/../.." || exit 1
npm start 2>&1 | systemd-cat -t magicmirror
swaymsg exit
