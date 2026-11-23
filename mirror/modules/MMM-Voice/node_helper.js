const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { buildCommands, chimeWav } = require("./commands");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const PYTHON = path.join(DATA_DIR, "venv", "bin", "python");
const CHIME = path.join(DATA_DIR, "sounds", "heard.wav");

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.service = null;
		this.restartDelay = 2000;
		this.stopping = false;
		// Set by MMM-Household once it knows the household's wake phrase.
		this.wakePhrases = null;
	},

	stop () {
		this.stopping = true;
		if (this.service) {
			this.service.kill();
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CONFIG" && this.config === null) {
			this.config = payload;
			if (this.config.chime) {
				fs.mkdirSync(path.dirname(CHIME), { recursive: true });
				fs.writeFileSync(CHIME, chimeWav());
			}
			this.setMicrophoneGain();
			this.startService();
		} else if (notification === "MUTE") {
			this.send({ cmd: "mute", on: Boolean(payload) });
		} else if (notification === "WAKE_PHRASES" && Array.isArray(payload) && payload.length > 0) {
			const phrases = payload.map(String);
			if (JSON.stringify(phrases) !== JSON.stringify(this.wakePhrases)) {
				this.wakePhrases = phrases;
				// The recognizer takes a new command list while it runs.
				if (this.config) {
					this.send({ cmd: "commands", commands: this.commands() });
				}
			}
		}
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
		const args = [script, "--device", String(this.config.microphone), "--min-confidence", String(this.config.minConfidence)];
		const child = spawn(PYTHON, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.service = child;
		this.send({ cmd: "commands", commands: this.commands() });

		readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
		readline.createInterface({ input: child.stderr }).on("line", (line) => Log.warn(`voice: ${line}`));
		child.on("error", (error) => Log.error(`Could not start the voice service: ${error.message}`));
		child.on("exit", (code) => {
			this.service = null;
			if (this.stopping) {
				return;
			}
			Log.warn(`Voice service exited with code ${code}. Restarting in ${this.restartDelay / 1000} s.`);
			setTimeout(() => this.startService(), this.restartDelay);
			this.restartDelay = Math.min(this.restartDelay * 2, 60000);
		});
	},

	/**
	 * Builds the command list for the wake phrases in force.
	 * @returns {object[]} commands as { id, phrases }
	 */
	commands () {
		return buildCommands({ ...this.config, wakeWords: this.wakePhrases || [this.config.wakeWord] });
	},

	send (message) {
		if (this.service) {
			this.service.stdin.write(`${JSON.stringify(message)}\n`);
		}
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
			Log.log(`Listening for ${message.phrases} phrases that start with ${(this.wakePhrases || [this.config.wakeWord]).map((phrase) => `"${phrase}"`).join(" or ")}`);
		} else if (message.type === "command") {
			Log.log(`Heard: ${message.text} (${message.confidence})`);
			if (this.config.chime) {
				execFile("aplay", ["-q", "-D", String(this.config.speaker), CHIME], (error) => {
					if (error) {
						Log.warn(`Could not play the tone: ${error.message}`);
					}
				});
			}
			this.sendSocketNotification("VOICE_COMMAND", { id: message.id, text: message.text, confidence: message.confidence });
		} else if (message.type === "error") {
			Log.error(`voice: ${message.message}`);
		}
	}
});
