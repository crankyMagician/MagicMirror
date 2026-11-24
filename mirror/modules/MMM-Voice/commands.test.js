// Run with: node --test "mirror/modules/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildCommands, chimeWav } = require("./commands");

test("every phrase starts with the wake word", () => {
	const commands = buildCommands({ wakeWord: "Mirror", commands: { good_night: ["good night"] }, features: { news: "newsfeed" } });
	const phrases = commands.flatMap((command) => command.phrases);
	assert.ok(phrases.length > 0);
	assert.ok(phrases.every((phrase) => phrase.startsWith("mirror ")));
});

test("each feature gets show, hide and show only commands, with and without the", () => {
	const commands = buildCommands({ wakeWord: "mirror", commands: {}, features: { "air quality": "MMM-AirQuality" } });
	assert.deepEqual(commands, [
		{ id: "show:MMM-AirQuality", phrases: ["mirror show air quality", "mirror show the air quality"] },
		{ id: "hide:MMM-AirQuality", phrases: ["mirror hide air quality", "mirror hide the air quality"] },
		{ id: "only:MMM-AirQuality", phrases: ["mirror show only air quality", "mirror show only the air quality", "mirror just the air quality"] }
	]);
});

test("the chime is a valid short WAV file", () => {
	const wav = chimeWav(22050);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 12), "WAVE");
	assert.equal(wav.readUInt32LE(24), 22050);
	assert.equal(wav.readUInt32LE(40), wav.length - 44);
	assert.ok(wav.length < 22050 * 2);
});

test("with several wake phrases every command answers to each of them", () => {
	const commands = buildCommands({ wakeWord: "mirror", wakeWords: ["mirror", "hey mirror"], commands: { good_night: ["good night"] }, features: { news: "newsfeed" } });
	assert.deepEqual(commands.find((command) => command.id === "good_night").phrases, ["mirror good night", "hey mirror good night"]);
	assert.deepEqual(commands.find((command) => command.id === "show:newsfeed").phrases, ["mirror show news", "hey mirror show news", "mirror show the news", "hey mirror show the news"]);
	// An empty list falls back to the one wake word.
	assert.deepEqual(buildCommands({ wakeWord: "mirror", wakeWords: [], commands: { wake_up: ["wake up"] } })[0].phrases, ["mirror wake up"]);
});

test("no two commands share a phrase", () => {
	const commands = buildCommands({ wakeWord: "mirror", commands: { show_all: ["go back", "show everything"] }, features: { calendar: "calendar", "work calendar": "work-calendar", weather: "weather" } });
	const phrases = commands.flatMap((command) => command.phrases);
	assert.equal(new Set(phrases).size, phrases.length);
});

test("each light gets on, off and level commands that name the state they want", () => {
	const commands = buildCommands({ wakeWord: "mirror", commands: {}, features: {}, lights: { "bedroom lights": "bedroom" }, lightLevels: { "fifty percent": 50 } });
	assert.deepEqual(commands, [
		{ id: "light:on:bedroom", phrases: ["mirror turn on the bedroom lights", "mirror bedroom lights on"] },
		{ id: "light:off:bedroom", phrases: ["mirror turn off the bedroom lights", "mirror bedroom lights off"] },
		{ id: "light:level:bedroom:50", phrases: ["mirror set the bedroom lights to fifty percent", "mirror bedroom lights to fifty percent"] }
	]);
	assert.equal(commands.some((command) => (/toggle/).test(command.id)), false);
});

test("a scene's name is its command, and lights add no phrase that another command has", () => {
	const commands = buildCommands({
		wakeWord: "mirror",
		commands: { good_night: ["good night"] },
		features: { lights: "lights" },
		lights: { "bedroom lights": "bedroom", "kitchen lights": "kitchen" },
		scenes: { "bedroom evening": "bedroom_evening" }
	});
	assert.deepEqual(commands.find((command) => command.id === "light:scene:bedroom_evening").phrases, ["mirror bedroom evening"]);
	// Five levels by default.
	assert.equal(commands.filter((command) => command.id.startsWith("light:level:kitchen:")).length, 5);
	const phrases = commands.flatMap((command) => command.phrases);
	assert.equal(new Set(phrases).size, phrases.length);
});
