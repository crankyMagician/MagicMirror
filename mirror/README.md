# Household mirror

Everything specific to the mirror on the Raspberry Pi lives in this directory. Upstream MagicMirror² has no `mirror/` directory, so syncing the fork with upstream does not touch these files.

## Layout

- `deploy/` holds the setup script, the systemd unit, the sway config and the AppArmor profile.
- `config/` holds `config.js` and `custom.css`. Private values go in `config/config.env` on the Pi, which is not committed.

## Install on the Pi

The target is Ubuntu Server 24.04 (arm64) on a Raspberry Pi 4.

```sh
git clone https://github.com/crankyMagician/MagicMirror.git ~/MagicMirror
sudo ~/MagicMirror/mirror/deploy/setup-pi.sh
```

The script installs Node.js 24, sway and the libraries Electron needs. It links the config into place and enables `magicmirror-kiosk.service`. Run it again after pulling new code.

## How it runs

`magicmirror-kiosk.service` starts sway on tty1 as the login user. sway starts MagicMirror, and when MagicMirror exits sway exits too, so systemd restarts the whole session.

```sh
systemctl status magicmirror-kiosk       # state of the kiosk
journalctl -t magicmirror -f             # MagicMirror's log
sudo systemctl restart magicmirror-kiosk # restart after a config change
```

## Rotate the screen

Edit `/etc/magicmirror-kiosk/output.conf` on the Pi and restart the service. `transform 90` and `transform 270` are the two portrait directions, and `transform normal` is landscape.

## Private values

`~/MagicMirror/config/config.env` holds the home coordinates for the weather and the calendar's iCal link. `config.env.sample` lists the names. MagicMirror hides names that start with `SECRET_` from the browser.

## Take a screenshot over SSH

```sh
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 grim /tmp/mirror.png
```
