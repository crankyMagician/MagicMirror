// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DEFAULTS, decide, player } = require("./radio");

test("the radio plays when the switch is on and the mirror is not speaking", () => {
	assert.equal(decide({ on: true, speaking: false, playing: false }), "play");
	assert.equal(decide({ on: true, speaking: false, playing: true }), null);
	assert.equal(decide({ on: false, speaking: false, playing: true }), "stop");
	assert.equal(decide({ on: false, speaking: false, playing: false }), null);
});

test("the radio gives the speaker to the mirror's voice and takes it back", () => {
	assert.equal(decide({ on: true, speaking: true, playing: true }), "stop");
	assert.equal(decide({ on: true, speaking: true, playing: false }), null);
	assert.equal(decide({ on: true, speaking: false, playing: false }), "play");
	assert.equal(decide({ on: false, speaking: true, playing: false }), null);
});

test("the player reads the stream and writes to the speaker at a bounded volume", () => {
	const { command, args } = player({ ...DEFAULTS, stream: "https://example.org/radio", volume: 0.4 });
	assert.equal(command, "ffmpeg");
	assert.equal(args[args.indexOf("-i") + 1], "https://example.org/radio");
	assert.equal(args.at(-1), "plughw:CARD=Device");
	assert.ok(args.includes("volume=0.4"));
	assert.ok(args.includes("-nostdin"));
	assert.ok(player({ ...DEFAULTS, stream: "x", volume: 7 }).args.includes("volume=1"));
	assert.ok(player({ ...DEFAULTS, stream: "x", volume: "loud" }).args.includes("volume=0"));
});
