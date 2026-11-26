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
 * A command can be said in one breath, or the wake word alone first and the
 * command within `windowSeconds`. After an answer the mirror listens
 * `followUpSeconds` more without the wake word.
 *
 * A strip along the bottom edge of the screen shows what it is doing:
 * a faint microphone while it waits, blue while it listens (moving with the
 * voice), green with the words it understood, amber when it did not catch
 * them, a caption while it speaks, and red when voice commands are off. The
 * strip sits in the page's bottom margin, so it covers nothing.
 *
 * It broadcasts VOICE_LISTENING { on, reason } while it listens, so the
 * radio can pause and the screen can wake ("reason" is "wake" or
 * "follow_up").
 *
 * The recognizer only knows the words in its model. A phrase with a word it
 * does not know is reported in the log and never matches.
 */
Module.register("MMM-Voice", {
	defaults: {
		// The word before every command. MMM-Household's Mirror tab can
		// replace it at run time (HOUSEHOLD_MIRROR).
		wakeWord: "mirror",
		// ALSA capture device of the microphone.
		microphone: "plughw:CARD=Webcam",
		// Capture level to set on that sound card at start, in percent. A webcam
		// microphone across a room needs it high. Leave null to keep the level.
		microphoneGain: 90,
		// Commands recognized with less confidence than this are ignored.
		minConfidence: 0.8,
		// Seconds to wait for the command after the wake word alone.
		windowSeconds: 8,
		// Seconds to listen without the wake word after an answer. 0 turns it off.
		followUpSeconds: 5,
		// Commands that get no follow-up.
		noFollowUp: ["good_night", "cancel"],
		// Play short tones: listening, understood, and (with missTone) not caught.
		chime: true,
		missTone: true,
		// Show what the mirror says as a caption in the strip.
		captions: true,
		// ALSA playback device for the tones.
		speaker: "plughw:CARD=Device",
		// Command id -> the phrases that trigger it, without the wake word.
		commands: {
			wake_up: ["wake up"],
			good_night: ["good night"],
			good_morning: ["good morning"],
			weather: ["what is the weather", "how is the weather"],
			help: ["what can i say", "help"],
			cancel: ["never mind", "cancel"]
		},
		// Spoken name -> feature key, for "show NAME" and "hide NAME".
		features: {
			calendar: "calendar",
			weather: "weather",
			forecast: "forecast",
			news: "newsfeed"
		},
		// Seconds the help card stays up.
		helpSeconds: 20
	},

	getStyles () {
		return ["MMM-Voice.css"];
	},

	start () {
		this.wake = String(this.config.wakeWord).toLowerCase();
		this.listeningOn = false;
		this.offTimer = null;
		this.stateTimer = null;
		this.helpTimer = null;
		this.speakingNow = false;
		this.person = null;
		this.heardToday = "";
		this.caption = "";
		this.sendSocketNotification("CONFIG", this.config);
	},

	/**
	 * Builds the strip once and hangs it on the page outside every region.
	 * @returns {HTMLElement} the strip
	 */
	strip () {
		if (this.stripNode) {
			return this.stripNode;
		}
		const strip = document.createElement("div");
		strip.className = "voice-strip voice-starting";
		strip.setAttribute("aria-live", "polite");
		strip.innerHTML = [
			"<div class=\"voice-glow\"></div>",
			"<div class=\"voice-timer\"></div>",
			"<div class=\"voice-row\">",
			"<svg class=\"voice-mic\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7\" fill=\"none\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
			"<span class=\"voice-text\"></span>",
			"</div>"
		].join("");
		document.body.appendChild(strip);
		this.stripNode = strip;
		return strip;
	},

	/**
	 * Shows one state in the strip.
	 * @param {string} state waiting, hint, listening, understood, missed, speaking or off
	 * @param {string} [text] what the strip says
	 * @param {number} [seconds] go back to waiting after this long
	 */
	show (state, text = "", seconds = 0) {
		const strip = this.strip();
		clearTimeout(this.stateTimer);
		strip.className = `voice-strip voice-${state}`;
		strip.querySelector(".voice-text").textContent = text;
		strip.style.setProperty("--voice-level", "0");
		if (seconds > 0) {
			this.stateTimer = setTimeout(() => this.show("waiting"), seconds * 1000);
		}
	},

	/**
	 * Starts the shrinking bar that shows how long the mirror still listens.
	 * @param {number} seconds how long the bar takes to empty
	 */
	countdown (seconds) {
		const timer = this.strip().querySelector(".voice-timer");
		timer.style.transition = "none";
		timer.style.transform = "scaleX(1)";
		// Read the layout once so the browser starts from a full bar.
		timer.getBoundingClientRect();
		timer.style.transition = `transform ${seconds}s linear`;
		timer.style.transform = "scaleX(0)";
	},

	/**
	 * Tells other modules whether the mirror is listening, once per change.
	 * @param {boolean} on whether it listens now
	 * @param {string} [reason] "wake" or "follow_up"
	 */
	listening (on, reason = "wake") {
		if (on === this.listeningOn) {
			return;
		}
		this.listeningOn = on;
		this.sendNotification("VOICE_LISTENING", { on, reason });
	},

	/**
	 * Turns heard words into what the strip shows: without the wake word,
	 * first letter capitalized.
	 * @param {string} text the recognizer's text
	 * @returns {string} the words to show
	 */
	pretty (text) {
		let words = String(text || "");
		if (words === this.wake) {
			return "";
		}
		if (words.startsWith(`${this.wake} `)) {
			words = words.slice(this.wake.length + 1);
		}
		return words.charAt(0).toUpperCase() + words.slice(1);
	},

	/**
	 * Writes the wake phrase as the screen shows it: "Mirror".
	 * @returns {string} the wake phrase, first letter capitalized
	 */
	wakeName () {
		return this.wake.charAt(0).toUpperCase() + this.wake.slice(1);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "VOICE_COMMAND") {
			this.sendNotification("VOICE_COMMAND", payload);
			if (payload.id === "help") {
				this.help();
			}
		} else if (notification === "VOICE_EVENT" && payload) {
			this.event(payload);
		}
	},

	event (message) {
		const strip = this.strip();
		if (message.type === "ready") {
			clearTimeout(this.offTimer);
			this.offTimer = null;
			if (!this.speakingNow) {
				this.show("waiting");
			}
		} else if (message.type === "off") {
			// A restart takes a few seconds. Say so only when it lasts.
			clearTimeout(this.offTimer);
			this.offTimer = setTimeout(() => this.show("off", "Voice commands are off"), 10000);
			this.listening(false);
		} else if (message.type === "listening") {
			if (message.on) {
				this.show("listening", "Listening");
				this.listening(true, "wake");
			} else if (!strip.classList.contains("voice-window")) {
				this.show("waiting");
				this.listening(false);
			}
		} else if (message.type === "window") {
			if (message.open) {
				this.show("listening", message.reason === "wake" ? "Listening" : "Anything else?");
				strip.classList.add("voice-window");
				this.countdown(message.seconds);
				this.listening(true, message.reason);
			} else {
				if (message.reason === "timeout") {
					this.show("waiting");
				}
				this.listening(false);
			}
		} else if (message.type === "level") {
			strip.style.setProperty("--voice-level", String(Math.max(0, Math.min(1, Number(message.value) || 0))));
		} else if (message.type === "command") {
			this.heardToday = new Date().toDateString();
			this.show("understood", message.id === "cancel" ? "Okay" : this.pretty(message.text), 3);
			this.listening(false);
		} else if (message.type === "missed") {
			this.listening(false);
			// Talk around the mirror after an answer is not meant for it.
			if (message.window === "follow_up") {
				this.show("waiting");
				return;
			}
			const words = this.pretty(message.text);
			let detail = "";
			if (message.why === "low" && words) {
				detail = ` Did you say "${words}"?`;
			} else if (words) {
				detail = ` I heard "${words}".`;
			}
			this.show("missed", `Sorry, I did not catch that.${detail}`, 4);
		}
	},

	/** Answers "mirror, what can I say" aloud and with a card of examples. */
	help () {
		const examples = this.examples();
		const said = examples.slice(0, 3).map((example) => example.toLowerCase());
		const such = said.length > 1 ? `${said.slice(0, -1).join(", ")} or ${said[said.length - 1]}` : said[0];
		const text = `Say ${this.wake}, then a command, such as ${such}. You can also say ${this.wake}, wait for the blue light, and then say the command.`;
		// A module does not receive its own notifications, so the caption is set here.
		this.caption = text;
		this.sendNotification("TTS_SAY", { id: `voice-help-${Date.now()}`, text });
		let card = document.querySelector(".voice-help-card");
		if (!card) {
			card = document.createElement("div");
			card.className = "voice-help-card";
			document.body.appendChild(card);
		}
		card.replaceChildren();
		const title = document.createElement("div");
		title.className = "voice-help-title";
		title.textContent = `Say "${this.wakeName()}", then:`;
		card.appendChild(title);
		const list = document.createElement("ul");
		for (const example of examples) {
			const item = document.createElement("li");
			item.textContent = example;
			list.appendChild(item);
		}
		card.appendChild(list);
		document.body.classList.add("voice-help");
		clearTimeout(this.helpTimer);
		this.helpTimer = setTimeout(() => document.body.classList.remove("voice-help"), this.config.helpSeconds * 1000);
	},

	/**
	 * Picks a few commands this mirror knows, to suggest.
	 * @returns {string[]} example commands without the wake word
	 */
	examples () {
		const { lights = {}, scenes = {}, features = {}, commands = {} } = this.config;
		const list = [];
		const light = Object.keys(lights)[0];
		if (light) {
			list.push(`Turn on the ${light}`);
		}
		if (commands.what_is_next) {
			list.push("What is next");
		}
		if (commands.weather) {
			list.push("What is the weather");
		}
		if (features.calendar) {
			list.push("Show only the calendar");
		}
		const scene = Object.keys(scenes)[0];
		if (scene) {
			list.push(scene.charAt(0).toUpperCase() + scene.slice(1));
		}
		if (commands.good_night) {
			list.push("Good night");
		}
		return list.length > 0 ? list : ["Good night"];
	},

	notificationReceived (notification, payload) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.strip();
		} else if (notification === "HOUSEHOLD_MIRROR" && payload) {
			// The household's own wake phrase replaces `wakeWord`. While a new
			// phrase is on trial, the mirror listens for the old and the new.
			if (payload.wakePhrase) {
				this.wake = String(payload.wakePhrase).toLowerCase();
			}
			this.sendSocketNotification("WAKE_PHRASES", [payload.wakePhrase, payload.wakeCandidate].filter(Boolean));
		} else if (notification === "HOUSEHOLD_PRESENCE" && payload) {
			this.arrived(payload.person || null);
		} else if (notification === "TTS_SAY" && payload && this.config.captions) {
			this.caption = String(payload.text || "");
		} else if (notification === "TTS_SAY_STARTING") {
			// Stop listening while a speech module talks, so the mirror does not hear itself.
			this.speakingNow = true;
			this.sendSocketNotification("MUTE", true);
			if (this.config.captions && this.caption) {
				this.show("speaking", this.caption);
			}
		} else if (notification === "TTS_SAY_ENDING" || notification === "TTS_SAY_ERROR") {
			this.speakingNow = false;
			this.caption = "";
			this.sendSocketNotification("MUTE", false);
			if (this.stripNode && this.stripNode.classList.contains("voice-speaking")) {
				this.show("waiting");
			}
		}
	},

	/**
	 * Reminds a person who arrives how to talk to the mirror, until it has heard a command that day.
	 * @param {string|null} person who MMM-Household recognizes now
	 */
	arrived (person) {
		const before = this.person;
		this.person = person;
		if (person && person !== before && this.heardToday !== new Date().toDateString() && this.stripNode && this.stripNode.classList.contains("voice-waiting")) {
			this.show("hint", `Say "${this.wakeName()}", then a command`, 15);
		}
	}
});
