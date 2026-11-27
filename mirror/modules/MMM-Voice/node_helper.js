const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { buildCommands, summarize, toneWav, wakesOf, TONES } = require("./commands");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const PYTHON = path.join(DATA_DIR, "venv", "bin", "python");
const SOUNDS = path.join(DATA_DIR, "sounds");
// What people can say, for the settings page (MMM-Household reads it).
const COMMANDS_FILE = path.join(DATA_DIR, "voice-commands.json");
// The microphone ignores this much audio while a tone plays.
const TONE_HOLD_SECONDS = 0.45;
// After a command, how long to wait for the mirror to start an answer
// before listening for a follow-up anyway.
const ANSWER_START_MS = 1500;
// How long after a command an answer still earns a follow-up.
const ANSWER_LATEST_MS = 20000;

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.service = null;
		this.ready = false;
		this.restartDelay = 2000;
		this.stopping = false;
		// Set by MMM-Household once it knows the household's wake phrase.
		this.wakePhrases = null;
		this.speaking = false;
		this.followUpUntil = 0;
		this.followUpTimer = null;
	},

	stop () {
		this.stopping = true;
		if (this.service) {
			this.service.kill();
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CONFIG") {
			if (this.config === null) {
				this.config = payload;
				this.writeTones();
				this.setMicrophoneGain();
				this.startService();
			}
			// A page that loaded again needs to know whether the mirror listens.
			this.sendSocketNotification("VOICE_EVENT", { type: this.ready ? "ready" : "off" });
		} else if (notification === "MUTE") {
			this.speaking = Boolean(payload);
			this.send({ cmd: "mute", on: this.speaking });
			if (this.speaking) {
				// The answer has started. The follow-up waits for its end.
				clearTimeout(this.followUpTimer);
			} else if (Date.now() < this.followUpUntil) {
				this.followUpUntil = 0;
				this.followUp();
			}
		} else if (notification === "WAKE_PHRASES" && Array.isArray(payload) && payload.length > 0) {
			const phrases = payload.map(String);
			if (JSON.stringify(phrases) !== JSON.stringify(this.wakePhrases)) {
				this.wakePhrases = phrases;
				// The recognizer takes a new command list while it runs.
				if (this.config) {
					this.sendCommands();
				}
			}
		}
	},

	writeTones () {
		try {
			fs.mkdirSync(SOUNDS, { recursive: true });
			for (const [name, tone] of Object.entries(TONES)) {
				fs.writeFileSync(path.join(SOUNDS, `${name}.wav`), toneWav(tone));
			}
		} catch (error) {
			Log.warn(`Could not write the tones: ${error.message}`);
		}
	},

	/**
	 * Plays one of the tones, unless tones are off. The radio may still hold
	 * the speaker for a moment after it was asked to stop, so a busy speaker
	 * is tried twice more.
	 * @param {string} name heard, listening or missed
	 * @param {number} [tries] attempts left
	 */
	tone (name, tries = 3) {
		if (!this.config.chime) {
			return;
		}
		this.send({ cmd: "hold", seconds: TONE_HOLD_SECONDS });
		execFile("aplay", ["-q", "-D", String(this.config.speaker), path.join(SOUNDS, `${name}.wav`)], (error) => {
			if (error && tries > 1) {
				setTimeout(() => this.tone(name, tries - 1), 300);
			} else if (error) {
				Log.warn(`Could not play the ${name} tone: ${error.message}`);
			}
		});
	},

	/** Sets the capture level on the microphone's sound card, when configured. */
	setMicrophoneGain () {
		const gain = Number(this.config.microphoneGain);
		const card = (/CARD=([A-Za-z0-9_-]+)/).exec(String(this.config.microphone));
		if (!Number.isFinite(gain) || gain <= 0 || !card) {
			return;
		}
		execFile("amixer", ["-q", "-c", card[1], "sset", "Mic", `${Math.min(100, Math.round(gain))}%`], (error) => {
			if (error) {
				Log.warn(`Could not set the microphone level: ${error.message}`);
			}
		});
	},

	startService () {
		const script = path.resolve(fs.realpathSync(this.path), "../../services/voice.py");
		if (!fs.existsSync(PYTHON) || !fs.existsSync(script)) {
			Log.error(`Missing ${PYTHON} or ${script}. Run mirror/deploy/setup-pi.sh. Voice commands are off.`);
			return;
		}
		const args = [script, "--device", String(this.config.microphone), "--min-confidence", String(this.config.minConfidence), "--window-seconds", String(this.config.windowSeconds)];
		const child = spawn(PYTHON, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.service = child;
		this.sendCommands();

		readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
		readline.createInterface({ input: child.stderr }).on("line", (line) => Log.warn(`voice: ${line}`));
		child.on("error", (error) => Log.error(`Could not start the voice service: ${error.message}`));
		child.on("exit", (code) => {
			this.service = null;
			this.ready = false;
			this.sendSocketNotification("VOICE_EVENT", { type: "off" });
			if (this.stopping) {
				return;
			}
			Log.warn(`Voice service exited with code ${code}. Restarting in ${this.restartDelay / 1000} s.`);
			setTimeout(() => this.startService(), this.restartDelay);
			this.restartDelay = Math.min(this.restartDelay * 2, 60000);
		});
	},

	/**
	 * Gives the config with the wake phrases in force.
	 * @returns {object} MMM-Voice's config with wakeWords
	 */
	current () {
		return { ...this.config, wakeWords: this.wakePhrases || [this.config.wakeWord] };
	},

	/** Sends the recognizer its phrases, and keeps a summary for the settings page. */
	sendCommands () {
		const config = this.current();
		this.send({ cmd: "commands", wakes: wakesOf(config), commands: buildCommands(config) });
		try {
			fs.mkdirSync(DATA_DIR, { recursive: true });
			fs.writeFileSync(`${COMMANDS_FILE}.tmp`, JSON.stringify(summarize(config)));
			fs.renameSync(`${COMMANDS_FILE}.tmp`, COMMANDS_FILE);
		} catch (error) {
			Log.warn(`Could not write the list of commands: ${error.message}`);
		}
	},

	send (message) {
		if (this.service) {
			this.service.stdin.write(`${JSON.stringify(message)}\n`);
		}
	},

	/** Listens a few seconds more without the wake word, after an answer. */
	followUp () {
		clearTimeout(this.followUpTimer);
		const seconds = Number(this.config.followUpSeconds);
		if (seconds > 0 && !this.speaking) {
			this.send({ cmd: "follow_up", seconds });
		}
	},

	/**
	 * After a command, waits for the mirror's answer before listening for a
	 * follow-up. A command that has no spoken answer gets its follow-up after
	 * a moment. A slow answer (the lights confirm what they did) gets one more
	 * when it ends.
	 * @param {string} id the command's id
	 */
	planFollowUp (id) {
		if (!(Number(this.config.followUpSeconds) > 0) || (this.config.noFollowUp || []).includes(id)) {
			this.followUpUntil = 0;
			clearTimeout(this.followUpTimer);
			return;
		}
		this.followUpUntil = Date.now() + ANSWER_LATEST_MS;
		clearTimeout(this.followUpTimer);
		this.followUpTimer = setTimeout(() => this.followUp(), ANSWER_START_MS);
	},

	handleLine (line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			Log.warn(`voice: ${line}`);
			return;
		}
		if (message.type === "ready") {
			this.restartDelay = 2000;
			this.ready = true;
			Log.log(`Listening for ${message.phrases} phrases that start with ${(this.wakePhrases || [this.config.wakeWord]).map((phrase) => `"${phrase}"`).join(" or ")}`);
			this.sendSocketNotification("VOICE_EVENT", { type: "ready" });
		} else if (message.type === "command") {
			Log.log(`Heard: ${message.text} (${message.confidence})${message.window ? ` after a pause (${message.window})` : ""}`);
			this.tone("heard");
			this.planFollowUp(message.id);
			this.sendSocketNotification("VOICE_EVENT", message);
			this.sendSocketNotification("VOICE_COMMAND", { id: message.id, text: message.text, confidence: message.confidence });
		} else if (message.type === "missed") {
			Log.log(`Missed: ${message.text || "(no known words)"} (${message.confidence}, ${message.why}${message.window ? `, in the ${message.window} window` : ""})`);
			if (message.window === "wake" && this.config.missTone) {
				this.tone("missed");
			}
			this.sendSocketNotification("VOICE_EVENT", message);
		} else if (message.type === "window") {
			if (message.open) {
				Log.log(`Listening ${message.seconds} s for a command (${message.reason})`);
				if (message.reason === "wake") {
					this.tone("listening");
				}
			} else if (message.reason === "timeout") {
				Log.log("Heard no command in time");
			}
			this.sendSocketNotification("VOICE_EVENT", message);
		} else if (message.type === "listening" || message.type === "level") {
			this.sendSocketNotification("VOICE_EVENT", message);
		} else if (message.type === "error") {
			Log.error(`voice: ${message.message}`);
		}
	}
});
