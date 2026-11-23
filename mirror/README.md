# Household mirror

Everything specific to the mirror on the Raspberry Pi lives in this directory. Upstream MagicMirror² has no `mirror/` directory, so syncing the fork with upstream does not touch these files.

## Layout

- `deploy/` holds the setup script, the systemd unit, the sway config and the AppArmor profile.
- `config/` holds `config.js` and `custom.css`. Private values go in `config/config.env` on the Pi, which is not committed.
- `modules/MMM-Household/` is the module that switches the view by who is at the mirror and lets the screen sleep.
- `services/` holds the Python face recognition service that the module starts.
- `lib/` holds JavaScript shared by our modules, such as the Google token helper.
- `tools/` holds scripts that run on another computer, such as the Google sign-in.

## Third-party modules

Modules from the MagicMirror module directory are not copied into this repository. `modules.lock` names each one with its repository and an exact commit, and `deploy/install-modules.sh` clones them into `~/MagicMirror/modules` at those commits. npm runs with `--ignore-scripts`, so no module's install script executes.

To add or update a module, read its code first (the helper especially: what it fetches, what it writes, whether it runs commands), then add or change its line in `modules.lock` and run the setup script.

Three modules are our forks, each on a `mirror-fixes` branch:

- `crankyMagician/MMM-PokemonGOEvents` uses the built-in `fetch` and keeps polling after a network error.
- `crankyMagician/MMM-DailyPokemon` adds `pickByDate`, so the Pokémon holds for the whole day, and a `favorites` list.
- `crankyMagician/MMM-GoogleCalendar` adds `tokenFile`, so each instance can show a different Google account.

Our own modules live in `modules/` here and are linked into place by the setup script:

- `MMM-Household`: who sees what, the screen, the settings page.
- `MMM-Greeter`: a greeting when a person is recognized. A person with `favorites` gets one of those Pokémon beside it, a different one each day. The pictures are downloaded once to `~/mirror-data/sprites` and are not part of this repository. It sends `TTS_SAY` for a speech module to say the greeting.
- `MMM-AirQuality`: the US air quality index from Open-Meteo, with no account needed.
- `MMM-Briefing`: spoken answers to voice commands and a message on special days, described below.

- `MMM-HouseholdTasks`: the open tasks of one Google account, read-only.
- `MMM-Speak`: the mirror's voice, through ElevenLabs or Cartesia.
- `MMM-Voice`: offline voice commands, described below.

Run the tests on the Pi with:

```sh
cd ~/MagicMirror
node --test "mirror/modules/**/*.test.js"
~/mirror-data/venv/bin/python -m unittest discover -s mirror/services
```

## The mirror's voice

`MMM-Speak` says text aloud through the USB speaker. Any module asks for speech with a notification:

```js
this.sendNotification("TTS_SAY", { text: "Good morning.", id: "greeting" });
```

`MMM-Greeter` does this when it greets someone. While the mirror speaks, `MMM-Voice` stops listening so the mirror does not hear itself.

Two speech services are supported, ElevenLabs and Cartesia. `config.env` on the Pi chooses one and holds the keys:

    MIRROR_SPEECH_PROVIDER=cartesia
    MIRROR_SPEECH_VOICE=<the voice's id in that provider's account>
    SECRET_ELEVENLABS_API_KEY=...
    SECRET_CARTESIA_API_KEY=...

Every phrase is cached as raw audio in `~/mirror-data/speech`, so a phrase said before plays from disk and costs nothing. `dailyCharacterLimit` (1,500 by default) caps how much new text is sent per day. The words themselves are never written to the log.

The directory has no module for either service. `MMM-GoogleTTS` gave the `TTS_SAY` notification names, which `MMM-Speak` follows.

Do not play a recording of a command phrase through the speaker by hand. The mirror hears it and obeys.

## Google calendars and tasks

Each person's Google accounts show on their view, read-only: calendars through our fork of `MMM-GoogleCalendar` and tasks through `MMM-HouseholdTasks`. `config.js` has one calendar instance and one tasks instance per account, built by the `googleCalendar` and `googleTasks` helpers at the top of the file.

One Google Cloud project with one Desktop OAuth client serves every account. Its client file is `~/mirror-data/google/credentials.json` on the Pi. Each account has its own token file beside it, named after the account (`sam-personal.json`, `heather-merrows.json`).

To connect an account, run this on a computer with a browser and SSH access to the Pi, and sign in as that account when the Google page opens:

```sh
mirror/tools/google-connect.py heather-personal --email her.address@example.com
```

The tool asks for read-only access to Google Calendar and Google Tasks, and writes the token to the Pi with mode 600. It writes nothing on the computer it runs on. The mirror notices the new file within a few minutes. Until an account is connected, its modules show a short sign-in note.

To disconnect an account, delete its token file on the Pi and remove the app at https://myaccount.google.com/permissions.

Directory modules considered for tasks: `MMM-GoogleTasks` and `MMM-Tasks` both send results to every instance with nothing to tell accounts apart, so neither can show two accounts side by side. `MMM-HouseholdTasks` is our own for that reason.

## Photo slideshow

A person can have a framed photo on their view that changes every 20 seconds. The photos come from that person's own Google Photos.

Google stopped letting apps read a person's albums in March 2025, and the directory's `MMM-GooglePhotos` says it no longer works for that reason. What Google still offers is its photo picker, so that is what the mirror uses:

1. The person's Google account is connected with photo access: `mirror/tools/google-connect.py sam-personal --photos`.
2. On the settings page, under "My photos", they press "Choose photos from Google Photos". A Google page opens and they select photos there.
3. The mirror downloads the chosen photos (fitted to 1600 pixels) to `~/mirror-data/photos/<person>/` on the Pi and the slideshow picks them up within a minute.

They can choose more at any time. "Remove all my photos" empties the folder after a second tap. Up to 300 photos are kept per person. The photos live only on the Pi and never enter this repository.

A person who would sooner see art gets paintings in the same kind of frame. `artFeeds` in `MMM-Household`'s config names a picture feed for that person, and `MMM-Household/art-feed.js` copies the feed's pictures to `~/mirror-data/art/<person>/`, checks for a new set every six hours and removes the old set once the new one has arrived. The feed in use is built weekly by [tv-art](https://github.com/crankyMagician/tv-art) from The Met's public domain paintings. A feed is a JSON file with an `updated` stamp and an `images` list, and only HTTPS pictures on the feed's own host are downloaded. That person's settings page shows "My art" in place of "My photos".

`MMM-Household/photos-routes.js` runs the picker flow, and `MMM-ImagesPhotos` from the module directory, pinned in `modules.lock`, shows the folder. `photoAccounts` in `MMM-Household`'s config names the Google account for each person when it is not `<name>-personal`.

## Voice commands

`MMM-Voice` listens through the webcam's microphone for phrases that start with "mirror". `services/voice.py` recognizes them on the Pi with Vosk and a fixed phrase list, so the recognizer can only answer with a listed phrase. Audio stays in memory and never leaves the Pi. A short tone on the speaker confirms each command.

| Say                                               | What happens                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| "Mirror, wake up"                                 | The screen turns on. With nobody recognized it shows the shared view for five minutes. It also overrides quiet hours |
| "Mirror, good night"                              | The screen turns off and stays off until you walk away and come back                                                 |
| "Mirror, show the calendar" / "Mirror, hide news" | Shows or hides one feature until you leave. The names are in `MMM-Voice`'s `features` option in `config.js`          |
| "Mirror, what is the weather"                     | The mirror says the temperature, the sky and today's high and low                                                    |
| "Mirror, good morning"                            | A briefing: the weather, what is left on your calendar today and your open tasks                                     |
| "Mirror, what is next" / "what is on my calendar" | The event happening now and the next one on your calendar                                                            |

To add a command, add an id and its phrases to `MMM-Voice`'s `commands` option and handle `VOICE_COMMAND` in a module. If a phrase uses a word the speech model does not know, the log names the word.

Test a recording without the microphone (16 kHz, 16-bit, mono WAV):

```sh
~/mirror-data/venv/bin/python ~/MagicMirror/mirror/services/voice.py --commands commands.json --wav phrase.wav
```

## Spoken answers and special days

`MMM-Briefing` answers the last three commands above through `MMM-Speak`. It builds its sentences from what other modules broadcast: `WEATHER_UPDATED` from the weather module, `CALENDAR_EVENTS` from each `MMM-GoogleCalendar` instance (`broadcastEvents` is on) and `HOUSEHOLD_TASKS` from each `MMM-HouseholdTasks` instance. It reads only the calendars and task lists of the person the mirror recognizes, matched by the person name in each module's `classes`. With nobody recognized it gives the weather and keeps the calendar to itself.

A special day is a date, a person and a line. The first time that person is recognized on that date, the mirror shows the line for 90 seconds and says it, once. The list is `MIRROR_SPECIAL_DAYS` in `config.env`, as JSON on one line:

```sh
MIRROR_SPECIAL_DAYS='[{"date": "12-25", "person": "heather", "line": "Merry Christmas, Heather."}]'
```

The date is `MM-DD` for every year or `YYYY-MM-DD` for one year. An entry without a person is for everyone, and each person gets it once. An anniversary can count its years: give `"since": 2020` and write `{years}` in the line.

No directory module does this. The voice assistants there (`MMM-AssistantMk2`, `MMM-GoogleAssistant`) send audio to Google and answer from Google's data, and the mirror's own modules already hold everything a briefing needs.

## Who sees what

The webcam watches for faces. `services/presence.py` detects them with OpenCV's YuNet model and recognizes them with SFace, both on the Pi's CPU. Frames stay in memory and nothing leaves the Pi.

In `config.js`, a module with a person's name in its `classes` shows only for that person. A module without one is shared.

```js
const moduleConfig = { module: "calendar", classes: "heather", position: "top_left" };
```

- A recognized person sees their modules and the shared ones.
- With nobody recognized, only shared modules show, and after `absentDelay` seconds the screen turns off. A recognized face turns it back on.
- Until someone is enrolled, any face counts as a guest and keeps the shared view on.

### Enroll a person

At the mirror, with the person standing in front of the camera:

Open the settings page, pick your name and press "Teach the mirror my face". From a shell on the Pi the same thing is:

```sh
curl -X POST -H 'Content-Type: application/json' -d '{"name":"sam"}' http://localhost:8081/api/enroll
```

The mirror shows a notice, takes 20 samples over a few seconds and then recognizes that person.

From photos, for someone who cannot stand at the mirror yet:

```sh
~/mirror-data/venv/bin/python ~/MagicMirror/mirror/services/enroll.py --name heather --from-photos ~/heather-photos
```

`enroll.py --list` shows who is enrolled and `enroll.py --remove NAME` removes a person. Only face embeddings are stored, in `~/mirror-data/faces/`, and that directory is outside the repository.

### Settings page

Each person sets their own preferences from a phone on the home network:

    http://mirror.local:8081/

If the name does not resolve, use the Pi's address in its place.

- **What I see** has a switch for every feature in each part of the day.
- **My face** starts an enrollment at the mirror.

The **Mirror** tab beside the names holds what belongs to the mirror and the room it hangs in, and applies to everyone:

- **Quiet hours** keep the screen off between two times, whoever the mirror sees, and it greets nobody. "Mirror, wake up" and any other spoken command still work.
- **Parts of the day** sets when morning, day, evening and night start (5 am, 11 am, 5 pm and 10 pm at first). Each part has to start after the one before it.

Changes save as they are made and apply on the mirror within a second. They are stored in `~/mirror-data/profiles.json` on the Pi, people under `people` and the mirror's own settings under `mirror`. A file from before the Mirror tab existed is read as it is: quiet hours that a person had switched on become the mirror's.

The page has no login. `settingsAllow` in the module's config limits it to the home subnets, and anyone on those can change these preferences.

The page has a port of its own (8081). MagicMirror itself answers only on the Pi (`address: "localhost"`), because third-party modules often trust whatever reaches MagicMirror's socket and routes.

### Check what the mirror thinks

```sh
curl http://localhost:8081/api/status
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

### Network devices and themes

`MMM-UniFi` lives in the private repository [crankyMagician/MMM-UniFi](https://github.com/crankyMagician/MMM-UniFi), pinned in `mirror/modules.lock`. Both Sam and Heather can switch **Network devices** on or off for each time block. The mirror cycles through every connected client grouped by network, then the UniFi hardware.

Open **Network devices** from `http://mirror.local:8081/` for the full searchable inventory. Only the dashboard's fixed GET routes are forwarded to the localhost MagicMirror server; the controller credentials and raw responses stay on the Pi.

The **Appearance** selector on each person's settings page chooses dark or light mode for the whole mirror. Existing profiles default to dark, and guests use dark mode. Heather's accent adapts to the selected theme. The dashboard inherits the selected profile's theme when opened; its own theme button changes only that browser view.

Before installing the private module on a new Pi:

1. Generate a dedicated Ed25519 key at `~/.ssh/mmm-unifi-deploy` and add its public key to the private repository as a **read-only deploy key**. Verify GitHub's SSH host key in `known_hosts`. The module installer uses this key only for MMM-UniFi. `UNIFI_DEPLOY_KEY` may override its path.
2. Create `~/mirror-data/unifi.json` with `username` and `password` from the existing **Sam Dev → Unifi API** 1Password item. Set mode `600` and ownership to the mirror user. Never commit it or put it in the web root.
3. Run `mirror/deploy/install-modules.sh` as the mirror user and restart the kiosk. The configured local controller is `https://192.168.1.1`, site `default`; its self-signed certificate is allowed only by this module.

The module needs no runtime npm dependencies. Its separate repository documents the API, tests and configuration. To roll back, restore the previous `mirror/modules.lock` pin and matching household configuration, rerun the installer and restart; profile preferences and credentials remain outside the repository.

The directory alternatives reviewed were MMM-NetworkScanner/MMM-MacAddressScan (presence scanning), the UniFi guest/voucher modules (guest access), and MMM-UniFiProtect (cameras). None covered a complete controller inventory with network membership and phone browsing.

### Weather, dates and countdowns

`~/MagicMirror/config/config.env` holds the home coordinates for the weather, the date the days-together counter starts from, and the countdown events. `config.env.sample` lists the names. MagicMirror hides names that start with `SECRET_` from the browser.

## Take a screenshot over SSH

```sh
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 grim /tmp/mirror.png
```
