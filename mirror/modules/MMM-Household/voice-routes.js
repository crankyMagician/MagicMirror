/* Lets the settings page play a short sample of each voice on offer.
 *
 * The voices are the `voices` list of MMM-Speak's config. A sample is made
 * by the same synthesizer MMM-Speak uses, so it lands in the same cache and
 * counts toward the same daily limit, and each voice costs its sample once.
 */
const fs = require("node:fs");
const { sampleRate, voiceFor, wavFrom } = require("../MMM-Speak/speech");

const SAMPLE = "Hello. This is how I sound on your mirror.";

/**
 * Lists the voices on offer without their provider details.
 * @param {object} speakConfig MMM-Speak's config
 * @returns {object[]} voices as { id, name, about }
 */
const voicesOn = (speakConfig) => (Array.isArray(speakConfig.voices) ? speakConfig.voices : [])
	.filter((voice) => voice && typeof voice.id === "string" && (/^[a-z0-9-]{1,48}$/).test(voice.id) && voice.provider && voice.voiceId)
	.map((voice) => ({ id: voice.id, name: String(voice.name || voice.id), about: String(voice.about || "") }));

/**
 * Adds the voice preview route to the settings server.
 * @param {object} app the settings Express app, after its access middleware
 * @param {object} options what to offer and how to make a sample
 * @param {function(): object} options.speakConfig returns MMM-Speak's config, with its defaults filled in
 * @param {object} options.synth a synthesizer with audioFor, from MMM-Speak/synth.js
 * @param {object} options.log a logger with warn
 */
const addVoiceRoutes = (app, { speakConfig, synth, log }) => {
	// "default" is the voice MMM-Speak uses when nobody has chosen one.
	app.get("/api/voices/:id/preview", async (req, res) => {
		const config = speakConfig();
		const id = req.params.id;
		if (id !== "default" && !voicesOn(config).some((voice) => voice.id === id)) {
			res.status(404).json({ error: "The mirror does not offer that voice" });
			return;
		}
		try {
			const { file } = await synth.audioFor(voiceFor(config, id === "default" ? "" : id), SAMPLE, config);
			res.set("Cache-Control", "private, max-age=3600");
			res.type("audio/wav").send(wavFrom(fs.readFileSync(file), sampleRate(config.format)));
		} catch (error) {
			log.warn(`No sample for the voice ${id}: ${error.message}`);
			const spent = (/limit/).test(error.message);
			res.status(spent ? 429 : 502).json({ error: spent ? "The mirror has used up today's speech. Try the sample tomorrow." : "The speech service did not answer" });
		}
	});
};

module.exports = { SAMPLE, addVoiceRoutes, voicesOn };
