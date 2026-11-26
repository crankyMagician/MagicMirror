/* What a spoken light command means and what the mirror says back. No network here. */

const DEFAULTS = {
	// Where Home Assistant answers, for example "http://192.168.10.212:8123".
	// Empty leaves the module idle.
	url: "",
	// The lights the mirror may switch, by key: { label, say, entity }. The
	// label is for the card, `say` is how the mirror names it aloud, and the
	// entity is a light or a group of lights in Home Assistant. With
	// `card: false` a light takes commands and has no row on the card.
	lights: {},
	// The scenes the mirror may set, by key: { say, entity }. The entity is
	// a scene or a script in Home Assistant. A script names the lights to
	// count afterwards in `members`, and `done` is said in place of
	// "NAME is set". `quiet: true` says nothing when the scene worked.
	scenes: {},
	// Seconds between looks at the lights for the card.
	pollSeconds: 20,
	// Seconds to wait for the lights to report what was asked of them.
	confirmSeconds: 5,
	// A command heard again within this many seconds is taken as an echo.
	repeatSeconds: 4
};

/**
 * Reads a command id from MMM-Voice against the lights and scenes the mirror may use.
 * @param {string} id "light:on:KEY", "light:off:KEY", "light:level:KEY:PERCENT" or "light:scene:KEY"
 * @param {object} [config] the module's config
 * @param {object} [config.lights] the lights the mirror may switch, by key
 * @param {object} [config.scenes] the scenes the mirror may set, by key
 * @returns {object|null} `{ kind, key, target, want }`, or null for anything else
 */
const parse = (id, { lights = {}, scenes = {} } = {}) => {
	const [family, kind, key, value, ...rest] = String(id).split(":");
	if (family !== "light" || rest.length > 0) {
		return null;
	}
	if (kind === "scene" && value === undefined && Object.hasOwn(scenes, key)) {
		return { kind, key, target: scenes[key], want: null };
	}
	if (!Object.hasOwn(lights, key)) {
		return null;
	}
	if ((kind === "on" || kind === "off") && value === undefined) {
		return { kind, key, target: lights[key], want: { on: kind === "on" } };
	}
	const percent = Number(value);
	if (kind === "level" && Number.isInteger(percent) && percent >= 1 && percent <= 100) {
		return { kind, key, target: lights[key], want: { on: true, level: percent } };
	}
	return null;
};

/**
 * Tells whether one light is in the state that was asked for.
 * @param {object} light `{ available, on, level }` as home.js reads it
 * @param {object} want `{ on, level }`
 * @returns {boolean} true when it is
 */
const reached = (light, want) => {
	if (!light.available || light.on !== want.on) {
		return false;
	}
	// A bulb rounds a percentage to its own steps.
	return want.level === undefined || (light.level !== null && Math.abs(light.level - want.level) <= 3);
};

/**
 * Counts what a group of lights is doing.
 * @param {object[]} members the lights, each `{ available, on, level }`
 * @returns {object} `{ total, on, missing, level }`, the level being the average of the lights that are on
 */
const summarize = (members) => {
	const lit = members.filter((light) => light.available && light.on);
	const levels = lit.map((light) => light.level).filter((level) => level !== null);
	return {
		total: members.length,
		on: lit.length,
		missing: members.filter((light) => !light.available).length,
		level: levels.length > 0 ? Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length) : null
	};
};

/**
 * Words a card row for a light or a group.
 * @param {object|null} summary what `summarize` returned, or null when the light could not be read
 * @returns {{status: string, tone: string}} the text and "on", "off" or "missing"
 */
const describe = (summary) => {
	if (!summary || summary.total === 0 || summary.missing === summary.total) {
		return { status: "Not answering", tone: "missing" };
	}
	if (summary.on === 0) {
		return { status: "Off", tone: "off" };
	}
	const level = summary.level === null ? "" : ` ${summary.level}%`;
	const answering = summary.total - summary.missing;
	return { status: summary.on === answering ? `On${level}` : `${summary.on} of ${summary.total} on${level}`, tone: "on" };
};

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Words what the mirror says after a command, from what the lights reported.
 * @param {object} command what `parse` returned
 * @param {object} outcome `{ total, reached }` from home.js, or `{ error }`
 * @returns {string} one short sentence, or nothing for a quiet scene that worked
 */
const answer = (command, outcome) => {
	const name = capital(command.target.say);
	if (outcome.error === "unreachable") {
		return "I could not reach the house controls.";
	}
	if (outcome.error === "unknown" || !outcome.total) {
		return `The house controls do not know ${command.target.say}.`;
	}
	if (outcome.reached === 0) {
		return `${name} did not answer.`;
	}
	if (outcome.reached < outcome.total) {
		return `${name}: ${outcome.reached} of ${outcome.total} answered.`;
	}
	if (command.kind === "scene") {
		// A quiet scene says nothing when it worked. Something else is
		// speaking at that moment, such as a special day's line.
		if (command.target.quiet) {
			return "";
		}
		return command.target.done || `${name} is set.`;
	}
	if (command.kind === "level") {
		return `${name} at ${command.want.level} percent.`;
	}
	return `${name} ${command.kind}.`;
};

/**
 * Remembers recent commands, so one that the microphone hears twice runs once.
 * @param {number} seconds how long a command counts as recent
 * @param {function(): number} [now] the clock, in milliseconds
 * @returns {function(string): boolean} tells whether this id was just seen, and notes it
 */
const repeatGuard = (seconds, now = Date.now) => {
	const seen = new Map();
	return (id) => {
		const time = now();
		const last = seen.get(id);
		seen.set(id, time);
		return last !== undefined && time - last < seconds * 1000;
	};
};

module.exports = { DEFAULTS, answer, describe, parse, reached, repeatGuard, summarize };
