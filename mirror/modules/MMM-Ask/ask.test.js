// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MODEL, SYSTEM, buildRequest, contextNote, dailyLimit, memory, readAnswer } = require("./ask");

test("a question goes to Haiku 5.5 at low effort with web search near Las Vegas", () => {
	const request = buildRequest({ question: "how tall is Mount Everest", context: { person: "Sam", time: "Thursday, November 26, 8:00 PM" } });
	assert.equal(request.model, MODEL);
	assert.equal(MODEL, "claude-haiku-5-5");
	assert.deepEqual(request.output_config, { effort: "low" });
	assert.equal(request.system, SYSTEM);
	assert.equal(request.tools[0].type, "web_search_20250305");
	assert.equal(request.tools[0].max_uses, 2);
	assert.equal(request.tools[0].user_location.city, "Las Vegas");
	assert.equal(request.messages.length, 1);
	assert.match(request.messages[0].content, /^how tall is Mount Everest\n\n<household>\nSam is at the mirror\.\nIt is Thursday/);
	// Nothing that changes per request is in the fixed part.
	assert.doesNotMatch(SYSTEM, /Sam|November/);
});

test("the note says who is there, the weather and the calendar", () => {
	const note = contextNote({ person: "Heather", assistant: "Mirror", weather: "It is 61 degrees and clear.", events: ["Dentist, tomorrow at 9 AM"] });
	assert.equal(note, "The mirror is called Mirror.\nHeather is at the mirror.\nWeather: It is 61 degrees and clear.\nHeather's calendar: Dentist, tomorrow at 9 AM.");
	assert.equal(contextNote({}), "Nobody the mirror knows is in view.");
});

test("an answer is read with the sites it cited, or else the sites it searched", () => {
	const cited = readAnswer({
		stop_reason: "end_turn",
		content: [
			{ type: "server_tool_use", name: "web_search" },
			{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://www.britannica.com/x" }, { url: "https://nasa.gov/y" }] },
			{ type: "text", text: "Mount Everest is about 29,032 feet ", citations: [{ url: "https://en.wikipedia.org/wiki/Everest" }] },
			{ type: "text", text: "tall." }
		]
	});
	assert.deepEqual(cited, { text: "Mount Everest is about 29,032 feet tall.", sources: ["en.wikipedia.org"], refused: false, paused: false });
	const searched = readAnswer({ stop_reason: "end_turn", content: [{ type: "web_search_tool_result", content: [{ url: "https://www.britannica.com/x" }, { url: "https://nasa.gov/y" }, { url: "https://c.org" }] }, { type: "text", text: "Yes." }] });
	assert.deepEqual(searched.sources, ["britannica.com", "nasa.gov"]);
});

test("a refusal and a paused turn are told apart", () => {
	assert.equal(readAnswer({ stop_reason: "refusal", content: [] }).refused, true);
	assert.equal(readAnswer({ stop_reason: "pause_turn", content: [] }).paused, true);
});

test("a conversation keeps three turns for two minutes, for one person", () => {
	const clock = { time: 0 };
	const kept = memory({ now: () => clock.time });
	for (const n of [1, 2, 3, 4]) {
		kept.add("sam", `q${n}`, `a${n}`);
	}
	assert.deepEqual(kept.messages("sam").map((m) => m.content), ["q2", "a2", "q3", "a3", "q4", "a4"]);
	assert.deepEqual(kept.messages("heather"), []);
	clock.time = 121000;
	assert.deepEqual(kept.messages("sam"), []);
});

test("questions stop at the daily limit and start again the next day", () => {
	let day = new Date(2026, 10, 26);
	const allowed = dailyLimit(2, () => day);
	assert.deepEqual([allowed(), allowed(), allowed()], [true, true, false]);
	day = new Date(2026, 10, 27);
	assert.equal(allowed(), true);
});
