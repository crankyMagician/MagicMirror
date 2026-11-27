// The strip on the screen, driven the way the helper drives it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

/**
 * Loads MMM-Voice.js into a page and returns a started module.
 * @returns {object} { module, document, sent, socket }
 */
const load = () => {
	const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
	let definition = null;
	dom.window.Module = { register: (name, body) => {
		definition = body;
	} };
	dom.window.eval(fs.readFileSync(path.join(__dirname, "MMM-Voice.js"), "utf8"));
	const sent = [];
	const socket = [];
	const module = Object.assign(Object.create(definition), {
		config: { ...definition.defaults, lights: { "kitchen lights": "kitchen" }, commands: { ...definition.defaults.commands, what_is_next: ["what is next"] } },
		// Objects made inside the page come from another realm, so copy them out.
		sendNotification: (notification, payload) => sent.push({ notification, payload: JSON.parse(JSON.stringify(payload)) }),
		sendSocketNotification: (notification, payload) => socket.push({ notification, payload })
	});
	// The module's code runs against the page's document.
	global.document = dom.window.document;
	module.start();
	module.notificationReceived("DOM_OBJECTS_CREATED");
	return { dom, module, document: dom.window.document, sent, socket };
};

const strip = (document) => document.querySelector(".voice-strip");
const words = (document) => document.querySelector(".voice-text").textContent;

test("the strip waits, listens, shows what it understood and goes back", (t) => {
	const { dom, module, document, sent } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "ready" });
	assert.ok(strip(document).classList.contains("voice-waiting"));

	module.socketNotificationReceived("VOICE_EVENT", { type: "window", open: true, seconds: 8, reason: "wake" });
	assert.ok(strip(document).classList.contains("voice-listening"));
	assert.ok(strip(document).classList.contains("voice-window"));
	assert.equal(words(document), "Listening");
	assert.deepEqual(sent.at(-1), { notification: "VOICE_LISTENING", payload: { on: true, reason: "wake" } });

	module.socketNotificationReceived("VOICE_EVENT", { type: "level", value: 0.6 });
	assert.equal(strip(document).style.getPropertyValue("--voice-level"), "0.6");

	module.socketNotificationReceived("VOICE_EVENT", { type: "command", id: "light:on:kitchen", text: "turn on the kitchen lights", window: "wake" });
	assert.ok(strip(document).classList.contains("voice-understood"));
	assert.equal(words(document), "Turn on the kitchen lights");
	assert.deepEqual(sent.at(-1), { notification: "VOICE_LISTENING", payload: { on: false, reason: "wake" } });
	clearTimeout(module.stateTimer);
});

test("a miss says so and shows what it heard, but talk after an answer is left alone", (t) => {
	const { dom, module, document } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "ready" });
	module.socketNotificationReceived("VOICE_EVENT", { type: "missed", text: "mirror good night", why: "low", window: null });
	assert.ok(strip(document).classList.contains("voice-missed"));
	assert.equal(words(document), "Sorry, I did not catch that. Did you say \"Good night\"?");

	module.socketNotificationReceived("VOICE_EVENT", { type: "missed", text: "the can set on and purple help", why: "unknown", window: "wake" });
	assert.equal(words(document), "Sorry, I did not catch that.");

	module.socketNotificationReceived("VOICE_EVENT", { type: "missed", text: "", why: "unknown", window: "follow_up" });
	assert.ok(strip(document).classList.contains("voice-waiting"));
	clearTimeout(module.stateTimer);
});

test("the follow-up asks for more, and the wake word mid-sentence lights the strip", (t) => {
	const { dom, module, document, sent } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "window", open: true, seconds: 5, reason: "follow_up" });
	assert.equal(words(document), "Anything else?");
	assert.deepEqual(sent.at(-1).payload, { on: true, reason: "follow_up" });
	module.socketNotificationReceived("VOICE_EVENT", { type: "window", open: false, reason: "timeout" });
	assert.ok(strip(document).classList.contains("voice-waiting"));

	module.socketNotificationReceived("VOICE_EVENT", { type: "listening", on: true });
	assert.ok(strip(document).classList.contains("voice-listening"));
	module.socketNotificationReceived("VOICE_EVENT", { type: "listening", on: false });
	assert.ok(strip(document).classList.contains("voice-waiting"));
});

test("a caption shows while the mirror speaks, and the microphone is muted meanwhile", (t) => {
	const { dom, module, document, socket } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "ready" });
	module.notificationReceived("TTS_SAY", { text: "Kitchen lights on." });
	module.notificationReceived("TTS_SAY_STARTING");
	assert.ok(strip(document).classList.contains("voice-speaking"));
	assert.equal(words(document), "Kitchen lights on.");
	assert.deepEqual(socket.at(-1), { notification: "MUTE", payload: true });
	module.notificationReceived("TTS_SAY_ENDING");
	assert.ok(strip(document).classList.contains("voice-waiting"));
	assert.deepEqual(socket.at(-1), { notification: "MUTE", payload: false });
});

test("help speaks a few examples and puts a card in place of the news", (t) => {
	const { dom, module, document, sent } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_COMMAND", { id: "help", text: "mirror what can i say" });
	const said = sent.find((entry) => entry.notification === "TTS_SAY");
	assert.match(said.payload.text, /^Say mirror, then a command, such as turn on the kitchen lights, what is next or/);
	assert.ok(document.body.classList.contains("voice-help"));
	assert.ok([...document.querySelectorAll(".voice-help-card li")].some((item) => item.textContent === "Turn on the kitchen lights"));
	clearTimeout(module.helpTimer);
});

test("a person who arrives gets a hint until the mirror has heard a command that day", (t) => {
	const { dom, module, document } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "ready" });
	module.notificationReceived("HOUSEHOLD_PRESENCE", { person: "sam" });
	assert.ok(strip(document).classList.contains("voice-hint"));
	assert.equal(words(document), "Say \"Mirror\", then a command");
	module.socketNotificationReceived("VOICE_EVENT", { type: "command", id: "good_night", text: "mirror good night" });
	module.show("waiting");
	module.notificationReceived("HOUSEHOLD_PRESENCE", { person: null });
	module.notificationReceived("HOUSEHOLD_PRESENCE", { person: "sam" });
	assert.ok(strip(document).classList.contains("voice-waiting"));
	clearTimeout(module.stateTimer);
});

test("Deepgram's words show while the mirror works, and a sentence goes to the house", (t) => {
	const { dom, module, document, sent } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "thinking" });
	assert.ok(strip(document).classList.contains("voice-thinking"));

	module.socketNotificationReceived("VOICE_EVENT", { type: "transcript", text: "Mirror, dim the kitchen to 30%.", confidence: 0.98, window: null });
	assert.equal(words(document), "Heard: \"Dim the kitchen to 30%\"");

	module.notificationReceived("HOUSEHOLD_PRESENCE", { person: "sam" });
	module.socketNotificationReceived("VOICE_EVENT", { type: "utterance", text: "dim the kitchen to 30%", confidence: 0.98, window: null });
	assert.deepEqual(sent.at(-1), { notification: "VOICE_UTTERANCE", payload: { text: "dim the kitchen to 30%", window: null, person: "sam" } });
	clearTimeout(module.stateTimer);
});

test("a sentence nothing could act on is said back, except after an answer", (t) => {
	const { dom, module, document, sent } = load();
	t.after(() => dom.window.close());
	module.notificationReceived("VOICE_UNHANDLED", { text: "Paint the fence", window: null });
	assert.ok(strip(document).classList.contains("voice-missed"));
	assert.equal(sent.at(-1).notification, "TTS_SAY");
	assert.equal(sent.at(-1).payload.text, "I heard paint the fence, but I do not know how to do that yet.");

	const before = sent.length;
	module.notificationReceived("VOICE_UNHANDLED", { text: "and then we left", window: "follow_up" });
	assert.equal(sent.length, before);
	assert.ok(strip(document).classList.contains("voice-waiting"));
	clearTimeout(module.stateTimer);
});

test("a wake word that Deepgram did not hear is dropped without a word", (t) => {
	const { dom, module, document } = load();
	t.after(() => dom.window.close());
	module.socketNotificationReceived("VOICE_EVENT", { type: "missed", text: "and then the kids left", why: "no_wake", window: null });
	assert.ok(strip(document).classList.contains("voice-waiting"));
});
