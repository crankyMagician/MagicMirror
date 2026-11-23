// Run with: node --test "mirror/modules/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { dueLabel, localDay, pickTasks } = require("./tasks");

const now = new Date(2026, 10, 22, 21, 30); // Sunday evening, local time
const due = (day) => `${day}T00:00:00.000Z`;

test("localDay uses the mirror's own calendar date", () => {
	assert.equal(localDay(now), "2026-11-22");
});

test("dueLabel names days relative to today", () => {
	assert.deepEqual(dueLabel(due("2026-11-20"), now), { text: "Overdue", state: "overdue" });
	assert.deepEqual(dueLabel(due("2026-11-22"), now), { text: "Today", state: "today" });
	assert.deepEqual(dueLabel(due("2026-11-23"), now), { text: "Tomorrow", state: "soon" });
	assert.deepEqual(dueLabel(due("2026-11-26"), now), { text: "Thursday", state: "soon" });
	assert.deepEqual(dueLabel(due("2026-12-25"), now), { text: "Dec 25", state: "later" });
	assert.deepEqual(dueLabel(undefined, now), { text: "", state: "none" });
});

test("a task due today is still today late in the evening", () => {
	assert.equal(dueLabel(due("2026-11-22"), new Date(2026, 10, 22, 23, 59)).state, "today");
	assert.equal(dueLabel(due("2026-11-22"), new Date(2026, 10, 23, 0, 1)).state, "overdue");
});

test("pickTasks puts dated tasks first, by date, then the rest in list order", () => {
	const lists = [
		{ title: "Home",
			tasks: [
				{ title: "Water plants", position: "0002" },
				{ title: "Call the plumber", position: "0001", due: due("2026-11-25") }
			] },
		{ title: "Work",
			tasks: [
				{ title: "Send invoice", position: "0001", due: due("2026-11-23") },
				{ title: "Tidy inbox", position: "0002" }
			] }
	];
	assert.deepEqual(pickTasks(lists, 10).map((task) => task.title), ["Send invoice", "Call the plumber", "Water plants", "Tidy inbox"]);
	assert.equal(pickTasks(lists, 10)[0].list, "Work");
});

test("pickTasks leaves out completed tasks, subtasks and blank titles, and respects the limit", () => {
	const lists = [
		{ title: "Home",
			tasks: [
				{ title: "Done already", status: "completed", position: "0001" },
				{ title: "A subtask", parent: "abc", position: "0002" },
				{ title: "   ", position: "0003" },
				{ title: "One", position: "0004" },
				{ title: "Two", position: "0005" },
				{ title: "Three", position: "0006" }
			] }
	];
	assert.deepEqual(pickTasks(lists, 2).map((task) => task.title), ["One", "Two"]);
});
