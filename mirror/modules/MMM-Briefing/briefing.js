/* Builds the sentences the mirror says. This one file serves both sides: the
 * browser loads it as a script and gets HouseholdBriefing, and Node requires
 * it in the tests. Nothing here talks to the network or the screen. */
(function (root) {
	const DAY = 24 * 60 * 60 * 1000;

	const pad = (number) => String(number).padStart(2, "0");
	const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

	// Weather icon names, without their "day-" or "night-" prefix, as words.
	const SKY = {
		sunny: "sunny",
		clear: "clear",
		cloudy: "cloudy",
		"cloudy-windy": "cloudy and windy",
		"cloudy-gusts": "cloudy and gusty",
		"alt-cloudy": "partly cloudy",
		"alt-cloudy-windy": "partly cloudy and windy",
		"partly-cloudy": "partly cloudy",
		fog: "foggy",
		haze: "hazy",
		windy: "windy",
		"strong-wind": "very windy",
		showers: "showery",
		"alt-showers": "showery",
		rain: "rainy",
		"alt-rain": "rainy",
		sprinkle: "drizzly",
		sleet: "sleeting",
		snow: "snowy",
		"alt-snow": "snowy",
		thunderstorm: "stormy",
		"alt-thunderstorm": "stormy"
	};

	/**
	 * Turns a weather icon name such as "day-sunny" into a word.
	 * @param {string} weatherType the icon name
	 * @returns {string} a word, or "" for a name that is not known
	 */
	const skyWord = (weatherType) => SKY[String(weatherType || "").replace(/^(day|night)-/, "")] || "";

	/**
	 * Says the weather now and today's range.
	 * @param {object|null} current the weather now, with temperature and weatherType
	 * @param {object|null} today today's forecast, with minTemperature and maxTemperature
	 * @returns {string} one or two sentences, or a line saying the weather is not known
	 */
	const weatherLine = (current, today) => {
		const parts = [];
		if (current && Number.isFinite(current.temperature)) {
			const sky = skyWord(current.weatherType);
			parts.push(`It is ${Math.round(current.temperature)} degrees${sky ? ` and ${sky}` : ""}.`);
		}
		if (today && Number.isFinite(today.maxTemperature) && Number.isFinite(today.minTemperature)) {
			parts.push(`Today's high is ${Math.round(today.maxTemperature)} and the low is ${Math.round(today.minTemperature)}.`);
		}
		if (today && Number.isFinite(today.precipitationProbability) && today.precipitationProbability >= 30) {
			parts.push(`There is a ${Math.round(today.precipitationProbability)} percent chance of rain.`);
		}
		return parts.length > 0 ? parts.join(" ") : "I do not have the weather yet.";
	};

	/**
	 * Says a time of day the way a person would: "3 PM", "9:30 AM".
	 * @param {Date} date the moment
	 * @returns {string} the spoken time
	 */
	const spokenTime = (date) => {
		const hour = date.getHours() % 12 || 12;
		const minutes = date.getMinutes();
		return `${hour}${minutes === 0 ? "" : `:${pad(minutes)}`} ${date.getHours() < 12 ? "AM" : "PM"}`;
	};

	/**
	 * Says when an event starts, relative to now.
	 * @param {object} event an event with startDate in ms and fullDayEvent
	 * @param {Date} now the current time
	 * @returns {string} for example "today at 3 PM", "tomorrow", "on Friday at 9 AM"
	 */
	const whenWords = (event, now) => {
		const start = new Date(event.startDate);
		const days = Math.round((startOfDay(start) - startOfDay(now)) / DAY);
		let day;
		if (days <= 0) {
			day = "today";
		} else if (days === 1) {
			day = "tomorrow";
		} else if (days < 7) {
			day = `on ${start.toLocaleDateString("en-US", { weekday: "long" })}`;
		} else {
			day = `on ${start.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
		}
		return event.fullDayEvent ? day : `${day} at ${spokenTime(start)}`;
	};

	// Keeps a title short enough to say, and drops what a voice reads badly.
	const sayable = (title, limit = 60) => {
		const clean = String(title || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim() || "an event";
		return clean.length > limit ? `${clean.slice(0, limit).replace(/\s+\S*$/, "")}` : clean;
	};

	/**
	 * Keeps the events that have not ended, earliest first, without repeats.
	 * @param {object[]} events events with title, startDate, endDate, fullDayEvent
	 * @param {Date} now the current time
	 * @returns {object[]} upcoming and running events
	 */
	const upcoming = (events, now) => {
		const seen = new Set();
		return (events || [])
			.filter((event) => event && Number.isFinite(event.startDate) && (event.endDate || event.startDate) > now.getTime())
			.sort((a, b) => a.startDate - b.startDate)
			.filter((event) => {
				const key = `${event.title}|${event.startDate}`;
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			});
	};

	/**
	 * Answers "what is next".
	 * @param {object[]} events the person's events
	 * @param {Date} now the current time
	 * @returns {string} one or two sentences
	 */
	const nextLine = (events, now) => {
		const list = upcoming(events, now);
		const running = list.find((event) => !event.fullDayEvent && event.startDate <= now.getTime());
		const next = list.find((event) => event.startDate > now.getTime());
		const parts = [];
		if (running) {
			parts.push(`${sayable(running.title)} is happening now.`);
		}
		if (next) {
			parts.push(`Next is ${sayable(next.title)}, ${whenWords(next, now)}.`);
		}
		return parts.length > 0 ? parts.join(" ") : "Nothing else is on your calendar.";
	};

	/**
	 * Says what today holds.
	 * @param {object[]} events the person's events
	 * @param {Date} now the current time
	 * @returns {string} one or two sentences
	 */
	const todayLine = (events, now) => {
		const endOfDay = startOfDay(now) + DAY;
		const today = upcoming(events, now).filter((event) => event.startDate < endOfDay);
		if (today.length === 0) {
			return "Your calendar is clear for the rest of today.";
		}
		const first = today.find((event) => !event.fullDayEvent) || today[0];
		const lead = today.length === 1 ? "You have 1 event left today." : `You have ${today.length} events left today.`;
		const detail = first.fullDayEvent ? `${sayable(first.title)} is all day.` : `${today.length === 1 ? "It" : "The first"} is ${sayable(first.title)} at ${spokenTime(new Date(first.startDate))}.`;
		return `${lead} ${detail}`;
	};

	/**
	 * Says how many tasks are open and how many are due.
	 * @param {object[]} tasks tasks as { title, due }, due as an ISO date or empty
	 * @param {Date} now the current time
	 * @returns {string} one sentence, or "" when there are no tasks
	 */
	const tasksLine = (tasks, now) => {
		const list = tasks || [];
		if (list.length === 0) {
			return "";
		}
		const today = localDay(now);
		const due = list.filter((task) => task.due && task.due.slice(0, 10) <= today).length;
		return `You have ${plural(list.length, "open task")}${due > 0 ? `, ${due} due today or earlier` : ""}.`;
	};

	/**
	 * Names the part of the day for a greeting.
	 * @param {Date} now the current time
	 * @returns {string} "morning", "afternoon" or "evening"
	 */
	const partOfDay = (now) => {
		const hour = now.getHours();
		if (hour >= 4 && hour < 12) {
			return "morning";
		}
		return hour >= 12 && hour < 17 ? "afternoon" : "evening";
	};

	/**
	 * Builds the briefing a person hears after "good morning".
	 * @param {object} about what is known
	 * @param {string} about.name the person's name, or "" when nobody is recognized
	 * @param {object|null} about.current the weather now
	 * @param {object|null} about.today today's forecast
	 * @param {object[]} about.events the person's events
	 * @param {object[]} about.tasks the person's tasks
	 * @param {Date} about.now the current time
	 * @returns {string} the briefing
	 */
	const briefing = ({ name, current, today, events, tasks, now }) => {
		const parts = [`Good ${partOfDay(now)}${name ? `, ${name}` : ""}.`, weatherLine(current, today)];
		if (name) {
			parts.push(todayLine(events, now));
			parts.push(tasksLine(tasks, now));
		}
		return parts.filter(Boolean).join(" ");
	};

	// Tells whether a month and day fall in a season given as "MM-DD" to
	// "MM-DD", both ends included. A season may run over the new year.
	const inSeason = (entry, monthDay) => {
		if (typeof entry.from !== "string" || typeof entry.to !== "string") {
			return false;
		}
		return entry.from <= entry.to ? monthDay >= entry.from && monthDay <= entry.to : monthDay >= entry.from || monthDay <= entry.to;
	};

	// Days from today to the next "MM-DD", or null when that is not a date.
	const daysUntil = (monthDay, now) => {
		const [month, day] = String(monthDay).split("-").map(Number);
		if (!Number.isInteger(month) || !Number.isInteger(day)) {
			return null;
		}
		const thisYear = new Date(now.getFullYear(), month - 1, day).getTime();
		const target = thisYear < startOfDay(now) ? new Date(now.getFullYear() + 1, month - 1, day).getTime() : thisYear;
		return Math.round((target - startOfDay(now)) / DAY);
	};

	/**
	 * Finds the special messages for a person on a day.
	 * @param {object[]} days entries as { date, person, line }. The date is
	 *   "MM-DD" for every year or "YYYY-MM-DD" for one year. An entry without
	 *   a person is for everyone. In place of a date, `from` and `to` ("MM-DD")
	 *   make the entry count on every day of a season. `lines` in place of
	 *   `line` gives the days of a season a line each, in turn. `until`
	 *   ("MM-DD") makes "{days}" in a line the days left to that date.
	 *   `scene` names a scene of MMM-Lights to set when the line is said.
	 * @param {string} person the recognized person
	 * @param {Date} now the current time
	 * @returns {object[]} matching entries as { key, line }, with `scene` when the entry has one
	 */
	const specialFor = (days, person, now) => {
		const full = localDay(now);
		const turn = Math.round(startOfDay(now) / DAY);
		return (Array.isArray(days) ? days : [])
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry && (entry.date === full || entry.date === full.slice(5) || inSeason(entry, full.slice(5))))
			.filter(({ entry }) => !entry.person || entry.person === person)
			.map(({ entry, index }) => ({ entry, index, text: Array.isArray(entry.lines) && entry.lines.length > 0 ? entry.lines[turn % entry.lines.length] : entry.line }))
			.filter(({ text }) => typeof text === "string" && text.trim() !== "")
			// An anniversary gives the year it counts from, and "{years}" in its
			// line becomes the count. It says nothing in that first year.
			.map((found) => ({ ...found, years: Number.isInteger(found.entry.since) ? now.getFullYear() - found.entry.since : null }))
			.filter(({ years }) => years === null || years > 0)
			// A countdown says nothing on the day it counts down to. That day
			// has a line of its own.
			.map((found) => ({ ...found, left: found.entry.until ? daysUntil(found.entry.until, now) : null }))
			.filter(({ left }) => left === null || left > 0)
			.map(({ entry, index, text, years, left }) => ({
				key: `${full}.${person}.${index}`,
				...typeof entry.scene === "string" && entry.scene ? { scene: entry.scene } : {},
				line: text
					.trim()
					.replaceAll("{years}", years === null ? "" : String(years))
					.replaceAll("{days}", left === null ? "" : plural(left, "day"))
					.replace(/\s+/g, " ")
					.trim()
			}));
	};

	const api = { briefing, nextLine, partOfDay, skyWord, specialFor, spokenTime, tasksLine, todayLine, upcoming, weatherLine, whenWords };
	root.HouseholdBriefing = api;
	if (typeof module !== "undefined") {
		module.exports = api;
	}
}(typeof window === "undefined" ? globalThis : window));
