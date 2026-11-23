/* Per-person preferences for the mirror: which features show in each part of
 * the day, and optional quiet hours when the screen stays off for that person.
 *
 * The functions here are pure, apart from ProfileStore, which reads and
 * writes one JSON file.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BLOCKS = [
	{ key: "morning", label: "Morning", from: "05:00" },
	{ key: "day", label: "Day", from: "11:00" },
	{ key: "evening", label: "Evening", from: "17:00" },
	{ key: "night", label: "Night", from: "22:00" }
];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (time) => {
	const [hours, minutes] = time.split(":").map(Number);
	return hours * 60 + minutes;
};

const minutesOf = (date) => date.getHours() * 60 + date.getMinutes();

/**
 * Finds the block that contains the given time. Each block runs from its
 * `from` time to the next block's, and the last one wraps past midnight.
 * @param {object[]} blocks blocks with `key` and `from`
 * @param {Date} date the moment to look up
 * @returns {object} the matching block
 */
const currentBlock = (blocks, date) => {
	const sorted = [...blocks].sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
	const now = minutesOf(date);
	let match = sorted[sorted.length - 1];
	for (const block of sorted) {
		if (toMinutes(block.from) <= now) {
			match = block;
		}
	}
	return match;
};

/**
 * Tells whether a time falls inside a daily range. A range such as 23:00 to
 * 06:00 wraps past midnight. A range with equal ends is empty.
 * @param {string} from start as HH:MM
 * @param {string} to end as HH:MM
 * @param {Date} date the moment to test
 * @returns {boolean} true inside the range
 */
const inRange = (from, to, date) => {
	const start = toMinutes(from);
	const end = toMinutes(to);
	const now = minutesOf(date);
	if (start === end) {
		return false;
	}
	return start < end ? now >= start && now < end : now >= start || now < end;
};

const defaultProfile = (featureKeys, blocks) => ({
	theme: "dark",
	blocks: Object.fromEntries(blocks.map((block) => [block.key, Object.fromEntries(featureKeys.map((key) => [key, true]))])),
	quietHours: { enabled: false, from: "23:00", to: "06:00" }
});

/**
 * Builds a complete profile from whatever was stored or submitted. Unknown
 * blocks and features are dropped and missing ones default to on.
 * @param {object} input a stored or submitted profile, possibly partial
 * @param {string[]} featureKeys the features this person can toggle
 * @param {object[]} blocks the day's blocks
 * @returns {object} a complete profile
 */
const normalize = (input, featureKeys, blocks) => {
	const profile = defaultProfile(featureKeys, blocks);
	const source = input && typeof input === "object" ? input : {};
	if (source.theme === "light" || source.theme === "dark") {
		profile.theme = source.theme;
	}
	for (const block of blocks) {
		const stored = source.blocks && source.blocks[block.key];
		if (stored && typeof stored === "object") {
			for (const key of featureKeys) {
				if (typeof stored[key] === "boolean") {
					profile.blocks[block.key][key] = stored[key];
				}
			}
		}
	}
	const quiet = source.quietHours;
	if (quiet && typeof quiet === "object") {
		if (typeof quiet.enabled === "boolean") {
			profile.quietHours.enabled = quiet.enabled;
		}
		for (const end of ["from", "to"]) {
			if (typeof quiet[end] === "string" && TIME_PATTERN.test(quiet[end])) {
				profile.quietHours[end] = quiet[end];
			}
		}
	}
	return profile;
};

/**
 * Checks a submitted profile strictly, so a bad request is refused instead of
 * being quietly repaired.
 * @param {object} input the submitted profile
 * @param {string[]} featureKeys the features this person can toggle
 * @param {object[]} blocks the day's blocks
 * @returns {string|null} a message describing the first problem, or null
 */
const problemWith = (input, featureKeys, blocks) => {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return "The profile must be an object";
	}
	const blockKeys = blocks.map((block) => block.key);
	if (input.theme !== undefined && !["dark", "light"].includes(input.theme)) {
		return "theme must be dark or light";
	}
	if (!input.blocks || typeof input.blocks !== "object") {
		return "The profile needs blocks";
	}
	for (const [blockKey, features] of Object.entries(input.blocks)) {
		if (!blockKeys.includes(blockKey)) {
			return `Unknown block ${blockKey}`;
		}
		if (!features || typeof features !== "object") {
			return `Block ${blockKey} must be an object`;
		}
		for (const [featureKey, value] of Object.entries(features)) {
			if (!featureKeys.includes(featureKey)) {
				return `Unknown feature ${featureKey}`;
			}
			if (typeof value !== "boolean") {
				return `Feature ${featureKey} must be true or false`;
			}
		}
	}
	const quiet = input.quietHours;
	if (quiet !== undefined) {
		if (!quiet || typeof quiet !== "object" || typeof quiet.enabled !== "boolean") {
			return "quietHours needs enabled set to true or false";
		}
		for (const end of ["from", "to"]) {
			if (typeof quiet[end] !== "string" || !TIME_PATTERN.test(quiet[end])) {
				return `quietHours.${end} must be a time such as 23:00`;
			}
		}
	}
	return null;
};

/**
 * Works out what the mirror should show.
 * @param {object} state what the helper knows right now
 * @param {string|null} state.person who the camera recognizes, "guest", or null
 * @param {boolean} state.unknown true when a face is present that matches nobody
 * @param {object|null} state.profile that person's profile, or null for a guest or nobody
 * @param {object[]} state.blocks the day's blocks
 * @param {number} [state.wakeUntil] time in ms until which a spoken "wake up" keeps the mirror on
 * @param {string|null} [state.asleep] the person who said "good night" and is still there
 * @param {object} [state.overrides] features switched by voice, by feature key
 * @param {Date} now the current time
 * @returns {object} who the view is for, the block of the day and the feature switches
 */
const viewFor = ({ person, unknown, profile, blocks, wakeUntil = 0, asleep = null, overrides = {} }, now) => {
	const block = currentBlock(blocks, now).key;
	const view = { person: person || null, unknown: Boolean(unknown), quiet: false, block, features: null, theme: "dark" };
	const woken = wakeUntil > now.getTime();

	if (view.person && asleep === view.person) {
		// They said good night. The mirror treats them as absent until they leave.
		return { ...view, person: null, quiet: true };
	}
	if (!view.person && woken) {
		// "Wake up" with nobody recognized shows the shared view for a while.
		view.person = "guest";
	}
	if (view.person && profile) {
		const quiet = profile.quietHours;
		if (quiet.enabled && !woken && inRange(quiet.from, quiet.to, now)) {
			// In quiet hours the mirror treats the person as absent.
			return { ...view, person: null, quiet: true };
		}
		view.features = { ...profile.blocks[block] };
		view.theme = profile.theme === "light" ? "light" : "dark";
	}
	if (view.person && Object.keys(overrides).length > 0) {
		view.features = { ...(view.features || {}), ...overrides };
	}
	return view;
};

class ProfileStore {
	constructor (file) {
		this.file = file;
		this.data = { version: 1, people: {} };
		try {
			const stored = JSON.parse(fs.readFileSync(file, "utf8"));
			if (stored && typeof stored.people === "object") {
				this.data = { version: 1, people: stored.people };
			}
		} catch (error) {
			if (error.code !== "ENOENT") {
				throw new Error(`Cannot read ${file}: ${error.message}`, { cause: error });
			}
		}
	}

	get (name, featureKeys, blocks) {
		return normalize(this.data.people[name], featureKeys, blocks);
	}

	set (name, profile) {
		this.data.people[name] = profile;
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const temporary = `${this.file}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, "\t")}\n`, { mode: 0o600 });
		fs.renameSync(temporary, this.file);
	}
}

module.exports = { DEFAULT_BLOCKS, ProfileStore, currentBlock, defaultProfile, inRange, normalize, problemWith, viewFor };
