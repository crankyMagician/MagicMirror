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

module.exports = { cacheName, prepare, providerFor, sampleRate, spend };
