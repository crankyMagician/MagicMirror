// Run with: node --test "mirror/modules/**/*.test.js"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_BLOCKS, ProfileStore, currentBlock, inRange, normalize, problemWith, viewFor } = require("./profiles");

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
	assert.equal(profile.quietHours.enabled, false);
});

test("normalize keeps stored choices and drops what it does not know", () => {
	const stored = { blocks: { night: { newsfeed: false, removed: false }, brunch: { clock: false } }, quietHours: { enabled: true, from: "22:30", to: "nonsense" } };
	const profile = normalize(stored, FEATURES, DEFAULT_BLOCKS);
	assert.equal(profile.blocks.night.newsfeed, false);
	assert.equal(profile.blocks.night.clock, true);
	assert.equal("removed" in profile.blocks.night, false);
	assert.equal("brunch" in profile.blocks, false);
	assert.deepEqual(profile.quietHours, { enabled: true, from: "22:30", to: "06:00" });
});

test("problemWith accepts a complete profile", () => {
	assert.equal(problemWith(normalize(undefined, FEATURES, DEFAULT_BLOCKS), FEATURES, DEFAULT_BLOCKS), null);
});

test("problemWith refuses unknown names and wrong types", () => {
	assert.match(problemWith({ blocks: { brunch: {} } }, FEATURES, DEFAULT_BLOCKS), /Unknown block/);
	assert.match(problemWith({ blocks: { day: { stocks: true } } }, FEATURES, DEFAULT_BLOCKS), /Unknown feature/);
	assert.match(problemWith({ blocks: { day: { clock: "yes" } } }, FEATURES, DEFAULT_BLOCKS), /true or false/);
	assert.match(problemWith({ blocks: {}, quietHours: { enabled: true, from: "25:00", to: "06:00" } }, FEATURES, DEFAULT_BLOCKS), /must be a time/);
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

test("viewFor treats a person in quiet hours as absent", () => {
	const quiet = profileOf({ quietHours: { enabled: true, from: "23:00", to: "06:00" } });
	const view = viewFor(state({ profile: quiet }), at("23:30"));
	assert.equal(view.person, null);
	assert.equal(view.quiet, true);
});

test("a spoken wake up overrides quiet hours", () => {
	const quiet = profileOf({ quietHours: { enabled: true, from: "23:00", to: "06:00" } });
	const now = at("23:30");
	const view = viewFor(state({ profile: quiet, wakeUntil: now.getTime() + 60000 }), now);
	assert.equal(view.person, "heather");
	assert.equal(view.quiet, false);
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
	const profile = normalize({ theme: "light", quietHours: { enabled: true, from: "23:00", to: "06:00" } }, FEATURES, DEFAULT_BLOCKS);
	assert.equal(viewFor({ person: "heather", profile, blocks: DEFAULT_BLOCKS }, at("12:00")).theme, "light");
	assert.equal(viewFor({ person: "heather", profile, blocks: DEFAULT_BLOCKS }, at("23:30")).theme, "dark");
	assert.equal(viewFor({ person: "guest", profile: null, blocks: DEFAULT_BLOCKS }, at("12:00")).theme, "dark");
	assert.equal(viewFor({ person: "sam", profile: normalize({}, FEATURES, DEFAULT_BLOCKS), blocks: DEFAULT_BLOCKS }, at("12:00")).theme, "dark");
});
