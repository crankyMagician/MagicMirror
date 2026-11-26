// Run with: node --test "mirror/modules/**/*.test.js"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_BLOCKS, ProfileStore, canFocus, currentBlock, defaultMirror, inRange, normalize, normalizeMirror, problemWith, problemWithMirror, viewFor } = require("./profiles");

const at = (time) => {
	const [hours, minutes] = time.split(":").map(Number);
	return new Date(2026, 10, 22, hours, minutes);
};
const FEATURES = ["clock", "calendar", "newsfeed"];

test("currentBlock picks the block that has started most recently", () => {
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("05:00")).key, "morning");
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("10:59")).key, "morning");
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("11:00")).key, "day");
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("21:59")).key, "evening");
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("22:00")).key, "night");
});

test("currentBlock wraps the last block past midnight", () => {
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("00:30")).key, "night");
	assert.equal(currentBlock(DEFAULT_BLOCKS, at("04:59")).key, "night");
});

test("inRange handles a range inside one day", () => {
	assert.equal(inRange("09:00", "17:00", at("12:00")), true);
	assert.equal(inRange("09:00", "17:00", at("17:00")), false);
	assert.equal(inRange("09:00", "17:00", at("08:59")), false);
});

test("inRange handles a range that wraps past midnight", () => {
	assert.equal(inRange("23:00", "06:00", at("23:30")), true);
	assert.equal(inRange("23:00", "06:00", at("02:00")), true);
	assert.equal(inRange("23:00", "06:00", at("06:00")), false);
	assert.equal(inRange("23:00", "06:00", at("12:00")), false);
});

test("inRange treats equal ends as an empty range", () => {
	assert.equal(inRange("08:00", "08:00", at("08:00")), false);
});

test("normalize turns everything on for a new person", () => {
	const profile = normalize(undefined, FEATURES, DEFAULT_BLOCKS);
	assert.deepEqual(Object.keys(profile.blocks), ["morning", "day", "evening", "night"]);
	assert.equal(profile.blocks.night.newsfeed, true);
	assert.equal("quietHours" in profile, false);
});

test("normalize keeps stored choices and drops what it does not know", () => {
	const stored = { blocks: { night: { newsfeed: false, removed: false }, brunch: { clock: false } }, quietHours: { enabled: true, from: "22:30", to: "nonsense" } };
	const profile = normalize(stored, FEATURES, DEFAULT_BLOCKS);
	assert.equal(profile.blocks.night.newsfeed, false);
	assert.equal(profile.blocks.night.clock, true);
	assert.equal("removed" in profile.blocks.night, false);
	assert.equal("brunch" in profile.blocks, false);
	// Quiet hours belong to the mirror now, so a stored set is dropped from the person.
	assert.equal("quietHours" in profile, false);
});

test("problemWith accepts a complete profile", () => {
	assert.equal(problemWith(normalize(undefined, FEATURES, DEFAULT_BLOCKS), FEATURES, DEFAULT_BLOCKS), null);
});

test("problemWith refuses unknown names and wrong types", () => {
	assert.match(problemWith({ blocks: { brunch: {} } }, FEATURES, DEFAULT_BLOCKS), /Unknown block/);
	assert.match(problemWith({ blocks: { day: { stocks: true } } }, FEATURES, DEFAULT_BLOCKS), /Unknown feature/);
	assert.match(problemWith({ blocks: { day: { clock: "yes" } } }, FEATURES, DEFAULT_BLOCKS), /true or false/);
	// A page from before quiet hours moved to the mirror still sends them. That is not an error.
	assert.equal(problemWith({ blocks: {}, quietHours: { enabled: true, from: "25:00", to: "06:00" } }, FEATURES, DEFAULT_BLOCKS), null);
	assert.match(problemWith([], FEATURES, DEFAULT_BLOCKS), /must be an object/);
});

test("ProfileStore saves and reloads a profile", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "household-"));
	const file = path.join(directory, "profiles.json");
	const store = new ProfileStore(file);
	const profile = normalize({ blocks: { day: { clock: false } } }, FEATURES, DEFAULT_BLOCKS);
	store.set("heather", profile);
	const reloaded = new ProfileStore(file).get("heather", FEATURES, DEFAULT_BLOCKS);
	assert.equal(reloaded.blocks.day.clock, false);
	assert.equal(reloaded.blocks.day.calendar, true);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	fs.rmSync(directory, { recursive: true });
});

const profileOf = (changes = {}) => normalize(changes, FEATURES, DEFAULT_BLOCKS);
const state = (extra) => ({ person: "heather", unknown: false, profile: profileOf(), blocks: DEFAULT_BLOCKS, ...extra });

test("viewFor gives a person their switches for the block", () => {
	const view = viewFor(state({ profile: profileOf({ blocks: { evening: { newsfeed: false } } }) }), at("19:00"));
	assert.equal(view.person, "heather");
	assert.equal(view.block, "evening");
	assert.equal(view.features.newsfeed, false);
	assert.equal(view.features.clock, true);
});

const QUIET = { enabled: true, from: "23:00", to: "06:00" };

test("viewFor treats everyone as absent in the mirror's quiet hours", () => {
	const view = viewFor(state({ quietHours: QUIET }), at("23:30"));
	assert.equal(view.person, null);
	assert.equal(view.quiet, true);
	const guest = viewFor({ person: "guest", unknown: false, profile: null, blocks: DEFAULT_BLOCKS, quietHours: QUIET }, at("23:30"));
	assert.equal(guest.person, null);
	assert.equal(guest.quiet, true);
	// Outside the hours, and with the switch off, people are seen as usual.
	assert.equal(viewFor(state({ quietHours: QUIET }), at("12:00")).person, "heather");
	assert.equal(viewFor(state({ quietHours: { ...QUIET, enabled: false } }), at("23:30")).person, "heather");
});

test("a spoken wake up overrides quiet hours", () => {
	const now = at("23:30");
	const view = viewFor(state({ quietHours: QUIET, wakeUntil: now.getTime() + 60000 }), now);
	assert.equal(view.person, "heather");
	assert.equal(view.quiet, false);
	const nobody = viewFor({ person: null, unknown: false, profile: null, blocks: DEFAULT_BLOCKS, quietHours: QUIET, wakeUntil: now.getTime() + 60000 }, now);
	assert.equal(nobody.person, "guest");
});

test("a spoken wake up with nobody recognized shows the guest view, then expires", () => {
	const now = at("12:00");
	const base = { person: null, unknown: false, profile: null, blocks: DEFAULT_BLOCKS };
	assert.equal(viewFor({ ...base, wakeUntil: now.getTime() + 60000 }, now).person, "guest");
	assert.equal(viewFor({ ...base, wakeUntil: now.getTime() - 1 }, now).person, null);
});

test("good night keeps the mirror dark for that person only", () => {
	assert.equal(viewFor(state({ asleep: "heather" }), at("21:00")).person, null);
	assert.equal(viewFor(state({ asleep: "sam" }), at("21:00")).person, "heather");
});

test("voice overrides lie over the profile and also apply to a guest", () => {
	const view = viewFor(state({ overrides: { newsfeed: false } }), at("12:00"));
	assert.equal(view.features.newsfeed, false);
	assert.equal(view.features.calendar, true);
	const guest = viewFor({ person: "guest", unknown: false, profile: null, blocks: DEFAULT_BLOCKS, overrides: { clock: false } }, at("12:00"));
	assert.deepEqual(guest.features, { clock: false });
});

test("viewFor shows nothing personal to nobody", () => {
	const view = viewFor({ person: null, unknown: true, profile: null, blocks: DEFAULT_BLOCKS }, at("12:00"));
	assert.equal(view.person, null);
	assert.equal(view.unknown, true);
	assert.equal(view.features, null);
});

test("themes default to dark and migrate without changing schedules", () => {
	const profile = normalize({ blocks: { night: { clock: false } } }, FEATURES, DEFAULT_BLOCKS);
	assert.equal(profile.theme, "dark");
	assert.equal(profile.blocks.night.clock, false);
	assert.equal(normalize({ theme: "light" }, FEATURES, DEFAULT_BLOCKS).theme, "light");
	assert.match(problemWith({ blocks: {}, theme: "automatic" }, FEATURES, DEFAULT_BLOCKS), /theme/);
});

test("themes follow the recognized person and return to dark in quiet hours or for a guest", () => {
	const profile = normalize({ theme: "light" }, FEATURES, DEFAULT_BLOCKS);
	assert.equal(viewFor({ person: "heather", profile, blocks: DEFAULT_BLOCKS, quietHours: QUIET }, at("12:00")).theme, "light");
	assert.equal(viewFor({ person: "heather", profile, blocks: DEFAULT_BLOCKS, quietHours: QUIET }, at("23:30")).theme, "dark");
	assert.equal(viewFor({ person: "guest", profile: null, blocks: DEFAULT_BLOCKS }, at("12:00")).theme, "dark");
	assert.equal(viewFor({ person: "sam", profile: normalize({}, FEATURES, DEFAULT_BLOCKS), blocks: DEFAULT_BLOCKS }, at("12:00")).theme, "dark");
});

const blocksAt = (...times) => DEFAULT_BLOCKS.map((block, index) => ({ key: block.key, from: times[index] }));

test("the mirror starts with quiet hours off and the usual parts of the day", () => {
	const mirror = defaultMirror();
	assert.equal(mirror.quietHours.enabled, false);
	assert.deepEqual(mirror.blocks, DEFAULT_BLOCKS);
	assert.equal(problemWithMirror(mirror), null);
	assert.deepEqual(normalizeMirror(undefined), mirror);
});

test("normalizeMirror keeps valid times and labels, and drops a set that is out of order", () => {
	const moved = normalizeMirror({ quietHours: { enabled: true, from: "22:00", to: "nonsense" }, blocks: blocksAt("06:30", "12:00", "18:00", "21:30") });
	assert.deepEqual(moved.quietHours, { enabled: true, from: "22:00", to: "06:00" });
	assert.deepEqual(moved.blocks.map((block) => block.from), ["06:30", "12:00", "18:00", "21:30"]);
	assert.deepEqual(moved.blocks.map((block) => block.label), ["Morning", "Day", "Evening", "Night"]);
	assert.equal(currentBlock(moved.blocks, at("06:00")).key, "night");
	assert.equal(currentBlock(moved.blocks, at("21:45")).key, "night");
	const jumbled = normalizeMirror({ blocks: blocksAt("12:00", "06:30", "18:00", "21:30") });
	assert.deepEqual(jumbled.blocks, DEFAULT_BLOCKS);
	const partial = normalizeMirror({ blocks: [{ key: "day", from: "12:30" }, { key: "brunch", from: "10:00" }, { key: "night", from: "9pm" }] });
	assert.deepEqual(partial.blocks.map((block) => block.from), ["05:00", "12:30", "17:00", "22:00"]);
});

test("problemWithMirror refuses bad times, a wrong list and times out of order", () => {
	const good = { quietHours: { enabled: false, from: "23:00", to: "06:00" }, blocks: blocksAt("05:00", "11:00", "17:00", "22:00") };
	assert.equal(problemWithMirror(good), null);
	assert.match(problemWithMirror([]), /must be an object/);
	assert.match(problemWithMirror({ ...good, quietHours: { from: "23:00", to: "06:00" } }), /enabled/);
	assert.match(problemWithMirror({ ...good, quietHours: { enabled: true, from: "25:00", to: "06:00" } }), /must be a time/);
	assert.match(problemWithMirror({ ...good, blocks: good.blocks.slice(0, 3) }), /4 parts of the day/);
	assert.match(problemWithMirror({ ...good, blocks: [...good.blocks].reverse() }), /in that order/);
	assert.match(problemWithMirror({ ...good, blocks: blocksAt("05:00", "11:00", "noon", "22:00") }), /Evening needs a start time/);
	assert.match(problemWithMirror({ ...good, blocks: blocksAt("05:00", "11:00", "11:00", "22:00") }), /after the one before/);
});

test("ProfileStore reads a version 1 file and moves switched-on quiet hours to the mirror", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "household-"));
	const file = path.join(directory, "profiles.json");
	const old = {
		version: 1,
		people: {
			sam: { theme: "light", blocks: { day: { clock: false } }, quietHours: { enabled: false, from: "21:00", to: "05:00" } },
			heather: { blocks: {}, quietHours: { enabled: true, from: "22:30", to: "06:30" } }
		}
	};
	fs.writeFileSync(file, JSON.stringify(old));
	const store = new ProfileStore(file);
	assert.deepEqual(store.getMirror().quietHours, { enabled: true, from: "22:30", to: "06:30" });
	assert.deepEqual(store.getMirror().blocks, DEFAULT_BLOCKS);
	assert.equal(store.get("sam", FEATURES, DEFAULT_BLOCKS).theme, "light");
	assert.equal(store.get("sam", FEATURES, DEFAULT_BLOCKS).blocks.day.clock, false);

	// Saving writes version 2, and the mirror's settings survive a reload.
	store.setMirror({ quietHours: { enabled: true, from: "23:15", to: "06:00" }, blocks: blocksAt("06:00", "11:00", "17:00", "22:00") });
	const written = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(written.version, 2);
	const reloaded = new ProfileStore(file);
	assert.equal(reloaded.getMirror().quietHours.from, "23:15");
	assert.equal(reloaded.getMirror().blocks[0].from, "06:00");
	assert.equal(reloaded.get("sam", FEATURES, DEFAULT_BLOCKS).theme, "light");
	fs.rmSync(directory, { recursive: true });
});

test("a version 1 file with no quiet hours switched on leaves the mirror's off", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "household-"));
	const file = path.join(directory, "profiles.json");
	fs.writeFileSync(file, JSON.stringify({ version: 1, people: { heather: { blocks: {}, quietHours: { enabled: false, from: "23:00", to: "06:00" } } } }));
	assert.equal(new ProfileStore(file).getMirror().quietHours.enabled, false);
	fs.rmSync(directory, { recursive: true });
});

test("a profile carries how the mirror speaks to that person", () => {
	const fresh = normalize(undefined, FEATURES, DEFAULT_BLOCKS);
	assert.deepEqual(fresh.speech, { voice: "", volume: 100, speak: true });
	const kept = normalize({ speech: { voice: "julia", volume: 40, speak: false } }, FEATURES, DEFAULT_BLOCKS);
	assert.deepEqual(kept.speech, { voice: "julia", volume: 40, speak: false });
	// Stored nonsense falls back field by field.
	const mended = normalize({ speech: { voice: "Not An Id!", volume: 250, speak: "yes" } }, FEATURES, DEFAULT_BLOCKS);
	assert.deepEqual(mended.speech, { voice: "", volume: 100, speak: true });
});

test("problemWith checks a submitted voice against the voices on offer", () => {
	const voices = ["julia", "katie"];
	const speech = (changes) => ({ blocks: {}, speech: { voice: "julia", volume: 80, speak: true, ...changes } });
	assert.equal(problemWith(speech({}), FEATURES, DEFAULT_BLOCKS, voices), null);
	assert.equal(problemWith(speech({ voice: "" }), FEATURES, DEFAULT_BLOCKS, voices), null);
	assert.match(problemWith(speech({ voice: "romeo" }), FEATURES, DEFAULT_BLOCKS, voices), /voices on offer/);
	assert.match(problemWith(speech({ volume: 101 }), FEATURES, DEFAULT_BLOCKS, voices), /0 to 100/);
	assert.match(problemWith(speech({ volume: 12.5 }), FEATURES, DEFAULT_BLOCKS, voices), /whole number/);
	assert.match(problemWith(speech({ speak: "no" }), FEATURES, DEFAULT_BLOCKS, voices), /true or false/);
	assert.match(problemWith({ blocks: {}, speech: "loud" }, FEATURES, DEFAULT_BLOCKS, voices), /must be an object/);
	// A page from before voices existed sends no speech at all.
	assert.equal(problemWith({ blocks: {} }, FEATURES, DEFAULT_BLOCKS, voices), null);
});

test("the mirror has a voice of its own for guests", () => {
	assert.equal(defaultMirror().voice, "");
	assert.equal(normalizeMirror({ voice: "katie" }).voice, "katie");
	assert.equal(normalizeMirror({ voice: 7 }).voice, "");
	const good = { ...defaultMirror(), voice: "katie" };
	assert.equal(problemWithMirror(good, ["katie"]), null);
	assert.match(problemWithMirror({ ...good, voice: "romeo" }, ["katie"]), /voices on offer/);
	// Without a voice in the request the rest is still checked as before.
	const { voice, ...older } = good;
	assert.equal(voice, "katie");
	assert.equal(problemWithMirror(older, ["katie"]), null);
});

test("viewFor says how to speak: the person's own voice, or the mirror's", () => {
	const chosen = profileOf({ speech: { voice: "julia", volume: 60, speak: true } });
	assert.deepEqual(viewFor(state({ profile: chosen, mirrorVoice: "katie" }), at("12:00")).speech, { voice: "julia", volume: 60, speak: true });
	// No choice of their own: the mirror's voice, at their volume.
	const unchosen = profileOf({ speech: { voice: "", volume: 30, speak: false } });
	assert.deepEqual(viewFor(state({ profile: unchosen, mirrorVoice: "katie" }), at("12:00")).speech, { voice: "katie", volume: 30, speak: false });
	// A guest, nobody at all, and a person in quiet hours get the mirror's voice.
	const guest = viewFor({ person: "guest", unknown: false, profile: null, blocks: DEFAULT_BLOCKS, mirrorVoice: "katie" }, at("12:00"));
	assert.deepEqual(guest.speech, { voice: "katie", volume: 100, speak: true });
	assert.deepEqual(viewFor({ person: null, unknown: false, profile: null, blocks: DEFAULT_BLOCKS }, at("12:00")).speech, { voice: "", volume: 100, speak: true });
	assert.deepEqual(viewFor(state({ profile: chosen, mirrorVoice: "katie", quietHours: QUIET }), at("23:30")).speech, { voice: "katie", volume: 100, speak: true });
});

test("the mirror has a name, a wake phrase and room for one on trial", () => {
	const mirror = defaultMirror();
	assert.deepEqual([mirror.name, mirror.wakePhrase, mirror.wakeCandidate], ["Mirror", "mirror", ""]);
	const stored = normalizeMirror({ name: "  Looking Glass ", wakePhrase: "hey mirror", wakeCandidate: "magic mirror" });
	assert.deepEqual([stored.name, stored.wakePhrase, stored.wakeCandidate], ["Looking Glass", "hey mirror", "magic mirror"]);
	// Stored nonsense falls back, and a candidate equal to the phrase is no candidate.
	const mended = normalizeMirror({ name: "<b>", wakePhrase: "Hey Mirror!", wakeCandidate: "mirror" });
	assert.deepEqual([mended.name, mended.wakePhrase, mended.wakeCandidate], ["Mirror", "mirror", ""]);
	assert.equal(normalizeMirror({ name: "x".repeat(25) }).name, "Mirror");
});

test("problemWithMirror checks a submitted name and candidate phrase", () => {
	const good = { ...defaultMirror(), name: "Glass", wakeCandidate: "hey mirror" };
	assert.equal(problemWithMirror(good), null);
	assert.equal(problemWithMirror({ ...good, wakeCandidate: "" }), null);
	assert.match(problemWithMirror({ ...good, name: "" }), /1 to 24 characters/);
	assert.match(problemWithMirror({ ...good, name: "a<script>" }), /1 to 24 characters/);
	assert.match(problemWithMirror({ ...good, wakeCandidate: "Hey Mirror" }), /plain words/);
	assert.match(problemWithMirror({ ...good, wakeCandidate: 7 }), /plain words/);
});

test("the mirror keeps a valid screen direction and drops anything else", () => {
	assert.equal(defaultMirror().rotation, "");
	assert.equal(normalizeMirror({ rotation: "270" }).rotation, "270");
	assert.equal(normalizeMirror({ rotation: "sideways" }).rotation, "");
	assert.equal(normalizeMirror({ rotation: 90 }).rotation, "");
	const good = defaultMirror();
	assert.equal(problemWithMirror({ ...good, rotation: "normal" }), null);
	assert.match(problemWithMirror({ ...good, rotation: "output * disable" }), /rotation must be one of/);
});

test("show only: the view names the one feature for a person or a woken guest, and for nobody else", () => {
	const noon = new Date(2026, 10, 23, 12, 0);
	const forSam = viewFor({ person: "sam", profile: null, blocks: DEFAULT_BLOCKS, focus: "calendar" }, noon);
	assert.equal(forSam.focus, "calendar");
	const guest = viewFor({ person: null, profile: null, blocks: DEFAULT_BLOCKS, wakeUntil: noon.getTime() + 60000, focus: "weather" }, noon);
	assert.equal(guest.person, "guest");
	assert.equal(guest.focus, "weather");
	const nobody = viewFor({ person: null, profile: null, blocks: DEFAULT_BLOCKS, focus: "weather" }, noon);
	assert.equal(nobody.focus, undefined);
	const asleep = viewFor({ person: "sam", profile: null, blocks: DEFAULT_BLOCKS, asleep: "sam", focus: "calendar" }, noon);
	assert.equal(asleep.focus, undefined);
	assert.equal(viewFor({ person: "sam", profile: null, blocks: DEFAULT_BLOCKS }, noon).focus, undefined);
});

test("show only is for shared features and a person's own", () => {
	const features = [{ key: "weather", label: "Weather now", owners: [] }, { key: "art", label: "Art", owners: ["heather"] }, { key: "calendar", label: "Calendar", owners: ["sam", "heather"] }];
	assert.equal(canFocus(features, "weather", "sam"), true);
	assert.equal(canFocus(features, "weather", null), true);
	assert.equal(canFocus(features, "art", "heather"), true);
	assert.equal(canFocus(features, "art", "sam"), false);
	assert.equal(canFocus(features, "calendar", null), false);
	assert.equal(canFocus(features, "moon", "sam"), false);
	assert.equal(canFocus(undefined, "weather", "sam"), false);
});

test("the mirror turns its screen on at its name unless that is switched off", () => {
	assert.equal(defaultMirror().wakeScreen, true);
	assert.equal(normalizeMirror({ wakeScreen: false }).wakeScreen, false);
	assert.equal(normalizeMirror({ wakeScreen: "no" }).wakeScreen, true);
	assert.equal(problemWithMirror({ ...defaultMirror(), wakeScreen: false }), null);
	assert.match(problemWithMirror({ ...defaultMirror(), wakeScreen: "no" }), /wakeScreen/);
});
