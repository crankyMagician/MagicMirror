/* global HouseholdBriefing */
/* MMM-Ask
 *
 * Answers what people ask the mirror in their own words: "mirror, how tall
 * is Mount Everest", "mirror, do I need a jacket tonight". MMM-Voice writes
 * the sentence down, MMM-Lights offers it to Home Assistant first, and a
 * sentence nobody could act on arrives here as VOICE_UNHANDLED. The node
 * helper asks Claude Haiku 5.5, which may search the web, and the answer is
 * spoken in the voice of the person at the mirror and shown in the top band
 * with the sites it came from.
 *
 * The question goes with a short note: the first name of the person in
 * view, the time, the weather and that person's coming calendar entries. It
 * reads the calendars the way MMM-Briefing does, from the person names in
 * each calendar module's classes.
 *
 *   {
 *     module: "MMM-Ask",
 *     position: "top_bar",
 *     config: { people: { sam: { name: "Sam" } } }
 *   }
 *
 * The key is SECRET_ANTHROPIC_KEY in config.env and stays in the helper.
 * Turn off MMM-Voice's own reply (`sayUnhandled: false`) so a question is
 * not answered twice.
 */
Module.register("MMM-Ask", {
	defaults: {
		// Person key -> { name }, the same as MMM-Briefing's.
		people: {},
		// How long the answer stays on the screen.
		showSeconds: 30,
		// Web searches one question may run.
		searches: 2,
		// At most this many questions a day.
		questionsPerDay: 200,
		// A follow-up without the wake word counts only this long after an answer.
		followUpSeconds: 120
	},

	getStyles () {
		return [this.file("MMM-Ask.css")];
	},

	start () {
		this.person = null;
		this.assistant = "";
		this.current = null;
		this.forecast = [];
		this.events = {};
		this.shown = null;
		this.hideTimer = null;
		this.answeredAt = 0;
		this.sendSocketNotification("CONFIG", { searches: this.config.searches, questionsPerDay: this.config.questionsPerDay });
	},

	// The people a module belongs to, from the person names in its classes.
	ownersOf (sender) {
		const classes = ((sender && sender.data && sender.data.classes) || "").split(/\s+/);
		return classes.filter((name) => Object.hasOwn(this.config.people, name));
	},

	notificationReceived (notification, payload, sender) {
		if (notification === "HOUSEHOLD_PRESENCE") {
			const person = (payload && payload.person) || null;
			if (person !== this.person) {
				// A new person starts a new conversation.
				this.sendSocketNotification("FORGET");
			}
			this.person = person;
		} else if (notification === "HOUSEHOLD_MIRROR" && payload && payload.name) {
			this.assistant = String(payload.name);
		} else if (notification === "WEATHER_UPDATED" && payload) {
			if (payload.currentWeather) {
				this.current = payload.currentWeather;
			}
			if (Array.isArray(payload.forecastArray) && payload.forecastArray.length > 0) {
				this.forecast = payload.forecastArray;
			}
		} else if (notification === "CALENDAR_EVENTS" && sender && Array.isArray(payload)) {
			this.events[sender.identifier] = { owners: this.ownersOf(sender), items: payload };
		} else if (notification === "VOICE_UNHANDLED" && payload && payload.text) {
			this.question(payload);
		}
	},

	/**
	 * Takes a sentence nobody else could act on. After an answer, talk around
	 * the mirror is only a question while the conversation is fresh.
	 * @param {object} payload what MMM-Voice heard
	 * @param {string} payload.text the sentence, without the wake word
	 * @param {string|null} payload.window the listening window it was said in
	 */
	question ({ text, window }) {
		if (window === "follow_up" && Date.now() - this.answeredAt > this.config.followUpSeconds * 1000) {
			return;
		}
		this.sendSocketNotification("ASK", { id: `ask-${Date.now()}`, question: text, person: this.person, context: this.context(new Date()) });
	},

	/**
	 * The note that goes with a question.
	 * @param {Date} now the current time
	 * @returns {object} see contextNote in ask.js
	 */
	context (now) {
		const helpers = typeof HouseholdBriefing === "undefined" ? null : HouseholdBriefing;
		const person = this.person && this.config.people[this.person] ? this.config.people[this.person].name : "";
		const time = now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
		const weather = helpers && (this.current || this.forecast[0]) ? helpers.weatherLine(this.current, this.forecast[0] || null) : "";
		let events = [];
		if (helpers && this.person) {
			const mine = Object.values(this.events).filter((entry) => entry.owners.includes(this.person)).flatMap((entry) => entry.items);
			const week = now.getTime() + 7 * 24 * 3600 * 1000;
			events = helpers.upcoming(mine, now).filter((event) => event.startDate < week).slice(0, 6).map((event) => `${event.title}, ${helpers.whenWords(event, now)}`);
		}
		return { person, assistant: this.assistant, time, weather, events };
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "ANSWER" && payload && payload.text) {
			if (!payload.failed) {
				this.answeredAt = Date.now();
			}
			// In the voice of whoever is at the mirror. MMM-Speak picks it.
			this.sendNotification("TTS_SAY", { id: payload.id, text: payload.text });
			this.shown = { question: payload.question, text: payload.text, sources: payload.sources || [] };
			this.updateDom(300);
			clearTimeout(this.hideTimer);
			this.hideTimer = setTimeout(() => {
				this.shown = null;
				this.updateDom(600);
			}, this.config.showSeconds * 1000);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "ask-card";
		if (!this.shown) {
			return wrapper;
		}
		const question = document.createElement("div");
		question.className = "ask-question small dimmed";
		question.textContent = this.shown.question;
		const answer = document.createElement("div");
		answer.className = "ask-answer medium";
		answer.textContent = this.shown.text;
		wrapper.append(question, answer);
		if (this.shown.sources.length > 0) {
			const sources = document.createElement("div");
			sources.className = "ask-sources xsmall dimmed";
			sources.textContent = `From ${this.shown.sources.join(" and ")}`;
			wrapper.appendChild(sources);
		}
		return wrapper;
	}
});
