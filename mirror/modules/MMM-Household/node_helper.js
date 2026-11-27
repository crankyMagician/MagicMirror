const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const express = require("express");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { createLogin, hostAllowed, mayActFor, ownOnly } = require("../../lib/household-login");
const { DEFAULTS: SPEAK_DEFAULTS } = require("../MMM-Speak/speech");
const { createSynth } = require("../MMM-Speak/synth");
const { ProfileStore, canFocus, normalize, problemWith, problemWithMirror, viewFor } = require("./profiles");
const { ROTATIONS, currentRotation, swayArguments } = require("./rotation");
const { swaymsg } = require("./sway");
const { addUniFiRoutes } = require("./unifi-routes");
const { addVoiceRoutes, voicesOn } = require("./voice-routes");
const { createVocabularyCheck, phraseProblem, startsWithPhrase, tidyPhrase } = require("./wake-phrase");
const { addPhotoRoutes } = require("./photos-routes");
const { addArtRoutes } = require("./art-feed");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const PYTHON = path.join(DATA_DIR, "venv", "bin", "python");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
// What the page on the screen last told this helper: the module's config with
// its defaults, and the list of features. See remember() below.
const REMEMBERED_FILE = path.join(DATA_DIR, "household-last.json");
// The spoken commands, written by MMM-Voice for the Mirror tab.
const VOICE_COMMANDS_FILE = path.join(DATA_DIR, "voice-commands.json");

// Options the helper needs before the browser sends its config.
const SERVER_DEFAULTS = { settingsPort: 8081, settingsAllow: ["127.0.0.1", "::1"], settingsHosts: ["localhost", "mirror", "mirror.local"], login: {} };

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.presence = null;
		this.person = null;
		this.unknown = false;
		this.enrolled = [];
		this.features = [];
		this.store = new ProfileStore(PROFILES_FILE);
		// The parts of the day and quiet hours belong to the mirror, not to a person.
		this.mirror = this.store.getMirror();
		this.blocks = this.mirror.blocks;
		// Asks the speech model whether it knows the words of a new wake phrase.
		this.checkVocabulary = createVocabularyCheck({ python: PYTHON, script: path.resolve(fs.realpathSync(this.path), "../../services/voice.py") });
		// When the mirror last heard a spoken command, for the page's "try it" step.
		this.heardAt = 0;
		this.lastView = "";
		// Set by voice commands. They last until the person leaves.
		this.wakeUntil = 0;
		this.asleep = null;
		this.overrides = {};
		// The one feature someone asked to see alone, and the timer that ends it.
		this.focus = null;
		this.focusTimer = null;
		this.screenOn = true;
		this.offTimer = null;
		this.restartDelay = 2000;
		this.stopping = false;
		// Which way the picture faces right now, as sway reports it.
		this.rotationNow = "";

		// Quiet hours and the blocks of the day change with the clock, not with
		// the camera, so the view is recomputed on a timer as well.
		this.clock = setInterval(() => this.refresh(), 30000);

		this.startSettingsServer();
		this.recall();
		// A direction saved on the settings page wins over the kiosk's
		// output.conf. The kiosk applies it itself before it draws anything
		// (kiosk-session.sh). This covers a server that starts while a kiosk
		// is already running.
		if (this.mirror.rotation) {
			this.applyRotation();
		} else {
			this.readRotation();
		}
	},

	/**
	 * Serves the settings page and its API on a port of their own.
	 *
	 * MagicMirror itself listens on localhost only. Third-party modules often
	 * trust whatever reaches MagicMirror's socket and routes, so nothing but
	 * this page is offered to the home network.
	 */
	startSettingsServer () {
		const options = { ...SERVER_DEFAULTS, ...this.getServerModuleConfig() };
		// MagicMirror's own middleware: refuses other origins and addresses outside the list.
		const { ipAccessControl } = require(path.join(global.root_path, "js", "ip_access_control"));
		const app = express();
		app.disable("x-powered-by");
		app.use(ipAccessControl(options.settingsAllow, []));

		// The page answers only to the mirror's own names and to bare
		// addresses. A page elsewhere that points its own name at the mirror
		// is refused, whatever address its visitor comes from.
		const loginOptions = options.login || {};
		const hosts = [...options.settingsHosts, ...(loginOptions.host ? [loginOptions.host] : [])];
		app.use((req, res, next) => {
			if (!hostAllowed(req.headers.host, hosts)) {
				res.status(421).json({ error: "That is not one of the mirror's names" });
				return;
			}
			next();
		});

		// With a login server configured, the page talks to it from the browser.
		const login = createLogin({ authUrl: loginOptions.authUrl, cookie: loginOptions.cookie || "household_auth", accounts: loginOptions.accounts });
		const authOrigin = login.enabled ? new URL(login.authUrl).origin : "";
		const policy = login.enabled ? `default-src 'self'; connect-src 'self' ${authOrigin}` : "default-src 'self'";
		app.use((req, res, next) => {
			res.set({
				"Content-Security-Policy": policy,
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer"
			});
			next();
		});

		// Says whether login is on and who is signed in. It is the one address
		// under /api that needs no login, so the page can decide what to show.
		app.get("/api/session", async (req, res) => {
			const who = await login.identify(req);
			res.set("Cache-Control", "no-store");
			res.json({
				login: login.enabled,
				signedIn: who.status === 200,
				refused: who.status === 403,
				problem: who.status === 200 ? null : who.error,
				email: who.email || null,
				person: who.person || null,
				authUrl: login.enabled ? login.authUrl : null,
				home: login.enabled && loginOptions.host ? `https://${loginOptions.host}/` : null
			});
		});
		if (login.enabled) {
			Log.log(`The settings page asks ${authOrigin} who is signed in`);
			app.use(["/api", "/unifi"], login.middleware);
		}
		this.addRoutes(app);
		addUniFiRoutes(app, { port: global.config.port || 8080, basePath: global.config.basePath || "/" });
		this.settingsServer = app.listen(options.settingsPort, "0.0.0.0", () => {
			Log.log(`Settings page listening on port ${options.settingsPort}`);
		});
		this.settingsServer.on("error", (error) => Log.error(`The settings page could not start: ${error.message}`));
	},

	stop () {
		this.stopping = true;
		clearInterval(this.clock);
		if (this.settingsServer) {
			this.settingsServer.close();
		}
		if (this.stopArt) {
			this.stopArt();
		}
		this.cancelScreenOff();
		if (this.presence) {
			this.presence.kill();
		}
		// Leave the screen on when MagicMirror exits, so a crash is visible.
		this.setScreen(true);
	},

	addRoutes (app) {
		const publicDir = path.join(fs.realpathSync(this.path), "public");
		const json = express.json({ limit: "20kb" });
		// A request that changes something must be JSON. A web page on another
		// site cannot send that to the mirror without the browser asking first.
		const jsonOnly = (req, res, next) => {
			if (!req.is("application/json")) {
				res.status(415).json({ error: "Send JSON with Content-Type: application/json" });
				return;
			}
			next();
		};

		app.get("/", (req, res) => res.sendFile(path.join(publicDir, "settings.html")));
		// The login server sends a person here after signing in with Google.
		app.get("/login", (req, res) => res.sendFile(path.join(publicDir, "settings.html")));
		app.use(express.static(publicDir, { index: false }));

		app.get("/api/status", (req, res) => {
			res.json({ person: this.person, people: this.enrolled, screenOn: this.screenOn, running: this.presence !== null });
		});

		app.get("/api/state", (req, res) => {
			if (!this.config) {
				res.status(503).json({ error: "The mirror is still starting" });
				return;
			}
			const view = this.computeView(new Date());
			// A signed-in person gets their own settings and nobody else's.
			const people = this.config.people.filter((name) => mayActFor(req.login, name));
			res.json({
				people,
				enrolled: this.enrolled,
				blocks: this.blocks,
				mirror: this.mirror,
				// The directions the screen can face, and the one it faces now.
				rotations: ROTATIONS,
				rotationNow: this.mirror.rotation || this.rotationNow,
				voices: voicesOn(this.speakConfig()),
				features: this.features,
				// What people can say, as MMM-Voice last wrote it.
				voiceCommands: this.voiceCommands(),
				profiles: Object.fromEntries(people.map((name) => [name, this.profileOf(name)])),
				now: { person: this.person, unknown: this.unknown, quiet: view.quiet, block: view.block, theme: view.theme, screenOn: this.screenOn, camera: this.presence !== null, heardAt: this.heardAt }
			});
		});

		app.put("/api/profiles/:name", ownOnly((req) => req.params.name), jsonOnly, json, (req, res) => {
			const name = req.params.name;
			if (!this.config || !this.config.people.includes(name)) {
				res.status(404).json({ error: "Nobody on this mirror has that name" });
				return;
			}
			const problem = problemWith(req.body, this.featureKeysFor(name), this.blocks, this.voiceIds());
			if (problem) {
				res.status(400).json({ error: problem });
				return;
			}
			try {
				// Store only what a profile holds, so fields from an older page are dropped.
				this.store.set(name, normalize({ ...req.body, theme: req.body.theme ?? this.profileOf(name).theme }, this.featureKeysFor(name), this.blocks));
			} catch (error) {
				Log.error(`Could not save the profile of ${name}: ${error.message}`);
				res.status(500).json({ error: "The mirror could not save that" });
				return;
			}
			Log.log(`Saved the profile of ${name}`);
			this.refresh();
			res.json({ profile: this.profileOf(name) });
		});

		app.put("/api/mirror", jsonOnly, json, async (req, res) => {
			const problem = problemWithMirror(req.body, this.voiceIds());
			if (problem) {
				res.status(400).json({ error: problem });
				return;
			}
			// The page does not set the wake phrase. It proposes a candidate, and
			// the candidate takes over once the mirror has heard it. A page from
			// before the mirror had a voice or a name does not send those. Keep them.
			const next = { voice: this.mirror.voice, name: this.mirror.name, rotation: this.mirror.rotation, wakeScreen: this.mirror.wakeScreen, ...req.body, wakePhrase: this.mirror.wakePhrase, wakeCandidate: this.mirror.wakeCandidate };
			const turned = next.rotation !== this.mirror.rotation;
			if (req.body.wakeCandidate !== undefined) {
				const candidate = tidyPhrase(req.body.wakeCandidate);
				if (candidate === "" || candidate === this.mirror.wakePhrase) {
					next.wakeCandidate = "";
				} else if (candidate !== this.mirror.wakeCandidate) {
					const shape = phraseProblem(candidate);
					if (shape) {
						res.status(400).json({ error: shape });
						return;
					}
					let missing;
					try {
						missing = await this.checkVocabulary(candidate);
					} catch (error) {
						Log.warn(`Could not check a wake phrase: ${error.message}`);
						res.status(503).json({ error: "The mirror could not check that phrase just now. Nothing was changed." });
						return;
					}
					if (missing.length > 0) {
						res.status(400).json({ error: `The mirror's speech model does not know ${missing.map((word) => `"${word}"`).join(" or ")}. Try other words.` });
						return;
					}
					next.wakeCandidate = candidate;
				}
			}
			try {
				this.store.setMirror(next);
			} catch (error) {
				Log.error(`Could not save the mirror settings: ${error.message}`);
				res.status(500).json({ error: "The mirror could not save that" });
				return;
			}
			this.mirror = this.store.getMirror();
			this.blocks = this.mirror.blocks;
			Log.log("Saved the mirror settings");
			if (turned && this.mirror.rotation) {
				this.applyRotation();
			}
			this.sendMirror();
			this.refresh();
			res.json({ mirror: this.mirror });
		});

		app.post("/api/enroll", jsonOnly, json, ownOnly((req) => String((req.body && req.body.name) || "")), (req, res) => {
			const name = String((req.body && req.body.name) || "");
			if (!this.config || !this.config.people.includes(name)) {
				res.status(400).json({ error: "Give the name of someone on this mirror" });
				return;
			}
			if (!this.sendCommand({ cmd: "enroll", name, samples: 20 })) {
				res.status(503).json({ error: "The camera service is not running" });
				return;
			}
			res.json({ enrolling: name });
		});

		// Each person's slideshow photos, chosen through Google's photo picker.
		const photoAccounts = this.getServerModuleConfig().photoAccounts || {};
		addPhotoRoutes(app, {
			people: () => (this.config ? this.config.people : []),
			accountFor: (person) => photoAccounts[person] || `${person}-personal`,
			googleDir: path.join(DATA_DIR, "google"),
			photosDir: path.join(DATA_DIR, "photos"),
			guards: [jsonOnly, json],
			own: ownOnly((req) => req.params.person),
			log: Log
		});

		// A short sample of each voice, for choosing one on the page.
		addVoiceRoutes(app, {
			speakConfig: () => this.speakConfig(),
			synth: createSynth({ cacheDir: path.join(DATA_DIR, "speech"), log: Log }),
			log: Log
		});

		// A person's frame can show paintings from a published feed instead.
		this.stopArt = addArtRoutes(app, {
			feeds: this.getServerModuleConfig().artFeeds || {},
			own: ownOnly((req) => req.params.person),
			artDir: path.join(DATA_DIR, "art"),
			log: Log
		});
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CONFIG") {
			// The browser sends CONFIG again on every reload. Start the service
			// once and answer a reload with the current state.
			const first = this.config === null;
			this.config = payload;
			this.remember();
			if (first) {
				this.startPresence();
				this.scheduleScreenOff();
			} else {
				// The page loaded again, which is also what a new kiosk session
				// looks like from here. A new session starts with the screen on
				// and knows nothing of what this helper decided before.
				this.sendScreen();
				if (!this.mirror.rotation) {
					this.readRotation();
				}
			}
			this.lastView = "";
			this.sendMirror();
			this.refresh();
		} else if (notification === "FEATURES") {
			this.features = payload;
			this.remember();
			this.lastView = "";
			this.refresh();
		} else if (notification === "VOICE") {
			this.handleVoice(payload);
		} else if (notification === "HEARD_NAME") {
			this.heardName();
		}
	},

	/**
	 * Reads the summary of spoken commands that MMM-Voice keeps.
	 * @returns {object|null} { wake, groups } or null before MMM-Voice wrote one
	 */
	voiceCommands () {
		try {
			const summary = JSON.parse(fs.readFileSync(VOICE_COMMANDS_FILE, "utf8"));
			return summary && Array.isArray(summary.groups) ? summary : null;
		} catch {
			return null;
		}
	},

	/**
	 * Turns a dark screen on when someone says the mirror's name, so they can
	 * see it listening. It goes dark again after the absent delay when nobody
	 * is recognized. The Mirror tab can switch this off.
	 */
	heardName () {
		if (!this.config || this.mirror.wakeScreen === false || this.screenOn) {
			return;
		}
		Log.log("Heard its name, so the screen comes on");
		this.setScreen(true);
		if (!this.person) {
			this.scheduleScreenOff();
		}
	},

	/**
	 * Acts on a spoken command relayed from MMM-Voice.
	 * @param {object} command the command, with an `id` such as "wake_up" or "hide:calendar"
	 */
	/** Tells the other modules the mirror's name and what to listen for. */
	/**
	 * Keeps what the page on the screen sent, so the next start does not have
	 * to wait for a screen. The config and the feature list come from the
	 * browser, and without them the settings page has nothing to show. With
	 * no monitor attached no page ever loads.
	 */
	remember () {
		try {
			fs.writeFileSync(`${REMEMBERED_FILE}.tmp`, JSON.stringify({ config: this.config, features: this.features }), { mode: 0o600 });
			fs.renameSync(`${REMEMBERED_FILE}.tmp`, REMEMBERED_FILE);
		} catch (error) {
			Log.warn(`Could not keep the config for the next start: ${error.message}`);
		}
	},

	/**
	 * Starts from what the page sent last time. The page replaces it as soon
	 * as one loads.
	 */
	recall () {
		let last;
		try {
			last = JSON.parse(fs.readFileSync(REMEMBERED_FILE, "utf8"));
		} catch {
			return;
		}
		if (!last || typeof last.config !== "object" || last.config === null || !Array.isArray(last.config.people)) {
			return;
		}
		this.config = last.config;
		this.features = Array.isArray(last.features) ? last.features : [];
		Log.log("Started from the config the screen sent last time");
		this.startPresence();
		this.scheduleScreenOff();
	},

	sendMirror () {
		this.sendSocketNotification("MIRROR", { name: this.mirror.name, wakePhrase: this.mirror.wakePhrase, wakeCandidate: this.mirror.wakeCandidate });
	},

	handleVoice (command) {
		if (!this.config || !command || typeof command.id !== "string") {
			return;
		}
		this.heardAt = Date.now();
		// A new wake phrase that the mirror has now heard takes over.
		if (startsWithPhrase(command.text, this.mirror.wakeCandidate)) {
			try {
				this.store.setMirror({ ...this.mirror, wakePhrase: this.mirror.wakeCandidate, wakeCandidate: "" });
				this.mirror = this.store.getMirror();
				Log.log("The new wake phrase was heard and has taken over");
				this.sendMirror();
			} catch (error) {
				Log.error(`Could not save the new wake phrase: ${error.message}`);
			}
		}
		const [action, feature] = command.id.split(":");
		if (action === "wake_up") {
			this.asleep = null;
			this.wakeUntil = Date.now() + this.config.wakeMinutes * 60 * 1000;
			Log.log("Voice: wake up");
		} else if (action === "good_night") {
			this.clearFocus();
			this.wakeUntil = 0;
			this.asleep = this.person;
			Log.log("Voice: good night");
			this.refresh();
			// Do not wait out the absent delay. They asked for the dark.
			this.cancelScreenOff();
			if (this.presence) {
				this.setScreen(false);
			}
			return;
		} else if ((action === "show" || action === "hide") && this.features.some((known) => known.key === feature)) {
			this.overrides[feature] = action === "show";
			Log.log(`Voice: ${action} ${feature}`);
		} else if (action === "only" && this.features.some((known) => known.key === feature)) {
			const known = this.features.find((entry) => entry.key === feature);
			if (!canFocus(this.features, feature, this.person)) {
				// It belongs to someone else, or nobody is recognized.
				Log.log(`Voice: show only ${feature}, which is not on this view`);
				this.sendSocketNotification("SAY", { id: `focus-${Date.now()}`, text: `${known.label} is not on your view.` });
				return;
			}
			if (!this.person) {
				// With nobody recognized this also wakes the shared view.
				this.asleep = null;
				this.wakeUntil = Date.now() + this.config.wakeMinutes * 60 * 1000;
			}
			this.clearFocus();
			this.focus = feature;
			this.focusTimer = setTimeout(() => {
				this.focus = null;
				this.focusTimer = null;
				this.refresh();
			}, this.config.focusSeconds * 1000);
			Log.log(`Voice: show only ${feature}`);
		} else if (action === "show_all") {
			this.clearFocus();
			Log.log("Voice: show everything");
		} else {
			return;
		}
		this.refresh();
	},

	/**
	 * Reads MMM-Speak's config, which holds the voices people can choose.
	 * @returns {object} its config over its defaults, or the defaults alone without the module
	 */
	speakConfig () {
		const entry = (global.config.modules || []).find((module) => module.module === "MMM-Speak" && !module.disabled);
		return { ...SPEAK_DEFAULTS, ...(entry && entry.config) };
	},

	voiceIds () {
		return voicesOn(this.speakConfig()).map((voice) => voice.id);
	},

	/**
	 * Lists the features one person can switch on and off: the shared ones and
	 * their own.
	 * @param {string} name a person on this mirror
	 * @returns {string[]} feature keys
	 */
	featureKeysFor (name) {
		return this.features.filter((feature) => feature.owners.length === 0 || feature.owners.includes(name)).map((feature) => feature.key);
	},

	profileOf (name) {
		return this.store.get(name, this.featureKeysFor(name), this.blocks);
	},

	/**
	 * Works out what the mirror should show right now.
	 * @param {Date} now the current time
	 * @returns {object} who the view is for, the block of the day and that person's feature switches
	 */
	computeView (now) {
		const hasProfile = this.person && this.config && this.config.people.includes(this.person);
		return viewFor({
			person: this.person,
			unknown: this.unknown,
			profile: hasProfile ? this.profileOf(this.person) : null,
			blocks: this.blocks,
			quietHours: this.mirror.quietHours,
			mirrorVoice: this.mirror.voice,
			wakeUntil: this.wakeUntil,
			asleep: this.asleep,
			overrides: this.overrides,
			focus: this.focus
		}, now);
	},

	/**
	 * Recomputes the view, sends it to the browser when it changed and keeps
	 * the screen in step with it.
	 */
	refresh () {
		if (!this.config) {
			return;
		}
		const view = this.computeView(new Date());
		const serialized = JSON.stringify(view);
		if (serialized !== this.lastView) {
			this.lastView = serialized;
			this.sendSocketNotification("VIEW", view);
		}
		if (view.person) {
			this.cancelScreenOff();
			this.setScreen(true);
		} else {
			this.scheduleScreenOff();
		}
	},

	startPresence () {
		const script = path.resolve(fs.realpathSync(this.path), "../../services/presence.py");
		if (!fs.existsSync(PYTHON) || !fs.existsSync(script)) {
			Log.error(`Missing ${PYTHON} or ${script}. Run mirror/deploy/setup-pi.sh. Presence is off and the screen stays on.`);
			return;
		}
		const args = [script, "--camera", String(this.config.camera), "--hold", String(this.config.holdSeconds)];
		Log.log(`Starting presence service on ${this.config.camera}`);
		const child = spawn(PYTHON, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.presence = child;

		readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
		readline.createInterface({ input: child.stderr }).on("line", (line) => Log.warn(`presence: ${line}`));
		child.on("error", (error) => Log.error(`Could not start the presence service: ${error.message}`));
		child.on("exit", (code) => {
			this.presence = null;
			if (this.stopping) {
				return;
			}
			// With no camera there is no way to wake the screen, so keep it on.
			this.setPerson(null);
			this.cancelScreenOff();
			this.setScreen(true);
			Log.warn(`Presence service exited with code ${code}. Restarting in ${this.restartDelay / 1000} s.`);
			setTimeout(() => this.startPresence(), this.restartDelay);
			this.restartDelay = Math.min(this.restartDelay * 2, 60000);
		});
	},

	sendCommand (command) {
		if (!this.presence) {
			return false;
		}
		this.presence.stdin.write(`${JSON.stringify(command)}\n`);
		return true;
	},

	handleLine (line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			Log.warn(`presence: ${line}`);
			return;
		}
		switch (message.type) {
			case "ready":
				this.enrolled = message.people;
				this.restartDelay = 2000;
				Log.log(`Presence service ready. Enrolled: ${message.people.join(", ") || "nobody (any face counts as a guest)"}`);
				break;
			case "presence":
				this.setPerson(message.person, message.unknown);
				break;
			case "enroll":
				if (message.captured === 0) {
					this.alert(`Enrolling ${message.name}`, "Look at the mirror and turn your head slowly.", 60000);
				}
				break;
			case "enrolled":
				Log.log(`Enrolled ${message.name} with ${message.samples} samples`);
				this.alert(`Enrolled ${message.name}`, "The mirror knows you now.", 5000);
				break;
			case "error":
				Log.error(`presence: ${message.message}`);
				break;
			default:
				break;
		}
	},

	alert (title, message, timer) {
		this.setScreen(true);
		// Waking the screen for a notice must not leave it on with nobody there.
		if (!this.person) {
			this.scheduleScreenOff();
		}
		this.sendSocketNotification("ALERT", { type: "notification", title, message, timer });
	},

	setPerson (person, unknown = false) {
		if (person !== this.person) {
			Log.log(`Present: ${person || (unknown ? "an unknown face" : "nobody")}`);
			// What a person asked for by voice ends when they leave.
			this.asleep = null;
			this.overrides = {};
			this.clearFocus();
		}
		this.person = person;
		this.unknown = Boolean(unknown);
		this.refresh();
	},

	clearFocus () {
		clearTimeout(this.focusTimer);
		this.focusTimer = null;
		this.focus = null;
	},

	cancelScreenOff () {
		clearTimeout(this.offTimer);
		this.offTimer = null;
	},

	scheduleScreenOff () {
		// The timer only makes sense while the camera can wake the screen again.
		if (this.offTimer || !this.screenOn || !this.presence) {
			return;
		}
		this.offTimer = setTimeout(() => {
			this.offTimer = null;
			if (this.presence && !this.computeView(new Date()).person) {
				this.setScreen(false);
			}
		}, this.config.absentDelay * 1000);
	},

	/**
	 * Turns the picture to the saved direction. sway keeps a direction that
	 * is set while the screen is off and uses it when the screen comes back.
	 */
	applyRotation () {
		const rotation = this.mirror.rotation;
		swaymsg(swayArguments(rotation), (error) => {
			if (error && error.noSession) {
				Log.log(`Screen direction ${rotation} (skipped, no kiosk is running)`);
			} else if (error) {
				Log.error(`swaymsg failed: ${error.message}`);
			} else {
				this.rotationNow = rotation;
				Log.log(`Screen direction set to ${rotation}`);
			}
		});
	},

	/**
	 * Asks sway which way the picture faces, for the settings page to show
	 * before anyone has chosen a direction there.
	 */
	readRotation () {
		swaymsg(["-t", "get_outputs", "-r"], (error, stdout) => {
			if (!error) {
				this.rotationNow = currentRotation(stdout) || this.rotationNow;
			}
		});
	},

	setScreen (on) {
		if (on === this.screenOn) {
			return;
		}
		this.screenOn = on;
		this.sendScreen();
	},

	/**
	 * Tells the kiosk's sway session whether the screen is on.
	 *
	 * The screen is blanked by disabling the output. `output power off` also
	 * blanks it, but Electron's Wayland backend crashes when the output powers
	 * back on after more than a few seconds.
	 */
	sendScreen () {
		const on = this.screenOn;
		swaymsg(["output", "*", on ? "enable" : "disable"], (error) => {
			if (error && error.noSession) {
				Log.log(`Screen ${on ? "on" : "off"} (skipped, no kiosk is running)`);
			} else if (error) {
				Log.error(`swaymsg failed: ${error.message}`);
			} else {
				Log.log(`Screen ${on ? "on" : "off"}`);
			}
		});
	}
});
