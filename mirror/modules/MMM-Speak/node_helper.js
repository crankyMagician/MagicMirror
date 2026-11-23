const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { cacheName, prepare, providerFor, retrying, sampleRate, speakerBusy, spend } = require("./speech");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const CACHE_DIR = path.join(DATA_DIR, "speech");
const USAGE_FILE = path.join(CACHE_DIR, "usage.json");

const today = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

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
		const { id, text: raw } = this.queue.shift();
		const text = prepare(raw, this.config.maxCharacters);
		try {
			if (!text) {
				throw new Error("there was nothing to say");
			}
			const { file, cached } = await this.audioFor(text);
			this.sendSocketNotification("STARTED", { id, text });
			await this.play(file);
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
	 * Returns the cached audio file for a text, fetching it first when needed.
	 * @param {string} text the prepared text
	 * @returns {Promise<{file: string, cached: boolean}>} the raw PCM file and whether it was already on disk
	 */
	async audioFor (text) {
		const provider = providerFor(this.config.provider);
		const voice = { provider: this.config.provider, voiceId: this.config.voiceId, model: this.config.model || provider.defaultModel, format: this.config.format };
		const file = path.join(CACHE_DIR, cacheName(voice, text));
		if (fs.existsSync(file) && fs.statSync(file).size > 0) {
			// Touch it, so the files used least recently are the ones pruned.
			fs.utimesSync(file, new Date(), new Date());
			return { file, cached: true };
		}
		const key = process.env[provider.keyName];
		if (!key) {
			throw new Error(`${provider.keyName} is not set in config.env`);
		}
		if (!voice.voiceId) {
			throw new Error("no voice is configured");
		}
		const budget = spend(this.readUsage(), text.length, this.config.dailyCharacterLimit, today());
		if (!budget.allowed) {
			throw new Error(`today's limit of ${this.config.dailyCharacterLimit} new characters is used up`);
		}
		const request = provider.request(voice, text, key);
		const response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: AbortSignal.timeout(30000)
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`the speech service answered ${response.status} ${detail.slice(0, 160)}`);
		}
		const audio = Buffer.from(await response.arrayBuffer());
		if (audio.length === 0) {
			throw new Error("the speech service sent no audio");
		}
		fs.writeFileSync(USAGE_FILE, JSON.stringify(budget.usage));
		fs.writeFileSync(`${file}.tmp`, audio);
		fs.renameSync(`${file}.tmp`, file);
		Log.log(`Fetched speech for ${text.length} characters (${budget.usage.characters} of ${this.config.dailyCharacterLimit} today)`);
		this.prune();
		return { file, cached: false };
	},

	readUsage () {
		try {
			return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
		} catch {
			return null;
		}
	},

	/** Deletes the least recently used audio once the cache holds too many files. */
	prune () {
		const files = fs.readdirSync(CACHE_DIR).filter((name) => name.endsWith(".pcm"))
			.map((name) => ({ name, used: fs.statSync(path.join(CACHE_DIR, name)).mtimeMs }))
			.sort((a, b) => b.used - a.used);
		for (const old of files.slice(this.config.maxCachedPhrases)) {
			fs.rmSync(path.join(CACHE_DIR, old.name), { force: true });
		}
	},

	/**
	 * Plays a file, waiting out the tone that confirms a voice command. The
	 * tone holds the speaker for a moment, and a cached line can be ready
	 * before it ends.
	 * @param {string} file the audio to play
	 * @returns {Promise} resolves when the line has been played
	 */
	play (file) {
		return retrying(() => this.playOnce(file), { attempts: 8, waitMs: 250, when: speakerBusy });
	},

	playOnce (file) {
		return new Promise((resolve, reject) => {
			const rate = sampleRate(this.config.format);
			const args = ["-q", "-D", String(this.config.speaker), "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", String(rate), file];
			this.player = spawn("aplay", args, { stdio: ["ignore", "ignore", "pipe"] });
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
