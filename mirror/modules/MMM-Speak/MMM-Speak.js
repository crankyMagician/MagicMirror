/* MMM-Speak
 *
 * Says text aloud through ElevenLabs or Cartesia and the mirror's speaker. Other modules
 * ask for speech with a notification:
 *
 *   this.sendNotification("TTS_SAY", "Good morning.");
 *   this.sendNotification("TTS_SAY", { text: "Good morning.", id: "greeting" });
 *
 * While it speaks it broadcasts TTS_SAY_STARTING and then TTS_SAY_ENDING, or
 * TTS_SAY_ERROR when it could not. MMM-Voice stops listening in between.
 * TTS_STOP cuts the current speech off and clears what is waiting.
 *
 * The API key comes from config.env (SECRET_ELEVENLABS_API_KEY or
 * SECRET_CARTESIA_API_KEY, by provider) and stays in the node helper. Every phrase is cached on the Pi, so only new text
 * costs characters, and dailyCharacterLimit caps the new text per day.
 */
Module.register("MMM-Speak", {
	defaults: {
		// "elevenlabs" or "cartesia".
		provider: "elevenlabs",
		// The id of the voice to speak with, in that provider's account.
		voiceId: "",
		// Voices people can choose on the settings page, each as
		// { id, name, about, provider, voiceId }. The provider and voiceId
		// above are the voice used when nobody has chosen one.
		voices: [],
		// The provider's model. Empty picks a fast default for the provider.
		model: "",
		// Raw PCM that aplay can play directly.
		format: "pcm_22050",
		// ALSA playback device.
		speaker: "plughw:CARD=Device",
		// The longest single utterance. Longer text is cut at a sentence end.
		maxCharacters: 400,
		// The most characters of new, uncached text to send per day.
		dailyCharacterLimit: 1500,
		// The most phrases kept on disk. The least recently used go first.
		maxCachedPhrases: 400,
		// Hours as "HH:MM" between which the mirror does not speak at all.
		silentFrom: null,
		silentTo: null
	},

	start () {
		// How to speak to whoever the mirror sees: their voice, their volume,
		// and whether they want to be spoken to at all. MMM-Household sends it.
		this.speech = { voice: "", volume: 100, speak: true };
		this.sendSocketNotification("CONFIG", this.config);
	},

	/**
	 * Tells whether the mirror is in its silent hours.
	 * @param {Date} now the current time
	 * @returns {boolean} true when it should not speak
	 */
	isSilent (now) {
		const { silentFrom, silentTo } = this.config;
		if (!silentFrom || !silentTo) {
			return false;
		}
		const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
		const from = minutes(silentFrom);
		const to = minutes(silentTo);
		const current = now.getHours() * 60 + now.getMinutes();
		if (from === to) {
			return false;
		}
		return from < to ? current >= from && current < to : current >= from || current < to;
	},

	notificationReceived (notification, payload) {
		if (notification === "HOUSEHOLD_PRESENCE" && payload && payload.speech) {
			this.speech = { voice: "", volume: 100, speak: true, ...payload.speech };
		} else if (notification === "TTS_SAY") {
			const text = typeof payload === "string" ? payload : payload && (payload.text || payload.content);
			const id = payload && typeof payload === "object" ? payload.id : undefined;
			if (!text) {
				return;
			}
			if (this.isSilent(new Date())) {
				this.sendNotification("TTS_SAY_ERROR", { id, text, error: "silent hours" });
				return;
			}
			if (this.speech.speak === false) {
				this.sendNotification("TTS_SAY_ERROR", { id, text, error: "this person has speech switched off" });
				return;
			}
			// The voice is fixed now, as the line is queued.
			this.sendSocketNotification("SAY", { id, text, voice: this.speech.voice, volume: this.speech.volume });
		} else if (notification === "TTS_STOP") {
			this.sendSocketNotification("STOP");
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "STARTED") {
			this.sendNotification("TTS_SAY_STARTING", payload);
		} else if (notification === "ENDED") {
			this.sendNotification("TTS_SAY_ENDING", payload);
		} else if (notification === "FAILED") {
			this.sendNotification("TTS_SAY_ERROR", payload);
		}
	}
});
