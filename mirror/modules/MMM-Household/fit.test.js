const assert = require("node:assert/strict");
const { test } = require("node:test");
const { center, pack } = require("./fit");

const item = (id, height, pinned = false) => ({ id, height, pinned });

test("a column with room shows everything and has no turns", () => {
	const result = pack({ items: [item("clock", 100, true), item("calendar", 300), item("tasks", 200)], available: 700 });
	assert.deepEqual(result.shown, ["clock", "calendar", "tasks"]);
	assert.deepEqual(result.waiting, []);
	assert.equal(result.next, 0);
});

test("what is shown never adds up to more than the column holds", () => {
	const items = [item("a", 400), item("b", 300), item("c", 350), item("d", 120), item("e", 500)];
	for (let start = 0; start < items.length; start++) {
		const { shown } = pack({ items, available: 900, start });
		const total = items.filter((entry) => shown.includes(entry.id)).reduce((sum, entry) => sum + entry.height, 0);
		assert.ok(total <= 900, `turn ${start} holds ${total}`);
		assert.ok(shown.length > 0);
	}
});

test("a module that does not fit waits and leads the next turn", () => {
	const items = [item("network", 600), item("photo", 300), item("pokemon", 250)];
	const first = pack({ items, available: 900, start: 0 });
	assert.deepEqual(first.shown, ["network", "photo"]);
	assert.deepEqual(first.waiting, ["pokemon"]);
	assert.equal(first.next, 2);
	const second = pack({ items, available: 900, start: first.next });
	assert.deepEqual(second.shown, ["network", "pokemon"]);
	assert.deepEqual(second.waiting, ["photo"]);
});

test("every module gets a turn", () => {
	const items = [item("a", 500), item("b", 500), item("c", 500), item("d", 500), item("e", 500)];
	const seen = new Set();
	let start = 0;
	for (let turn = 0; turn < items.length; turn++) {
		const result = pack({ items, available: 1000, start });
		result.shown.forEach((id) => seen.add(id));
		start = result.next;
	}
	assert.deepEqual([...seen].sort(), ["a", "b", "c", "d", "e"]);
});

test("a smaller module further down fills the room a larger one could not use", () => {
	const result = pack({ items: [item("a", 500), item("b", 600), item("c", 200)], available: 800, start: 0 });
	assert.deepEqual(result.shown, ["a", "c"]);
	assert.equal(result.next, 1);
});

test("pinned modules are in every turn and keep the display order", () => {
	const items = [item("clock", 100, true), item("a", 400), item("calendar", 300, true), item("b", 400)];
	const first = pack({ items, available: 800, start: 0 });
	assert.deepEqual(first.shown, ["clock", "a", "calendar"]);
	const second = pack({ items, available: 800, start: first.next });
	assert.deepEqual(second.shown, ["clock", "calendar", "b"]);
});

test("a module taller than the column shows alone, on its turn", () => {
	const items = [item("tall", 2000), item("small", 100)];
	const first = pack({ items, available: 900, start: 0 });
	assert.deepEqual(first.shown, ["tall"]);
	const second = pack({ items, available: 900, start: first.next });
	assert.deepEqual(second.shown, ["small"]);
});

test("pinned modules that fill the column leave the others waiting", () => {
	const result = pack({ items: [item("clock", 500, true), item("calendar", 500, true), item("a", 100)], available: 1000 });
	assert.deepEqual(result.shown, ["clock", "calendar"]);
	assert.deepEqual(result.waiting, ["a"]);
});

test("an empty column and a start past the end are fine", () => {
	assert.deepEqual(pack({ items: [], available: 500, start: 3 }), { shown: [], waiting: [], next: 0 });
	const result = pack({ items: [item("a", 100), item("b", 100)], available: 500, start: 7 });
	assert.deepEqual(result.shown, ["a", "b"]);
});

test("a module shown alone moves to the middle of the screen and grows", () => {
	const screen = { width: 1080, height: 1920 };
	// A column module near the top left.
	const move = center({ left: 60, top: 300, width: 465, height: 250 }, screen);
	assert.equal(move.scale, 1.8);
	// The box's center, at 292.5 and 425, lands on the screen's, at 540 and 960.
	assert.equal(move.x, Math.round(540 - 292.5));
	assert.equal(move.y, 960 - 425);
});

test("a module shown alone never grows past the screen", () => {
	const screen = { width: 1080, height: 1920 };
	const wide = center({ left: 60, top: 1700, width: 960, height: 120 }, screen);
	assert.ok(wide.scale * 960 <= 1080 * 0.9 + 1);
	const tall = center({ left: 555, top: 200, width: 465, height: 1500 }, screen);
	assert.ok(tall.scale * 1500 <= 1920 * 0.8 + 2);
	assert.ok(tall.scale > 1);
	// A box bigger than the screen shrinks to fit.
	assert.ok(center({ left: 0, top: 0, width: 1200, height: 2400 }, screen).scale < 1);
	// An empty box stays where it is.
	assert.deepEqual(center({ left: 10, top: 10, width: 0, height: 0 }, screen), { x: 0, y: 0, scale: 1 });
});
