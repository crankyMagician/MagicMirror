# Household mirror

Everything specific to the mirror on the Raspberry Pi lives in this directory. Upstream MagicMirror² has no `mirror/` directory, so syncing the fork with upstream does not touch these files.

## Layout

- `deploy/` holds the setup script, the systemd unit, the sway config and the AppArmor profile.
- `config/` holds `config.js` and `custom.css`. Private values go in `config/config.env` on the Pi, which is not committed.
- `modules/MMM-Household/` is the module that switches the view by who is at the mirror and lets the screen sleep.
- `services/` holds the Python face recognition service that the module starts.
- `lib/` holds JavaScript shared by our modules, such as the Google token helper.
- `tools/` holds scripts that run on another computer, such as the Google sign-in.

## The page

The page has four places, and `config.js` uses only these positions:

- `top_bar` is a band for what the mirror says to you. It holds one thing at a time: an answer or a special-day line, else the greeting, else a compliment.
- `top_left` and `top_right` are two columns. A module's place in its column is its place in the config's list.
- `bottom_bar` is the news.

`config/custom.css` lays these out as a stack, so no module can lie on top of another. MagicMirror's other positions (the middle, the thirds, the bottom corners) float over the columns and are not used.

A column has a fixed height. When a person's modules do not all fit, `MMM-Household` shows the ones that fit and gives the rest a turn every `turnSeconds` (40 by default). The modules named in its `pinned` option (the clock, the weather and the calendar) never wait. `modules/MMM-Household/fit.js` holds the packing, with tests beside it.

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

### A voice for each person

`voices` in `MMM-Speak`'s config lists the voices people can choose from, each with an `id`, a `name`, a line `about` it, and the provider's `provider` and `voiceId`. The provider and voice in `config.env` stay the built-in voice, used until someone chooses.

On the settings page each person has "My voice": a voice from the list, a volume, and a switch for whether the mirror speaks to them at all. The Mirror tab has the mirror's own voice, used for guests and for anyone who has not chosen. "Hear this voice" plays a short sample in the browser, and the mirror itself stays silent. A sample comes from the same cache and counts toward the same daily limit as everything the mirror says, so each voice costs its sample once.

`MMM-Household` sends the resolved choice with `HOUSEHOLD_PRESENCE` as `speech: { voice, volume, speak }`. `MMM-Speak` fixes the voice and the volume when a line is queued, so a line meant for one person does not change voice if someone else steps in front of the mirror before it plays. With "Speak to me" off, a line for that person is dropped and `TTS_SAY_ERROR` is sent in its place.

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

| Say                                                           | What happens                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| "Mirror, wake up"                                             | The screen turns on. With nobody recognized it shows the shared view for five minutes. It also overrides quiet hours |
| "Mirror, good night"                                          | The screen turns off and stays off until you walk away and come back                                                 |
| "Mirror, show the calendar" / "Mirror, hide news"             | Shows or hides one feature until you leave. The names are in `MMM-Voice`'s `features` option in `config.js`          |
| "Mirror, show only the calendar" / "Mirror, just the weather" | That one feature alone, in the middle of the screen and enlarged, for a minute. "Mirror, go back" ends it sooner     |
| "Mirror, what is the weather"                                 | The mirror says the temperature, the sky and today's high and low                                                    |
| "Mirror, good morning"                                        | A briefing: the weather, what is left on your calendar today and your open tasks                                     |
| "Mirror, what is next" / "what is on my calendar"             | The event happening now and the next one on your calendar                                                            |

To add a command, add an id and its phrases to `MMM-Voice`'s `commands` option and handle `VOICE_COMMAND` in a module. If a phrase uses a word the speech model does not know, the log names the word.

Test a recording without the microphone (16 kHz, 16-bit, mono WAV):

```sh
~/mirror-data/venv/bin/python ~/MagicMirror/mirror/services/voice.py --commands commands.json --wav phrase.wav
```

## The mirror's name and wake phrase

The Mirror tab of the settings page has the mirror's name, shown as the page's title, and the wake phrase, the words said before every command. Both are stored with the mirror's other settings.

A wake phrase is one to three plain words. The recognizer has a fixed vocabulary, so a phrase works only when the speech model knows every word in it. A new phrase therefore goes through two steps:

1. **The words are checked.** The mirror asks the speech model (`voice.py --check-words`) and refuses a phrase with a word it does not know, naming the word.
2. **The phrase goes on trial.** The mirror listens for the old phrase and the new one. The first time it hears a command that starts with the new phrase, the new one takes over. Until then the old one keeps working, and "Stop trying it" drops the candidate.

A phrase that is mistyped, or that the microphone cannot pick up, therefore never replaces the one that works. To get back to "mirror", propose it like any other phrase and say it once.

`MMM-Household` broadcasts `HOUSEHOLD_MIRROR { name, wakePhrase, wakeCandidate }`, and `MMM-Voice` rebuilds its command list for both phrases while the recognizer keeps running.

## Spoken answers and special days

`MMM-Briefing` answers the last three commands above through `MMM-Speak`. It builds its sentences from what other modules broadcast: `WEATHER_UPDATED` from the weather module, `CALENDAR_EVENTS` from each `MMM-GoogleCalendar` instance (`broadcastEvents` is on) and `HOUSEHOLD_TASKS` from each `MMM-HouseholdTasks` instance. It reads only the calendars and task lists of the person the mirror recognizes, matched by the person name in each module's `classes`. With nobody recognized it gives the weather and keeps the calendar to itself.

A special day is a date, a person and a line. The first time that person is recognized on that date, the mirror shows the line for 90 seconds and says it, once. The list is `MIRROR_SPECIAL_DAYS` in `config.env`, as JSON on one line:

```sh
MIRROR_SPECIAL_DAYS='[{"date": "12-25", "person": "heather", "line": "Merry Christmas, Heather."}]'
```

The date is `MM-DD` for every year or `YYYY-MM-DD` for one year. An entry without a person is for everyone, and each person gets it once. An anniversary can count its years: give `"since": 2020` and write `{years}` in the line.

An entry can also cover a season. Give `"from"` and `"to"` as `MM-DD` in place of the date, and each person hears it once on every day of the season. `"lines"` in place of `"line"` is a list that takes turns by day, and `"until": "12-25"` turns `{days}` in a line into the days left, as "30 days" or "1 day". A countdown says nothing on the day it counts down to. This is a holiday greeting:

```sh
MIRROR_SPECIAL_DAYS='[{"from": "11-25", "to": "12-24", "until": "12-25", "lines": ["Happy holidays. {days} until Christmas.", "{days} until Christmas."]}]'
```

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

The page answers only to the mirror's own names (`settingsHosts`, plus `login.host`) and to bare addresses. A page on another site that points a name of its own at the mirror's address is refused with 421.

#### Login

Out of the box the page has no login. `settingsAllow` in the module's config limits it to the home subnets, and anyone on those can change these preferences.

With the household's login server configured, the page and everything under `/api` and `/unifi` need a signed-in account. Three values in `config.env` switch it on:

```sh
MIRROR_AUTH_URL=https://auth.home.example
MIRROR_SETTINGS_HOST=mirror.home.example
MIRROR_ACCOUNTS='{"someone@example.org": "sam", "partner@example.org": "heather"}'
```

- The login server sets a cookie for the whole home domain when someone signs in. The browser sends it to the mirror too, and the mirror asks the login server whose it is (`GET /api/v1/auth/me`). The mirror holds no secret of the login server. An answer is reused for a minute.
- Only an account listed in `MIRROR_ACCOUNTS` gets in. A signed-in person sees and changes their own settings only: their theme, what they see, their face and their photos. Asking for someone else's answers 403. The Mirror tab is shared, and either person can change it. Any other signed-in account is told it is not one of the mirror's people.
- People open `https://MIRROR_SETTINGS_HOST/`. Opened at a bare address, the page only points there, because the cookie belongs to that name.
- The HTTPS name is served by a proxy in front of the mirror's plain HTTP port. Set `MIRROR_SETTINGS_ALLOW` to the proxy's address, and that port answers the proxy and the mirror itself and nobody else, so a password or a cookie never crosses the Wi-Fi unencrypted.
- The sign-in form on the page sends the password straight to the login server and never to the mirror. A sign-in lasts an hour and the page renews it without asking.
- If the login server does not answer, the page is closed until it does. The mirror itself keeps running. Requests made on the Pi itself (`curl http://localhost:8081/...` over SSH) need no login, which is the way back in.

`mirror/lib/household-login.js` is the check. It assumes two things about the login server: the session cookie's name (`login.cookie`, `household_auth` by default) and that `/api/v1/auth/me` answers 200 with `data.user.email` for a live session and 401 otherwise.

The page has a port of its own (8081). MagicMirror itself answers only on the Pi (`address: "localhost"`), because third-party modules often trust whatever reaches MagicMirror's socket and routes.

### Check what the mirror thinks

```sh
curl http://localhost:8081/api/status
journalctl -t magicmirror | grep MMM-Household
```

## Lights

`MMM-Lights` switches the household's lights by voice through Home Assistant, which runs on another machine in the house, and shows a card with what each light is doing.

| Say                                               | What happens                                                 |
| ------------------------------------------------- | ------------------------------------------------------------ |
| "Mirror, turn on the bedroom lights"              | The lights come on. "Bedroom lights on" means the same       |
| "Mirror, turn off the bedroom lights"             | The lights go off                                            |
| "Mirror, set the bedroom lights to fifty percent" | Ten, twenty five, fifty, seventy five or one hundred percent |
| "Mirror, bedroom evening"                         | Sets the scene of that name                                  |
| "Mirror, christmas lights"                        | Every light goes red or green and keeps switching            |
| "Mirror, thanksgiving lights"                     | The same for another holiday, in its colors (list below)     |
| "Mirror, lights back to normal"                   | Puts the lights back the way they were                       |
| "Mirror, turn off the upstairs lights"            | A whole floor, upstairs or downstairs                        |
| "Mirror, white lights"                            | Ends a show and turns the lights that are on to warm white   |
| "Mirror, christmas music"                         | A holiday station on the HomePods, the TVs and the mirror    |
| "Mirror, stop the music"                          | Stops it everywhere                                          |

The rooms are the bedroom, living room, kitchen, dining room, nook, stairwell, landing, office, guest room and sitting room, each said with "lights" after it: "Mirror, turn off the kitchen lights".

"Upstairs lights" and "downstairs lights" are groups of whole floors. They take every command a room takes and have no row on the card (`card: false`). A light switched off during a holiday show stays off, and "lights back to normal" puts back only the lights that are still on.

A command always names the state it wants, so a command the microphone hears twice does nothing the second time. After a command the helper asks Home Assistant what each bulb reports and the mirror says that: "Bedroom lights on", "Bedroom lights: 1 of 2 answered" when a bulb is off at the wall, or "I could not reach the house controls". It never answers from the words alone.

The lights and scenes the mirror may use are the `lights` and `scenes` lists at the top of `config.js`. Each has the name people say, and a light can be a single bulb or a group in Home Assistant. The helper takes the lists from the server's config and accepts only a command id from the page, so the page cannot name another device. To add a room, make a light group in Home Assistant, add it to `lights`, and check its words with `voice.py --check-words`.

An entry in `scenes` can also name a Home Assistant script, which is how the holiday lights work. Each show is a script there that remembers what every light is doing and turns the lights to that holiday's colors, and `script.christmas_lights_off` puts them back whichever show is on. What plays, and how fast, is decided in those scripts, so it can change without a change here. A script entry lists the lights to count afterwards in `members`, more ways to say it in `also`, and the mirror's answer in `done`. With `quiet: true` the mirror says nothing when the scene worked. The helper starts only a scene or a script, and only one that the config lists.

The shows, each said as "NAME lights" or "turn on the NAME lights": christmas, thanksgiving, hanukkah (also snow, blue and white), candy cane, new year (also gold), party (also birthday), valentine (also pink), saint patrick (also green and gold), easter (also pastel), fourth of july (also red white and blue), halloween (also orange and purple). "Christmas lights off", "holiday lights off" and "lights back to normal" all end a show.

A special day can set a scene too. Give its entry `"scene": "KEY"`, and when the line is spoken `MMM-Briefing` sends the command `light:scene:KEY`, which `MMM-Lights` carries out if its config lists that scene.

### Music

"Mirror, christmas music" runs `script.christmas_music_on` in Home Assistant, which starts a holiday radio station on the HomePods and the TVs and turns on the switch `input_boolean.christmas_music`. `MMM-Radio` looks at that switch every ten seconds, and right after a spoken command, and plays the same station on the mirror's own speaker with `ffmpeg` while the switch is on. So the Home Assistant app can start and stop the mirror's music too. Each player buffers by itself, and they are a second or two apart.

The mirror has one speaker. When the mirror is about to speak, the radio stops, and it starts again when the line has ended. The microphone hears the music, so "mirror, stop the music" may need to be said loudly. The station is `MIRROR_RADIO_STREAM` in `config.env`, or SomaFM's Christmas Lounge when that is not set.

The module directory has radio players: `MMM-MyRadio` (mpg123 with playlists and its own display), `MMM-MplayerRadio` (mplayer or VLC with playlists) and `MMM-InternetRadio` (drives station web pages). None follows a switch elsewhere or yields the speaker to a voice, and each would add a player the Pi does not have, so this is a small module of our own.

`MIRROR_HA_URL` in `config.env` is Home Assistant's address and `SECRET_HA_TOKEN` is a long-lived access token of a Home Assistant user made for the mirror, so Home Assistant's logbook tells the mirror's commands from a person's. The token stays in the node helper. With the address empty the mirror has no light commands and no card.

The module directory has several Home Assistant modules. They show sensor values or need a touch screen, and none takes a spoken command and reports back, so this one is our own. It keeps no copy of a light's state: the card and every answer are read from Home Assistant when they are needed.

## Install on the Pi

The target is Ubuntu Server 24.04 (arm64) on a Raspberry Pi 4.

```sh
git clone https://github.com/crankyMagician/MagicMirror.git ~/MagicMirror
sudo ~/MagicMirror/mirror/deploy/setup-pi.sh
```

The script installs Node.js 24, sway and the libraries Electron needs. It links the config into place and enables `magicmirror-server.service` and `magicmirror-kiosk.service`. Run it again after pulling new code.

## How it runs

Two systemd units, both started at boot:

- `magicmirror-server.service` is MagicMirror's server: the settings page, the camera, the microphone and the speaker. It has no window and needs no display.
- `magicmirror-kiosk.service` is the screen. It starts sway on tty1 as the login user, and sway starts Electron, which shows the server's page. When Electron exits sway exits too, so systemd restarts the whole session.

The server does not depend on the kiosk. With no monitor attached the kiosk cannot draw, and the settings page keeps working: `MMM-Household` remembers the config and the feature list the page last sent (`~/mirror-data/household-last.json`) and starts from them. What the mirror shows and says still comes from the page on the screen. When the server restarts, the page on the screen loads again by itself.

```sh
systemctl status magicmirror-server magicmirror-kiosk
journalctl -t magicmirror -f               # the server's log, with every module's lines
journalctl -t magicmirror-screen -f        # Electron's own lines
sudo systemctl restart magicmirror-server  # after a change to config.js or a node helper
sudo systemctl restart magicmirror-kiosk   # after a change to the sway config
```

A change to a module's browser code or to `custom.css` needs only a reload of the page, which a server restart also causes.

## Rotate the screen

Open the settings page, go to the Mirror tab and choose under "Screen". The picture turns at once, without a restart, and the choice is kept in `profiles.json` and applied again each time the mirror starts.

`/etc/magicmirror-kiosk/output.conf` on the Pi holds the direction sway starts with, before anything is chosen on the page. `transform 90` and `transform 270` are the two portrait directions, `transform normal` is landscape and `transform 180` is landscape upside down. Restart the service after editing it.

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
