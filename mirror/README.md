# Household mirror

Everything specific to the mirror on the Raspberry Pi lives in this directory. Upstream MagicMirror² has no `mirror/` directory, so syncing the fork with upstream does not touch these files.

## Layout

- `deploy/` holds the setup script, the systemd unit, the sway config and the AppArmor profile.
- `config/` holds `config.js` and `custom.css`. Private values go in `config/config.env` on the Pi, which is not committed.
- `modules/MMM-Household/` is the module that switches the view by who is at the mirror and lets the screen sleep.
- `services/` holds the Python face recognition service that the module starts.

## Who sees what

The webcam watches for faces. `services/presence.py` detects them with OpenCV's YuNet model and recognizes them with SFace, both on the Pi's CPU. Frames stay in memory and nothing leaves the Pi.

In `config.js`, a module with a person's name in its `classes` shows only for that person. A module without one is shared.

```js
{ module: "calendar", classes: "heather", ... }
```

- A recognized person sees their modules and the shared ones.
- With nobody recognized, only shared modules show, and after `absentDelay` seconds the screen turns off. A recognized face turns it back on.
- Until someone is enrolled, any face counts as a guest and keeps the shared view on.

### Enroll a person

At the mirror, with the person standing in front of the camera:

Open the settings page, pick your name and press "Teach the mirror my face". From a shell on the Pi the same thing is:

```sh
curl -X POST -H 'Content-Type: application/json' -d '{"name":"sam"}' http://localhost:8080/household/api/enroll
```

The mirror shows a notice, takes 20 samples over a few seconds and then recognizes that person.

From photos, for someone who cannot stand at the mirror yet:

```sh
~/mirror-data/venv/bin/python ~/MagicMirror/mirror/services/enroll.py --name heather --from-photos ~/heather-photos
```

`enroll.py --list` shows who is enrolled and `enroll.py --remove NAME` removes a person. Only face embeddings are stored, in `~/mirror-data/faces/`, and that directory is outside the repository.

### Settings page

Each person sets their own preferences from a phone on the home network:

    http://mirror.local:8080/household

If the name does not resolve, use the Pi's address in its place.

- **What I see** has a switch for every feature in each part of the day (morning from 5 am, day from 11 am, evening from 5 pm, night from 10 pm).
- **Quiet hours** keep the screen off for that person between two times, even when the mirror sees them.
- **My face** starts an enrollment at the mirror.

Changes save as they are made and apply on the mirror within a second. They are stored in `~/mirror-data/profiles.json` on the Pi.

The page has no login. `ipWhitelist` in `config.js` limits it to the home subnets, and anyone on those can change these preferences.

### Check what the mirror thinks

```sh
curl http://localhost:8080/household/api/status
journalctl -t magicmirror | grep MMM-Household
```

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
