/* Turns text into audio through a speech provider, with a cache on disk.
 *
 * MMM-Speak uses this for what the mirror says, and the settings page uses it
 * for voice previews, so both share one cache and one daily limit.
 */
const fs = require("node:fs");
const path = require("node:path");
const { cacheName, providerFor, spend } = require("./speech");

const today = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/**
 * Builds a synthesizer over one cache folder.
 * @param {object} options where the cache is and how to report
 * @param {string} options.cacheDir the folder for audio files and the day's count
 * @param {object} options.log a logger with log
 * @param {function(string, object): Promise<object>} [options.fetch] stands in for fetch in tests
 * @param {object} [options.env] stands in for the environment in tests
 * @returns {object} `audioFor(voice, text, limits)`
 */
const createSynth = ({ cacheDir, log, fetch: post = fetch, env = process.env }) => {
	const usageFile = path.join(cacheDir, "usage.json");

	const readUsage = () => {
		try {
			return JSON.parse(fs.readFileSync(usageFile, "utf8"));
		} catch {
			return null;
		}
	};

	/**
	 * Deletes the least recently used audio once the cache holds too many files.
	 * @param {number} keep the most files to keep
	 */
	const prune = (keep) => {
		const files = fs.readdirSync(cacheDir).filter((name) => name.endsWith(".pcm"))
			.map((name) => ({ name, used: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
			.sort((a, b) => b.used - a.used);
		for (const old of files.slice(keep)) {
			fs.rmSync(path.join(cacheDir, old.name), { force: true });
		}
	};

	/**
	 * Returns the cached audio file for a text in a voice, fetching it first when needed.
	 * @param {object} voice the provider, voice id, model and format, as voiceFor returns them
	 * @param {string} text the prepared text
	 * @param {object} limits the caps to respect
	 * @param {number} limits.dailyCharacterLimit the most new characters per day
	 * @param {number} limits.maxCachedPhrases the most phrases kept on disk
	 * @returns {Promise<{file: string, cached: boolean}>} the raw PCM file and whether it was already on disk
	 */
	const audioFor = async (voice, text, { dailyCharacterLimit, maxCachedPhrases }) => {
		const provider = providerFor(voice.provider);
		fs.mkdirSync(cacheDir, { recursive: true });
		const file = path.join(cacheDir, cacheName(voice, text));
		if (fs.existsSync(file) && fs.statSync(file).size > 0) {
			// Touch it, so the files used least recently are the ones pruned.
			fs.utimesSync(file, new Date(), new Date());
			return { file, cached: true };
		}
		const key = env[provider.keyName];
		if (!key) {
			throw new Error(`${provider.keyName} is not set in config.env`);
		}
		if (!voice.voiceId) {
			throw new Error("no voice is configured");
		}
		const budget = spend(readUsage(), text.length, dailyCharacterLimit, today());
		if (!budget.allowed) {
			throw new Error(`today's limit of ${dailyCharacterLimit} new characters is used up`);
		}
		const request = provider.request(voice, text, key);
		const response = await post(request.url, {
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
		fs.writeFileSync(usageFile, JSON.stringify(budget.usage));
		fs.writeFileSync(`${file}.tmp`, audio);
		fs.renameSync(`${file}.tmp`, file);
		log.log(`Fetched speech for ${text.length} characters (${budget.usage.characters} of ${dailyCharacterLimit} today)`);
		prune(maxCachedPhrases);
		return { file, cached: false };
	};

	return { audioFor };
};

module.exports = { createSynth };
