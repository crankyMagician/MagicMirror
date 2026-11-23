/* MMM-Voice
 *
 * Listens for spoken commands that start with a wake word and broadcasts
 * them to other modules as VOICE_COMMAND. Recognition runs on the Pi with
 * Vosk (see mirror/services/voice.py). No audio leaves the Pi.
 *
 *   VOICE_COMMAND { id: "good_night", text: "mirror good night", confidence: 0.97 }
 *
 * The id is a key from `commands`, or "show:FEATURE" / "hide:FEATURE" for the
 * names in `features`. MMM-Household acts on wake_up, good_night and the
 * show and hide commands. Other modules can act on the rest.
 *
 * The recognizer only knows the words in its model. A phrase with a word it
 * does not know is reported in the log and never matches.
 */
Module.register("MMM-Voice", {
	defaults: {
		wakeWord: "mirror",
		// ALSA capture device of the microphone.
		microphone: "plughw:CARD=Webcam",
		// Capture level to set on that sound card at start, in percent. A webcam
		// microphone across a room needs it high. Leave null to keep the level.
		microphoneGain: 90,
		// Commands recognized with less confidence than this are ignored.
		minConfidence: 0.8,
		// Play a short tone when a command is recognized.
		chime: true,
		// ALSA playback device for the tone.
		speaker: "plughw:CARD=Device",
		// Command id -> the phrases that trigger it, without the wake word.
		commands: {
			wake_up: ["wake up"],
			good_night: ["good night"],
			good_morning: ["good morning"],
			weather: ["what is the weather", "how is the weather"]
		},
		// Spoken name -> feature key, for "show NAME" and "hide NAME".
		features: {
			calendar: "calendar",
			weather: "weather",
			forecast: "forecast",
			news: "newsfeed"
		}
	},

	start () {
		this.sendSocketNotification("CONFIG", this.config);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "VOICE_COMMAND") {
			this.sendNotification("VOICE_COMMAND", payload);
		}
	},

	notificationReceived (notification) {
		// Stop listening while a speech module talks, so the mirror does not hear itself.
		if (notification === "TTS_SAY_STARTING") {
			this.sendSocketNotification("MUTE", true);
		} else if (notification === "TTS_SAY_ENDING" || notification === "TTS_SAY_ERROR") {
			this.sendSocketNotification("MUTE", false);
		}
	}
});
