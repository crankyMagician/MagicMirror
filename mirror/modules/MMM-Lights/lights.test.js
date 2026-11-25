// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { answer, describe, parse, reached, repeatGuard, summarize } = require("./lights");

const CONFIG = {
	lights: { bedroom: { label: "Bedroom", say: "bedroom lights", entity: "light.master_bedroom_lights" } },
	scenes: { bedroom_evening: { say: "bedroom evening", entity: "scene.bedroom_evening" } }
};
const light = (on, level = null, available = true) => ({ available, on, level });

test("a command names the state it wants for a light the config lists", () => {
	assert.deepEqual(parse("light:on:bedroom", CONFIG), { kind: "on", key: "bedroom", target: CONFIG.lights.bedroom, want: { on: true } });
	assert.deepEqual(parse("light:off:bedroom", CONFIG).want, { on: false });
	assert.deepEqual(parse("light:level:bedroom:50", CONFIG).want, { on: true, level: 50 });
	assert.deepEqual(parse("light:scene:bedroom_evening", CONFIG), { kind: "scene", key: "bedroom_evening", target: CONFIG.scenes.bedroom_evening, want: null });
});

test("anything the config does not list is refused", () => {
	for (const id of ["light:on:garage", "light:scene:bedroom", "light:toggle:bedroom", "light:level:bedroom:0", "light:level:bedroom:150", "light:level:bedroom:x", "light:on:bedroom:extra", "light:on:__proto__", "good_night", "show:lights", ""]) {
		assert.equal(parse(id, CONFIG), null, id);
	}
	assert.equal(parse("light:on:bedroom"), null);
});

test("a light has reached a state when it reports it, within a few percent for a level", () => {
	assert.equal(reached(light(true, 80), { on: true }), true);
	assert.equal(reached(light(false), { on: true }), false);
	assert.equal(reached(light(false), { on: false }), true);
	assert.equal(reached(light(true, 49), { on: true, level: 50 }), true);
	assert.equal(reached(light(true, 80), { on: true, level: 50 }), false);
	assert.equal(reached(light(true, null), { on: true, level: 50 }), false);
	// A bulb that is off at the wall has reached nothing, not even "off".
	assert.equal(reached(light(false, null, false), { on: false }), false);
});

test("the card says what a group is doing", () => {
	assert.deepEqual(describe(summarize([light(true, 40), light(true, 42)])), { status: "On 41%", tone: "on" });
	assert.deepEqual(describe(summarize([light(false), light(false)])), { status: "Off", tone: "off" });
	assert.deepEqual(describe(summarize([light(true, 100), light(false)])), { status: "1 of 2 on 100%", tone: "on" });
	// One bulb off at the wall: the group is what the answering bulb does.
	assert.deepEqual(describe(summarize([light(true, 60), light(false, null, false)])), { status: "On 60%", tone: "on" });
	assert.deepEqual(describe(summarize([light(false, null, false)])), { status: "Not answering", tone: "missing" });
	assert.deepEqual(describe(null), { status: "Not answering", tone: "missing" });
	assert.deepEqual(describe(summarize([light(true)])), { status: "On", tone: "on" });
});

test("the answer reports what the lights did, not what was asked", () => {
	const on = parse("light:on:bedroom", CONFIG);
	assert.equal(answer(on, { total: 2, reached: 2 }), "Bedroom lights on.");
	assert.equal(answer(parse("light:off:bedroom", CONFIG), { total: 2, reached: 2 }), "Bedroom lights off.");
	assert.equal(answer(parse("light:level:bedroom:50", CONFIG), { total: 2, reached: 2 }), "Bedroom lights at 50 percent.");
	assert.equal(answer(parse("light:scene:bedroom_evening", CONFIG), { total: 2, reached: 2 }), "Bedroom evening is set.");
	const christmas = { kind: "scene", key: "christmas", target: { say: "christmas lights", entity: "script.christmas_lights_on", done: "Christmas lights are on." }, want: null };
	assert.equal(answer(christmas, { total: 21, reached: 21 }), "Christmas lights are on.");
	assert.equal(answer(christmas, { total: 21, reached: 19 }), "Christmas lights: 19 of 21 answered.");
	const quiet = { ...christmas, target: { ...christmas.target, quiet: true } };
	assert.equal(answer(quiet, { total: 21, reached: 21 }), "");
	assert.equal(answer(quiet, { total: 21, reached: 19 }), "Christmas lights: 19 of 21 answered.");
	assert.equal(answer(quiet, { error: "unreachable" }), "I could not reach the house controls.");
	assert.equal(answer(on, { total: 2, reached: 1 }), "Bedroom lights: 1 of 2 answered.");
	assert.equal(answer(on, { total: 2, reached: 0 }), "Bedroom lights did not answer.");
	assert.equal(answer(on, { error: "unreachable" }), "I could not reach the house controls.");
	assert.equal(answer(on, { error: "unknown" }), "The house controls do not know bedroom lights.");
});

test("a command heard twice in a few seconds counts once", () => {
	let time = 0;
	const repeated = repeatGuard(4, () => time);
	assert.equal(repeated("light:on:bedroom"), false);
	time = 1500;
	assert.equal(repeated("light:on:bedroom"), true);
	assert.equal(repeated("light:off:bedroom"), false);
	time = 9000;
	assert.equal(repeated("light:on:bedroom"), false);
});
