const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ROTATIONS, currentRotation, swayArguments, validRotation } = require("./rotation");

test("the four directions and the empty choice are valid, and nothing else is", () => {
	for (const value of ["", "90", "270", "normal", "180"]) {
		assert.equal(validRotation(value), true, value);
	}
	for (const value of ["45", "flipped", 90, null, undefined, "90; exit", "normal "]) {
		assert.equal(validRotation(value), false, String(value));
	}
	assert.equal(ROTATIONS.length, 4);
});

test("swayArguments turns every output and refuses anything that is not a direction", () => {
	assert.deepEqual(swayArguments("270"), ["output", "*", "transform", "270"]);
	assert.throws(() => swayArguments(""), /not a direction/);
	assert.throws(() => swayArguments("normal; reboot"), /not a direction/);
});

test("currentRotation reads the output that is switched on", () => {
	const outputs = [{ name: "HDMI-A-1", active: false, transform: null }, { name: "HDMI-A-2", active: true, transform: "270" }];
	assert.equal(currentRotation(JSON.stringify(outputs)), "270");
});

test("currentRotation gives nothing for a dark screen, a mirrored picture or an answer that is not JSON", () => {
	assert.equal(currentRotation(JSON.stringify([{ name: "HDMI-A-2", active: false, transform: null }])), "");
	assert.equal(currentRotation(JSON.stringify([{ name: "HDMI-A-2", active: true, transform: "flipped-90" }])), "");
	assert.equal(currentRotation("Error: no sway"), "");
	assert.equal(currentRotation("{}"), "");
});
