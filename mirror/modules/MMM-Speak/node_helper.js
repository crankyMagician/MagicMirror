const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { prepare, retrying, sampleRate, scalePcm, speakerBusy, voiceFor } = require("./speech");
const { createSynth } = require("./synth");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const CACHE_DIR = path.join(DATA_DIR, "speech");

/* Speaks text through ElevenLabs or Cartesia and the Pi's speaker.
 *
 * The provider's API key is read from the environment (config.env on the Pi)
 * and never leaves this helper. Each utterance is cached as raw PCM, so a phrase said
 * before plays from disk without calling the service. */
module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.queue = [];
		this.busy = false;
		this.player = null;
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		this.synth = createSynth({ cacheDir: CACHE_DIR, log: Log });
	},

	stop () {
		this.queue = [];
		if (this.player) {
			this.player.kill();
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CONFIG") {
			this.config = payload;
		} else if (notification === "SAY" && this.config) {
			this.queue.push(payload);
			this.next();
		} else if (notification === "STOP") {
			this.queue = [];
			if (this.player) {
				this.player.kill();
			}
		}
	},

	async next () {
		if (this.busy || this.queue.length === 0) {
			return;
		}
		this.busy = true;
		// The voice and the volume were chosen when the line was queued, so a
		// change of person in the meantime does not change how it sounds.
		const { id, text: raw, voice: voiceId, volume = 100 } = this.queue.shift();
		const text = prepare(raw, this.config.maxCharacters);
		try {
			if (!text) {
				throw new Error("there was nothing to say");
			}
			const { file, cached } = await this.synth.audioFor(voiceFor(this.config, voiceId), text, this.config);
			this.sendSocketNotification("STARTED", { id, text });
			await this.play(file, volume);
			this.sendSocketNotification("ENDED", { id, text });
			// The words themselves stay out of the log. They can be private.
			Log.log(`Said ${text.length} characters${cached ? " from the cache" : ""}`);
		} catch (error) {
			Log.warn(`Could not speak ${text.length} characters: ${error.message}`);
			this.sendSocketNotification("FAILED", { id, text, error: error.message });
		}
		this.busy = false;
		this.next();
	},

	/**
	 * Plays a file, waiting out the tone that confirms a voice command. The
	 * tone holds the speaker for a moment, and a cached line can be ready
	 * before it ends.
	 * @param {string} file the audio to play
	 * @param {number} [volume] the volume from 0 to 100
	 * @returns {Promise} resolves when the line has been played
	 */
	play (file, volume = 100) {
		return retrying(() => this.playOnce(file, volume), { attempts: 8, waitMs: 250, when: speakerBusy });
	},

	playOnce (file, volume) {
		return new Promise((resolve, reject) => {
			const rate = sampleRate(this.config.format);
			const args = ["-q", "-D", String(this.config.speaker), "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", String(rate)];
			// At full volume aplay reads the file. Below it, the quieter
			// samples are handed over on its standard input.
			const quieter = Number(volume) < 100 ? scalePcm(fs.readFileSync(file), volume) : null;
			this.player = spawn("aplay", quieter ? args : [...args, file], { stdio: [quieter ? "pipe" : "ignore", "ignore", "pipe"] });
			if (quieter) {
				this.player.stdin.on("error", () => {});
				this.player.stdin.end(quieter);
			}
			let problem = "";
			this.player.stderr.on("data", (chunk) => { problem += chunk; });
			this.player.on("error", (error) => {
				this.player = null;
				reject(error);
			});
			this.player.on("exit", (code, signal) => {
				this.player = null;
				// A STOP kills the player. That is not a failure.
				if (code === 0 || signal) {
					resolve();
				} else {
					reject(new Error(`aplay exited with ${code}: ${problem.trim().slice(0, 120)}`));
				}
			});
		});
	}
});
