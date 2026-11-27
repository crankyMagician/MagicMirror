/* Preferences for the mirror.
 *
 * Each person chooses a theme and which features show in each part of the
 * day. The mirror itself has the settings that belong to the place it hangs
 * in: quiet hours, when the screen stays off for everyone, and the times the
 * parts of the day start.
 *
 * The functions here are pure, apart from ProfileStore, which reads and
 * writes one JSON file.
 */
const fs = require("node:fs");
const path = require("node:path");
const { validRotation } = require("./rotation");

const DEFAULT_BLOCKS = [
	{ key: "morning", label: "Morning", from: "05:00" },
	{ key: "day", label: "Day", from: "11:00" },
	{ key: "evening", label: "Evening", from: "17:00" },
	{ key: "night", label: "Night", from: "22:00" }
];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
// A voice is named by its id in MMM-Speak's list. "" means no choice.
const VOICE_PATTERN = /^[a-z0-9-]{0,48}$/;
const DEFAULT_SPEECH = { voice: "", volume: 100, speak: true };

const validVolume = (value) => Number.isInteger(value) && value >= 0 && value <= 100;

/**
 * Checks a submitted voice id.
 * @param {unknown} voice the submitted value
 * @param {string[]} [voiceIds] the ids on offer, when known
 * @returns {boolean} true for "" and for a known id
 */
const knownVoice = (voice, voiceIds) => typeof voice === "string" && VOICE_PATTERN.test(voice) && (voice === "" || !voiceIds || voiceIds.includes(voice));

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
	// How the mirror speaks to this person. An empty voice is the mirror's own.
	speech: { ...DEFAULT_SPEECH }
});

// A wake phrase is one to three plain words. wake-phrase.js has the full story.
const PHRASE_PATTERN = /^[a-z]{2,16}( [a-z]{2,16}){0,2}$/;
// A name is short, visible text: no angle brackets and no control characters.
const validName = (name) => typeof name === "string" && name.trim().length >= 1 && name.length <= 24 && [...name].every((char) => char !== "<" && char !== ">" && char.codePointAt(0) >= 32);

const defaultMirror = () => ({
	// What people call the mirror, shown on the settings page.
	name: "Mirror",
	// The words before every spoken command, and a new phrase that is being
	// tried out beside it. The candidate takes over once the mirror hears it.
	wakePhrase: "mirror",
	wakeCandidate: "",
	// The voice for guests and for anyone who has not chosen one. "" is the
	// voice named in MMM-Speak's config.
	voice: "",
	// Which way the picture faces, as rotation.js names it. "" leaves it to
	// the kiosk's output.conf.
	rotation: "",
	// Turn a dark screen on when someone says the wake phrase.
	wakeScreen: true,
	quietHours: { enabled: false, from: "23:00", to: "06:00" },
	blocks: DEFAULT_BLOCKS.map((block) => ({ ...block }))
});

const readQuietHours = (quiet, fallback) => {
	const result = { ...fallback };
	if (quiet && typeof quiet === "object") {
		if (typeof quiet.enabled === "boolean") {
			result.enabled = quiet.enabled;
		}
		for (const end of ["from", "to"]) {
			if (typeof quiet[end] === "string" && TIME_PATTERN.test(quiet[end])) {
				result[end] = quiet[end];
			}
		}
	}
	return result;
};

const inOrder = (blocks) => blocks.every((block, index) => index === 0 || toMinutes(blocks[index - 1].from) < toMinutes(block.from));

/**
 * Builds the mirror's settings from whatever was stored or submitted. The
 * parts of the day keep their names and order. Only their start times can
 * change, and a set of times that is out of order is dropped as a whole.
 * @param {object} input stored or submitted mirror settings, possibly partial
 * @returns {object} complete mirror settings
 */
const normalizeMirror = (input) => {
	const mirror = defaultMirror();
	const source = input && typeof input === "object" ? input : {};
	mirror.quietHours = readQuietHours(source.quietHours, mirror.quietHours);
	if (knownVoice(source.voice)) {
		mirror.voice = source.voice;
	}
	if (validName(source.name)) {
		mirror.name = source.name.trim();
	}
	if (validRotation(source.rotation)) {
		mirror.rotation = source.rotation;
	}
	if (typeof source.wakeScreen === "boolean") {
		mirror.wakeScreen = source.wakeScreen;
	}
	if (typeof source.wakePhrase === "string" && PHRASE_PATTERN.test(source.wakePhrase)) {
		mirror.wakePhrase = source.wakePhrase;
	}
	if (typeof source.wakeCandidate === "string" && PHRASE_PATTERN.test(source.wakeCandidate) && source.wakeCandidate !== mirror.wakePhrase) {
		mirror.wakeCandidate = source.wakeCandidate;
	}
	if (Array.isArray(source.blocks)) {
		const blocks = mirror.blocks.map((block) => {
			const stored = source.blocks.find((entry) => entry && entry.key === block.key);
			return stored && typeof stored.from === "string" && TIME_PATTERN.test(stored.from) ? { ...block, from: stored.from } : block;
		});
		if (inOrder(blocks)) {
			mirror.blocks = blocks;
		}
	}
	return mirror;
};

/**
 * Checks submitted mirror settings strictly.
 * @param {object} input the submitted settings
 * @param {string[]} [voiceIds] the voices on offer
 * @returns {string|null} a message describing the first problem, or null
 */
const problemWithMirror = (input, voiceIds) => {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return "The mirror settings must be an object";
	}
	if (input.voice !== undefined && !knownVoice(input.voice, voiceIds)) {
		return "voice must be one of the voices on offer";
	}
	if (input.name !== undefined && !validName(input.name)) {
		return "name must be 1 to 24 characters";
	}
	if (input.rotation !== undefined && !validRotation(input.rotation)) {
		return "rotation must be one of the directions on offer";
	}
	if (input.wakeScreen !== undefined && typeof input.wakeScreen !== "boolean") {
		return "wakeScreen must be true or false";
	}
	if (input.wakeCandidate !== undefined && input.wakeCandidate !== "" && !(typeof input.wakeCandidate === "string" && PHRASE_PATTERN.test(input.wakeCandidate))) {
		return "A wake phrase is one to three plain words of letters only";
	}
	const quiet = input.quietHours;
	if (!quiet || typeof quiet !== "object" || typeof quiet.enabled !== "boolean") {
		return "quietHours needs enabled set to true or false";
	}
	for (const end of ["from", "to"]) {
		if (typeof quiet[end] !== "string" || !TIME_PATTERN.test(quiet[end])) {
			return `quietHours.${end} must be a time such as 23:00`;
		}
	}
	if (!Array.isArray(input.blocks) || input.blocks.length !== DEFAULT_BLOCKS.length) {
		return `blocks must list the ${DEFAULT_BLOCKS.length} parts of the day`;
	}
	for (const [index, block] of DEFAULT_BLOCKS.entries()) {
		const given = input.blocks[index];
		if (!given || given.key !== block.key) {
			return `The parts of the day are ${DEFAULT_BLOCKS.map((entry) => entry.key).join(", ")}, in that order`;
		}
		if (typeof given.from !== "string" || !TIME_PATTERN.test(given.from)) {
			return `${block.label} needs a start time such as ${block.from}`;
		}
	}
	if (!inOrder(input.blocks)) {
		return "Each part of the day has to start after the one before it";
	}
	return null;
};

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
	const speech = source.speech;
	if (speech && typeof speech === "object") {
		if (knownVoice(speech.voice)) {
			profile.speech.voice = speech.voice;
		}
		if (validVolume(speech.volume)) {
			profile.speech.volume = speech.volume;
		}
		if (typeof speech.speak === "boolean") {
			profile.speech.speak = speech.speak;
		}
	}
	return profile;
};

/**
 * Checks a submitted profile strictly, so a bad request is refused instead of
 * being quietly repaired. Quiet hours used to be part of a profile. A page
 * that still sends them is not refused, and the field is ignored.
 * @param {object} input the submitted profile
 * @param {string[]} featureKeys the features this person can toggle
 * @param {object[]} blocks the day's blocks
 * @param {string[]} [voiceIds] the voices on offer
 * @returns {string|null} a message describing the first problem, or null
 */
const problemWith = (input, featureKeys, blocks, voiceIds) => {
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
	const speech = input.speech;
	if (speech !== undefined) {
		if (!speech || typeof speech !== "object") {
			return "speech must be an object";
		}
		if (!knownVoice(speech.voice, voiceIds)) {
			return "speech.voice must be one of the voices on offer";
		}
		if (!validVolume(speech.volume)) {
			return "speech.volume must be a whole number from 0 to 100";
		}
		if (typeof speech.speak !== "boolean") {
			return "speech.speak must be true or false";
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
 * @param {object} [state.quietHours] the mirror's quiet hours: enabled, from and to
 * @param {string} [state.mirrorVoice] the mirror's default voice id
 * @param {number} [state.wakeUntil] time in ms until which a spoken "wake up" keeps the mirror on
 * @param {string|null} [state.asleep] the person who said "good night" and is still there
 * @param {object} [state.overrides] features switched by voice, by feature key
 * @param {string|null} [state.focus] the one feature someone asked to see alone, by feature key
 * @param {Date} now the current time
 * @returns {object} who the view is for, the block of the day, the feature switches and how to speak
 */
const viewFor = ({ person, unknown, profile, blocks, quietHours = null, mirrorVoice = "", wakeUntil = 0, asleep = null, overrides = {}, focus = null }, now) => {
	const block = currentBlock(blocks, now).key;
	// Until a person with a voice of their own is seen, the mirror speaks in its own.
	const view = { person: person || null, unknown: Boolean(unknown), quiet: false, block, features: null, theme: "dark", speech: { ...DEFAULT_SPEECH, voice: mirrorVoice } };
	const woken = wakeUntil > now.getTime();

	if (view.person && asleep === view.person) {
		// They said good night. The mirror treats them as absent until they leave.
		return { ...view, person: null, quiet: true };
	}
	if (!view.person && woken) {
		// "Wake up" with nobody recognized shows the shared view for a while.
		view.person = "guest";
	}
	if (view.person && quietHours && quietHours.enabled && !woken && inRange(quietHours.from, quietHours.to, now)) {
		// In quiet hours the mirror treats everyone as absent, guests included.
		return { ...view, person: null, quiet: true };
	}
	if (view.person && profile) {
		view.features = { ...profile.blocks[block] };
		view.theme = profile.theme === "light" ? "light" : "dark";
		view.speech = { ...profile.speech, voice: profile.speech.voice || mirrorVoice };
	}
	if (view.person && Object.keys(overrides).length > 0) {
		view.features = { ...(view.features || {}), ...overrides };
	}
	if (view.person && focus) {
		// "Show only X": that feature alone, whatever the switches say.
		view.focus = focus;
	}
	return view;
};

/**
 * Tells whether a feature can be shown alone to whoever is at the mirror.
 * @param {object[]} features the mirror's features, each with a key and its owners
 * @param {string} key the feature asked for
 * @param {string|null} person who is at the mirror, or null for a guest
 * @returns {boolean} true for a shared feature and for one of that person's own
 */
const canFocus = (features, key, person) => {
	const feature = (Array.isArray(features) ? features : []).find((known) => known.key === key);
	return Boolean(feature) && (feature.owners.length === 0 || (person !== null && feature.owners.includes(person)));
};

class ProfileStore {
	constructor (file) {
		this.file = file;
		this.data = { version: 2, mirror: defaultMirror(), people: {} };
		try {
			const stored = JSON.parse(fs.readFileSync(file, "utf8"));
			if (stored && typeof stored.people === "object") {
				this.data.people = stored.people;
				this.data.mirror = normalizeMirror(stored.mirror);
				if (!stored.mirror) {
					// Version 1 kept quiet hours with each person. The mirror takes
					// over the first set that was switched on.
					const quiet = Object.values(stored.people).map((person) => person && person.quietHours).find((hours) => hours && hours.enabled === true);
					this.data.mirror.quietHours = readQuietHours(quiet, this.data.mirror.quietHours);
				}
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
		this.save();
	}

	getMirror () {
		return structuredClone(this.data.mirror);
	}

	setMirror (mirror) {
		this.data.mirror = normalizeMirror(mirror);
		this.save();
	}

	save () {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const temporary = `${this.file}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, "\t")}\n`, { mode: 0o600 });
		fs.renameSync(temporary, this.file);
	}
}

module.exports = { DEFAULT_BLOCKS, DEFAULT_SPEECH, ProfileStore, canFocus, currentBlock, defaultMirror, defaultProfile, inRange, normalize, normalizeMirror, problemWith, problemWithMirror, viewFor };
