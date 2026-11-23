const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const NodeHelper = require("node_helper");
const Log = require("logger");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const PYTHON = path.join(DATA_DIR, "venv", "bin", "python");
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.presence = null;
		this.person = null;
		this.people = [];
		this.screenOn = true;
		this.offTimer = null;
		this.restartDelay = 2000;
		this.stopping = false;

		this.expressApp.get("/household/api/status", (req, res) => {
			res.json({ person: this.person, people: this.people, screenOn: this.screenOn, running: this.presence !== null });
		});
		this.expressApp.post("/household/api/enroll", (req, res) => {
			const name = String(req.query.name || "").toLowerCase();
			if (!NAME_PATTERN.test(name)) {
				res.status(400).json({ error: "Give a lowercase name, for example ?name=sam" });
				return;
			}
			if (!this.sendCommand({ cmd: "enroll", name, samples: 20 })) {
				res.status(503).json({ error: "The presence service is not running" });
				return;
			}
			res.json({ enrolling: name });
		});
	},

	stop () {
		this.stopping = true;
		this.cancelScreenOff();
		if (this.presence) {
			this.presence.kill();
		}
		// Leave the screen on when MagicMirror exits, so a crash is visible.
		this.setScreen(true);
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "CONFIG") {
			return;
		}
		// The browser sends CONFIG again on every reload. Start the service once
		// and answer a reload with the current state.
		if (this.config === null) {
			this.config = payload;
			this.startPresence();
			this.scheduleScreenOff();
		} else {
			this.sendSocketNotification("PRESENCE", { person: this.person, unknown: false });
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
				this.people = message.people;
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
		this.sendSocketNotification("PRESENCE", { person, unknown });
		if (person) {
			this.cancelScreenOff();
			this.setScreen(true);
		} else {
			this.scheduleScreenOff();
		}
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
			if (!this.person && this.presence) {
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
