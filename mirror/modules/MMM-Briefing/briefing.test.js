// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { briefing, nextLine, partOfDay, skyWord, specialFor, spokenTime, tasksLine, todayLine, upcoming, weatherLine, whenWords } = require("./briefing");

// A Monday morning, local time.
const now = new Date(2026, 10, 23, 8, 15);
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const timed = (title, day, hour, minute = 0, lengthMinutes = 60) => ({ title, startDate: at(day, hour, minute), endDate: at(day, hour, minute) + lengthMinutes * 60000, fullDayEvent: false });
const allDay = (title, day) => ({ title, startDate: at(day, 0), endDate: at(day + 1, 0), fullDayEvent: true });

test("skyWord drops the day or night prefix and knows common skies", () => {
	assert.equal(skyWord("day-sunny"), "sunny");
	assert.equal(skyWord("night-clear"), "clear");
	assert.equal(skyWord("rain"), "rainy");
	assert.equal(skyWord("something-new"), "");
	assert.equal(skyWord(undefined), "");
});

test("weatherLine says the temperature, the range and a real chance of rain", () => {
	assert.equal(weatherLine({ temperature: 63.6, weatherType: "day-sunny" }, { maxTemperature: 71.2, minTemperature: 47.8, precipitationProbability: 5 }),
		"It is 64 degrees and sunny. Today's high is 71 and the low is 48.");
	assert.equal(weatherLine({ temperature: 50, weatherType: "mystery" }, { maxTemperature: 55, minTemperature: 41, precipitationProbability: 60 }),
		"It is 50 degrees. Today's high is 55 and the low is 41. There is a 60 percent chance of rain.");
	assert.equal(weatherLine(null, null), "I do not have the weather yet.");
});

test("spokenTime reads like speech", () => {
	assert.equal(spokenTime(new Date(2026, 0, 1, 15, 0)), "3 PM");
	assert.equal(spokenTime(new Date(2026, 0, 1, 9, 30)), "9:30 AM");
	assert.equal(spokenTime(new Date(2026, 0, 1, 0, 5)), "12:05 AM");
	assert.equal(spokenTime(new Date(2026, 0, 1, 12, 0)), "12 PM");
});

test("whenWords names the day relative to now", () => {
	assert.equal(whenWords(timed("a", 23, 15), now), "today at 3 PM");
	assert.equal(whenWords(timed("a", 24, 9, 30), now), "tomorrow at 9:30 AM");
	assert.equal(whenWords(timed("a", 27, 9), now), "on Friday at 9 AM");
	assert.equal(whenWords(allDay("a", 24), now), "tomorrow");
	assert.match(whenWords(allDay("a", 30), now), /^on November 30$/);
});

test("upcoming drops ended events and repeats, and sorts by start", () => {
	const events = [timed("Later", 23, 15), timed("Done", 23, 6), timed("Soon", 23, 9), timed("Soon", 23, 9), null];
	assert.deepEqual(upcoming(events, now).map((event) => event.title), ["Soon", "Later"]);
});

test("nextLine names a running event and the next one", () => {
	assert.equal(nextLine([timed("Standup", 23, 8, 0), timed("Dentist", 23, 15)], now), "Standup is happening now. Next is Dentist, today at 3 PM.");
	assert.equal(nextLine([timed("Dentist", 24, 15)], now), "Next is Dentist, tomorrow at 3 PM.");
	assert.equal(nextLine([], now), "Nothing else is on your calendar.");
});

test("todayLine counts what is left today", () => {
	assert.equal(todayLine([timed("Dentist", 23, 15), timed("Dinner", 23, 19), timed("Tomorrow", 24, 9)], now), "You have 2 events left today. The first is Dentist at 3 PM.");
	assert.equal(todayLine([timed("Dentist", 23, 15)], now), "You have 1 event left today. It is Dentist at 3 PM.");
	assert.equal(todayLine([allDay("Anniversary", 23)], now), "You have 1 event left today. Anniversary is all day.");
	assert.equal(todayLine([timed("Tomorrow", 24, 9)], now), "Your calendar is clear for the rest of today.");
});

test("tasksLine counts open tasks and the ones due", () => {
	assert.equal(tasksLine([{ title: "a", due: "2026-11-23T00:00:00.000Z" }, { title: "b", due: "2026-11-20T00:00:00.000Z" }, { title: "c" }], now), "You have 3 open tasks, 2 due today or earlier.");
	assert.equal(tasksLine([{ title: "a", due: "2026-12-01T00:00:00.000Z" }], now), "You have 1 open task.");
	assert.equal(tasksLine([], now), "");
});

test("partOfDay follows the clock", () => {
	assert.equal(partOfDay(new Date(2026, 0, 1, 7)), "morning");
	assert.equal(partOfDay(new Date(2026, 0, 1, 13)), "afternoon");
	assert.equal(partOfDay(new Date(2026, 0, 1, 21)), "evening");
	assert.equal(partOfDay(new Date(2026, 0, 1, 2)), "evening");
});

test("briefing keeps calendars and tasks for a recognized person only", () => {
	const about = { current: { temperature: 64, weatherType: "day-sunny" }, today: { maxTemperature: 71, minTemperature: 48 }, events: [timed("Dentist", 23, 15)], tasks: [{ title: "a" }], now };
	assert.equal(briefing({ ...about, name: "Heather" }),
		"Good morning, Heather. It is 64 degrees and sunny. Today's high is 71 and the low is 48. You have 1 event left today. It is Dentist at 3 PM. You have 1 open task.");
	assert.equal(briefing({ ...about, name: "" }), "Good morning. It is 64 degrees and sunny. Today's high is 71 and the low is 48.");
});

test("specialFor matches the date and the person", () => {
	const christmas = new Date(2026, 11, 25, 7);
	const days = [
		{ date: "12-25", person: "heather", line: "Merry Christmas, Heather." },
		{ date: "2026-12-25", line: " Welcome, little one. " },
		{ date: "12-25", person: "sam", line: "Merry Christmas, Sam." },
		{ date: "2027-12-25", person: "heather", line: "Next year." },
		{ date: "12-25", person: "heather", line: "" }
	];
	assert.deepEqual(specialFor(days, "heather", christmas), [
		{ key: "2026-12-25.heather.0", line: "Merry Christmas, Heather." },
		{ key: "2026-12-25.heather.1", line: "Welcome, little one." }
	]);
	assert.deepEqual(specialFor(days, "heather", now), []);
	assert.deepEqual(specialFor("not a list", "heather", christmas), []);
});

test("specialFor counts the years of an anniversary", () => {
	const days = [{ date: "02-24", since: 2023, line: "Happy anniversary. {years} years married today." }];
	assert.deepEqual(specialFor(days, "sam", new Date(2027, 1, 24, 9)), [{ key: "2027-02-24.sam.0", line: "Happy anniversary. 4 years married today." }]);
	// Nothing to count in the year it happened.
	assert.deepEqual(specialFor(days, "sam", new Date(2023, 1, 24, 9)), []);
	// Without a starting year the placeholder is dropped.
	assert.deepEqual(specialFor([{ date: "02-24", line: "Happy {years} anniversary." }], "sam", new Date(2027, 1, 24, 9)), [{ key: "2027-02-24.sam.0", line: "Happy anniversary." }]);
});

test("specialFor says a season's lines in turn and counts the days left", () => {
	const days = [{ from: "11-25", to: "12-24", until: "12-25", lines: ["{days} until Christmas.", "Happy holidays. {days} to go."] }];
	const first = specialFor(days, "sam", new Date(2026, 10, 25, 8));
	const second = specialFor(days, "sam", new Date(2026, 10, 26, 8));
	assert.equal(first.length, 1);
	assert.equal(first[0].key, "2026-11-25.sam.0");
	assert.ok(first[0].line.includes("30 days"));
	assert.ok(second[0].line.includes("29 days"));
	assert.notEqual(first[0].line.replace("30", ""), second[0].line.replace("29", ""));
	assert.ok(specialFor(days, "heather", new Date(2026, 11, 24, 8))[0].line.includes("1 day "));
	// Outside the season, and on the day itself, it says nothing.
	assert.deepEqual(specialFor(days, "sam", new Date(2026, 10, 24, 8)), []);
	assert.deepEqual(specialFor(days, "sam", new Date(2026, 11, 25, 8)), []);
});

test("specialFor follows a season over the new year", () => {
	const days = [
		{ from: "12-26", to: "01-01", until: "01-01", line: "{days} left in the year." },
		{ from: "12-26", to: "01-01", person: "heather", line: "Happy holidays, Heather." }
	];
	assert.deepEqual(specialFor(days, "sam", new Date(2026, 11, 30, 8)), [{ key: "2026-12-30.sam.0", line: "2 days left in the year." }]);
	assert.deepEqual(specialFor(days, "heather", new Date(2027, 0, 1, 8)), [{ key: "2027-01-01.heather.1", line: "Happy holidays, Heather." }]);
	assert.deepEqual(specialFor(days, "sam", new Date(2027, 0, 2, 8)), []);
});
