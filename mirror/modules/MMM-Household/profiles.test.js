/* Run with: node --test mirror/modules/MMM-Household/ */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_BLOCKS, ProfileStore, currentBlock, inRange, normalize, problemWith } = require("./profiles");

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
