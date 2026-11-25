/* global HouseholdBriefing */

/* MMM-Briefing
 *
 * Gives the mirror things to say. It answers three voice commands and says
 * a special message on special days:
 *
 *   "mirror, what is the weather"   the weather now and today's range
 *   "mirror, good morning"          weather, today's events, open tasks
 *   "mirror, what is next"          the next event on the person's calendar
 *
 * It gathers what it says from what other modules already broadcast
 * (WEATHER_UPDATED, CALENDAR_EVENTS, HOUSEHOLD_TASKS) and only uses the
 * calendars and task lists of the person MMM-Household recognizes. It sends
 * TTS_SAY for a speech module to say aloud.
 *
 *   {
 *     module: "MMM-Briefing",
 *     position: "middle_center",
 *     config: {
 *       people: { sam: { name: "Sam" }, heather: { name: "Heather" } },
 *       specialDays: [{ date: "12-25", person: "heather", line: "Merry Christmas, Heather." }]
 *     }
 *   }
 *
 * A special message is shown and spoken once, the first time its person is
 * recognized on that day. On other days the module draws nothing.
 */
Module.register("MMM-Briefing", {
	defaults: {
		// Keyed by the names MMM-Household uses. Each person has a display `name`.
		people: {},
		// Entries as { date, person, line }. The date is "MM-DD" for every year
		// or "YYYY-MM-DD" for one year. Leave out the person to greet everyone.
		// A season has `from` and `to` in place of the date, may give `lines`
		// that take turns by day, and `until` for "{days}" left to a date.
		specialDays: [],
		// Seconds a special message stays on screen.
		displaySeconds: 90,
		// Seconds to wait after a person is recognized before the special
		// message, so the spoken greeting comes first.
		specialDelaySeconds: 4
	},

	start () {
		this.person = null;
		this.current = null;
		this.forecast = [];
		this.events = {};
		this.tasks = {};
		this.message = null;
		this.hideTimer = null;
	},

	getScripts () {
		return [this.file("briefing.js")];
	},

	getStyles () {
		return [this.file("MMM-Briefing.css")];
	},

	// The people a module belongs to, from the person names in its classes.
	ownersOf (sender) {
		const classes = ((sender && sender.data && sender.data.classes) || "").split(/\s+/);
		return classes.filter((name) => Object.hasOwn(this.config.people, name));
	},

	// Everything the senders owned by this person have broadcast.
	gather (store, person) {
		return Object.values(store).filter((entry) => entry.owners.includes(person)).flatMap((entry) => entry.items);
	},

	notificationReceived (notification, payload, sender) {
		if (notification === "HOUSEHOLD_PRESENCE") {
			this.person = (payload && payload.person) || null;
			if (this.person) {
				setTimeout(() => this.saySpecial(this.person), this.config.specialDelaySeconds * 1000);
			}
		} else if (notification === "WEATHER_UPDATED" && payload) {
			if (payload.currentWeather) {
				this.current = payload.currentWeather;
			}
			if (Array.isArray(payload.forecastArray) && payload.forecastArray.length > 0) {
				this.forecast = payload.forecastArray;
			}
		} else if (notification === "CALENDAR_EVENTS" && sender && Array.isArray(payload)) {
			this.events[sender.identifier] = { owners: this.ownersOf(sender), items: payload };
		} else if (notification === "HOUSEHOLD_TASKS" && sender && payload && Array.isArray(payload.tasks)) {
			this.tasks[sender.identifier] = { owners: this.ownersOf(sender), items: payload.tasks };
		} else if (notification === "VOICE_COMMAND" && payload) {
			this.answer(payload.id);
		}
	},

	answer (command) {
		const { briefing, nextLine, weatherLine } = HouseholdBriefing;
		const now = new Date();
		const person = this.person;
		const name = person && this.config.people[person] ? this.config.people[person].name : "";
		const today = this.forecast[0] || null;
		let text = null;
		if (command === "weather") {
			text = weatherLine(this.current, today);
		} else if (command === "good_morning") {
			text = briefing({ name, current: this.current, today, events: this.gather(this.events, person), tasks: this.gather(this.tasks, person), now });
		} else if (command === "what_is_next") {
			text = person ? nextLine(this.gather(this.events, person), now) : "I do not see who is asking, so I will keep the calendar to myself.";
		}
		if (text) {
			this.sendNotification("TTS_SAY", { text, id: `briefing-${command}-${now.getTime()}` });
		}
	},

	saySpecial (person) {
		// The person may have walked away during the wait.
		if (this.person !== person) {
			return;
		}
		const pending = HouseholdBriefing.specialFor(this.config.specialDays, person, new Date()).filter((entry) => !this.alreadySaid(entry.key));
		if (pending.length === 0) {
			return;
		}
		pending.forEach((entry) => {
			this.markSaid(entry.key);
			this.sendNotification("TTS_SAY", { text: entry.line, id: `special-${entry.key}` });
		});
		this.message = pending.map((entry) => entry.line);
		this.updateDom(1000);
		clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => {
			this.message = null;
			this.updateDom(1000);
		}, this.config.displaySeconds * 1000);
	},

	// A restart on the same day must not repeat a message, so the record is
	// kept in the browser's storage. Without storage it is kept in memory.
	alreadySaid (key) {
		try {
			return localStorage.getItem(`briefing.special.${key}`) !== null;
		} catch {
			return Boolean(this.said && this.said.has(key));
		}
	},

	markSaid (key) {
		try {
			localStorage.setItem(`briefing.special.${key}`, "1");
		} catch {
			this.said = this.said || new Set();
			this.said.add(key);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		if (!this.message) {
			return wrapper;
		}
		wrapper.className = "briefing-special";
		this.message.forEach((line) => {
			const paragraph = document.createElement("p");
			paragraph.className = "bright medium light";
			paragraph.textContent = line;
			wrapper.appendChild(paragraph);
		});
		return wrapper;
	}
});
