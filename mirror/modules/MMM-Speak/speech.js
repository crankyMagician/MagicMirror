/* Pure helpers for MMM-Speak: preparing text, naming cache files and keeping
 * a daily count of the characters sent to the speech service. */
const crypto = require("node:crypto");

/**
 * Cleans up text before it is spoken: one line, single spaces, bounded length.
 * @param {string} text what a module asked to have said
 * @param {number} maxCharacters the longest text allowed
 * @returns {string} the text to speak, or "" when there is nothing to say
 */
const prepare = (text, maxCharacters) => {
	// Control characters are exactly what this removes.
	// eslint-disable-next-line no-control-regex
	const clean = String(text || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	if (clean.length <= maxCharacters) {
		return clean;
	}
	// Cut at the last sentence end that fits, else at the last word. A whole
	// sentence is better to hear than a longer text that stops mid-thought.
	const cut = clean.slice(0, maxCharacters);
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
	if (sentence >= 10) {
		return cut.slice(0, sentence + 1);
	}
	return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim();
};

/**
 * Names the cache file for one utterance. The same words in the same voice
 * always give the same name, so a repeated phrase is fetched once.
 * @param {object} voice the voice id, model and audio format in use
 * @param {string} voice.provider the speech provider's name
 * @param {string} voice.voiceId the voice in that provider's account
 * @param {string} voice.model the provider's model
 * @param {string} voice.format the audio format
 * @param {string} text the prepared text
 * @returns {string} a file name
 */
const cacheName = ({ provider, voiceId, model, format }, text) => {
	const hash = crypto.createHash("sha256").update([provider, voiceId, model, format, text].join("\n")).digest("hex");
	return `${hash.slice(0, 32)}.pcm`;
};

/**
 * Adds characters to today's count and says whether they fit the daily limit.
 * @param {object} usage the stored count as { day, characters }
 * @param {number} characters the length of the text about to be fetched
 * @param {number} limit the most characters allowed per day
 * @param {string} today today's date as YYYY-MM-DD
 * @returns {{allowed: boolean, usage: object}} the verdict and the count to store
 */
const spend = (usage, characters, limit, today) => {
	const current = usage && usage.day === today ? usage.characters : 0;
	if (current + characters > limit) {
		return { allowed: false, usage: { day: today, characters: current } };
	}
	return { allowed: true, usage: { day: today, characters: current + characters } };
};

/**
 * Reads the sample rate out of a format name such as "pcm_22050".
 * @param {string} format an ElevenLabs PCM output format
 * @returns {number} samples per second
 */
const sampleRate = (format) => {
	const match = (/^pcm_(\d+)$/).exec(format);
	if (!match) {
		throw new Error(`MMM-Speak plays raw PCM only, and "${format}" is not a pcm_ format`);
	}
	return Number(match[1]);
};

/* The speech services MMM-Speak can use. Each entry names the environment
 * variable that holds its key, its default model, and how to ask it for raw
 * 16-bit mono PCM at the configured sample rate. */
const PROVIDERS = {
	elevenlabs: {
		keyName: "SECRET_ELEVENLABS_API_KEY",
		defaultModel: "eleven_flash_v2_5",
		request: ({ voiceId, model, format }, text, key) => ({
			url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`,
			headers: { "xi-api-key": key, "Content-Type": "application/json" },
			body: { text, model_id: model, apply_text_normalization: "on" }
		})
	},
	cartesia: {
		keyName: "SECRET_CARTESIA_API_KEY",
		defaultModel: "sonic-3.5",
		request: ({ voiceId, model, format }, text, key) => ({
			url: "https://api.cartesia.ai/tts/bytes",
			headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": "2026-03-01", "Content-Type": "application/json" },
			body: {
				model_id: model,
				transcript: text,
				voice: { mode: "id", id: voiceId },
				language: "en",
				output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: sampleRate(format) }
			}
		})
	}
};

/**
 * Looks a provider up by name.
 * @param {string} name "elevenlabs" or "cartesia"
 * @returns {object} the provider entry
 */
const providerFor = (name) => {
	const provider = PROVIDERS[name];
	if (!provider) {
		throw new Error(`unknown speech provider "${name}". Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
	}
	return provider;
};

/**
 * Tells whether a player failed because something else holds the speaker,
 * such as the short tone that confirms a voice command.
 * @param {Error} error the player's failure
 * @returns {boolean} true when trying again a moment later can work
 */
const speakerBusy = (error) => (/device or resource busy/i).test(String(error && error.message));

/**
 * Runs an action again while it fails for a reason worth waiting out.
 * @param {function(): Promise} action what to run
 * @param {object} options how to retry
 * @param {number} options.attempts the most times to run the action
 * @param {number} options.waitMs the pause between attempts
 * @param {function(Error): boolean} options.when tells whether a failure is worth another attempt
 * @param {function(number): Promise} [options.sleep] stands in for the pause in tests
 * @returns {Promise} the action's result
 */
const retrying = async (action, { attempts, waitMs, when, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) => {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await action();
		} catch (error) {
			if (attempt >= attempts || !when(error)) {
				throw error;
			}
			await sleep(waitMs);
		}
	}
};

// What MMM-Speak falls back to. MMM-Speak.js repeats these as its defaults,
// because a browser module cannot load this file.
const DEFAULTS = { provider: "elevenlabs", voiceId: "", model: "", format: "pcm_22050", dailyCharacterLimit: 1500, maxCachedPhrases: 400 };

/**
 * Picks the voice to speak with. An id names an entry of the `voices` list in
 * MMM-Speak's config. An empty or unknown id gives the configured default.
 * @param {object} config MMM-Speak's config
 * @param {string} [id] a voice id from the list
 * @returns {object} the provider, voice id, model and format to use
 */
const voiceFor = (config, id) => {
	const listed = (Array.isArray(config.voices) ? config.voices : []).find((voice) => voice && voice.id === id);
	const chosen = listed || { provider: config.provider, voiceId: config.voiceId, model: config.model };
	return {
		provider: chosen.provider,
		voiceId: chosen.voiceId,
		model: chosen.model || providerFor(chosen.provider).defaultModel,
		format: config.format
	};
};

/**
 * Makes 16-bit audio quieter.
 * @param {Buffer} pcm signed 16-bit little-endian samples
 * @param {number} percent the volume, from 0 to 100
 * @returns {Buffer} the samples at that volume
 */
const scalePcm = (pcm, percent) => {
	const factor = Math.min(100, Math.max(0, Number(percent))) / 100;
	if (!Number.isFinite(factor) || factor === 1) {
		return pcm;
	}
	const out = Buffer.alloc(pcm.length - (pcm.length % 2));
	for (let offset = 0; offset < out.length; offset += 2) {
		out.writeInt16LE(Math.round(pcm.readInt16LE(offset) * factor), offset);
	}
	return out;
};

/**
 * Wraps raw mono 16-bit audio as a WAV file, which a browser can play.
 * @param {Buffer} pcm signed 16-bit little-endian samples
 * @param {number} rate samples per second
 * @returns {Buffer} the WAV file
 */
const wavFrom = (pcm, rate) => {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
};

module.exports = { DEFAULTS, cacheName, prepare, providerFor, retrying, sampleRate, scalePcm, speakerBusy, spend, voiceFor, wavFrom };
