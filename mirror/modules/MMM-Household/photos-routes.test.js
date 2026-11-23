// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { durationMs, fileNameFor, photosIn } = require("./photos-routes");

test("durationMs reads Google's seconds format and stays within bounds", () => {
	assert.equal(durationMs("5s", 9000), 5000);
	assert.equal(durationMs("1.5s", 9000), 1500);
	assert.equal(durationMs("0.2s", 9000), 1000);
	assert.equal(durationMs("600s", 9000), 60000);
	assert.equal(durationMs(undefined, 9000), 9000);
	assert.equal(durationMs("soon", 9000), 9000);
});

test("fileNameFor is stable, safe and different per photo", () => {
	const name = fileNameFor("AF1Qip/../../etc/passwd");
	assert.match(name, /^[0-9a-f]{24}\.jpg$/);
	assert.equal(name, fileNameFor("AF1Qip/../../etc/passwd"));
	assert.notEqual(name, fileNameFor("another-id"));
});

test("photosIn keeps photos with a download address and drops the rest", () => {
	const items = [
		{ id: "a", type: "PHOTO", mediaFile: { baseUrl: "https://lh3.example/a" } },
		{ id: "b", type: "VIDEO", mediaFile: { baseUrl: "https://lh3.example/b" } },
		{ id: "c", type: "PHOTO", mediaFile: {} },
		null
	];
	assert.deepEqual(photosIn(items), [{ id: "a", baseUrl: "https://lh3.example/a" }]);
	assert.deepEqual(photosIn(undefined), []);
});
