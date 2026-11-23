const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const express = require("express");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { DEFAULT_BLOCKS, ProfileStore, currentBlock, inRange, problemWith } = require("./profiles");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const PYTHON = path.join(DATA_DIR, "venv", "bin", "python");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

// Options the helper needs before the browser sends its config.
const SERVER_DEFAULTS = { settingsPort: 8081, settingsAllow: ["127.0.0.1", "::1"] };

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.presence = null;
		this.person = null;
		this.unknown = false;
		this.enrolled = [];
		this.features = [];
		this.blocks = DEFAULT_BLOCKS;
		this.store = new ProfileStore(PROFILES_FILE);
		this.lastView = "";
		this.screenOn = true;
		this.offTimer = null;
		this.restartDelay = 2000;
		this.stopping = false;

		// Quiet hours and the blocks of the day change with the clock, not with
		// the camera, so the view is recomputed on a timer as well.
		this.clock = setInterval(() => this.refresh(), 30000);

		this.startSettingsServer();
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
		app.use((req, res, next) => {
			res.set({
				"Content-Security-Policy": "default-src 'self'",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer"
			});
			next();
		});
		this.addRoutes(app);
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
			res.json({
				people: this.config.people,
				enrolled: this.enrolled,
				blocks: this.blocks,
				features: this.features,
				profiles: Object.fromEntries(this.config.people.map((name) => [name, this.profileOf(name)])),
				now: { person: this.person, unknown: this.unknown, quiet: view.quiet, block: view.block, screenOn: this.screenOn, camera: this.presence !== null }
			});
		});

		app.put("/api/profiles/:name", jsonOnly, json, (req, res) => {
			const name = req.params.name;
			if (!this.config || !this.config.people.includes(name)) {
				res.status(404).json({ error: "Nobody on this mirror has that name" });
				return;
			}
			const problem = problemWith(req.body, this.featureKeysFor(name), this.blocks);
			if (problem) {
				res.status(400).json({ error: problem });
				return;
			}
			try {
				this.store.set(name, req.body);
			} catch (error) {
				Log.error(`Could not save the profile of ${name}: ${error.message}`);
				res.status(500).json({ error: "The mirror could not save that" });
				return;
			}
			Log.log(`Saved the profile of ${name}`);
			this.refresh();
			res.json({ profile: this.profileOf(name) });
		});

		app.post("/api/enroll", jsonOnly, json, (req, res) => {
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
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CONFIG") {
			// The browser sends CONFIG again on every reload. Start the service
			// once and answer a reload with the current state.
			if (this.config === null) {
				this.config = payload;
				this.startPresence();
				this.scheduleScreenOff();
			}
			this.lastView = "";
			this.refresh();
		} else if (notification === "FEATURES") {
			this.features = payload;
			this.lastView = "";
			this.refresh();
		}
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
		const block = currentBlock(this.blocks, now).key;
		const view = { person: this.person, unknown: this.unknown, quiet: false, block, features: null };
		if (this.person && this.config && this.config.people.includes(this.person)) {
			const profile = this.profileOf(this.person);
			const quiet = profile.quietHours;
			if (quiet.enabled && inRange(quiet.from, quiet.to, now)) {
				// In quiet hours the mirror treats the person as absent.
				view.person = null;
				view.quiet = true;
			} else {
				view.features = profile.blocks[block];
			}
		}
		return view;
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
		}
		this.person = person;
		this.unknown = Boolean(unknown);
		this.refresh();
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

	setScreen (on) {
		if (on === this.screenOn) {
			return;
		}
		this.screenOn = on;
		if (!process.env.SWAYSOCK) {
			Log.log(`Screen ${on ? "on" : "off"} (skipped, not running under sway)`);
			return;
		}
		// The screen is blanked by disabling the output. `output power off` also
		// blanks it, but Electron's Wayland backend crashes when the output
		// powers back on after more than a few seconds.
		execFile("swaymsg", ["output", "*", on ? "enable" : "disable"], (error) => {
			if (error) {
				Log.error(`swaymsg failed: ${error.message}`);
			} else {
				Log.log(`Screen ${on ? "on" : "off"}`);
			}
		});
	}
});
