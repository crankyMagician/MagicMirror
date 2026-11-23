/* Run with: node --test mirror/modules/ */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

/**
 * Loads a browser-side MagicMirror module file and returns an instance with
 * the given config, without MagicMirror or a DOM.
 * @param {string} file the module's main file
 * @param {object} config options laid over the module's defaults
 * @returns {object} the module instance
 */
function load (file, config) {
	let definition;
	global.Module = { register: (name, value) => { definition = value; } };
	global.Log = { warn () {}, log () {} };
	delete require.cache[require.resolve(file)];
	require(file);
	const instance = Object.create(definition);
	instance.config = { ...definition.defaults, ...config };
	instance.sent = [];
	instance.sendNotification = (name, payload) => instance.sent.push({ name, payload });
	instance.sendSocketNotification = () => {};
	instance.updateDom = () => {};
	instance.hidden = false;
	return instance;
}

const greeter = (config = {}) => {
	const instance = load(path.join(__dirname, "MMM-Greeter.js"), {
		people: { sam: { name: "Sam" }, heather: { name: "Heather", favorites: ["mew", "miltank", "celesteela"] } },
		...config
	});
	instance.start();
	return instance;
};
const at = (hour, day = 22) => new Date(2026, 10, day, hour, 0);

test("the greeting follows the time of day", () => {
	const module = greeter();
	assert.equal(module.buildGreeting("sam", at(7)).text, "Good morning, Sam.");
	assert.equal(module.buildGreeting("sam", at(13)).text, "Good afternoon, Sam.");
	assert.equal(module.buildGreeting("sam", at(19)).text, "Good evening, Sam.");
	assert.equal(module.buildGreeting("sam", at(23)).text, "Hello, Sam.");
});

test("a person without favorites gets no companion", () => {
	const greeting = greeter().buildGreeting("sam", at(7));
	assert.equal(greeting.pokemon, null);
	assert.equal(greeting.companion, null);
});

test("favorites rotate one per day and repeat", () => {
	const module = greeter();
	const days = [22, 23, 24, 25].map((day) => module.buildGreeting("heather", at(8, day)).pokemon);
	assert.equal(new Set(days.slice(0, 3)).size, 3);
	assert.equal(days[3], days[0]);
	assert.equal(module.buildGreeting("heather", at(8)).pokemon, module.buildGreeting("heather", at(21)).pokemon);
});

test("the companion line names the Pokémon", () => {
	const module = greeter({ people: { heather: { name: "Heather", favorites: ["mr-mime"] } } });
	assert.equal(module.buildGreeting("heather", at(8)).companion, "Mr Mime is with you today.");
});

test("a person is greeted on arrival and spoken to once", () => {
	const module = greeter();
	module.onPresence("heather", at(8));
	assert.ok(module.greeting.text.includes("Heather"));
	assert.equal(module.sent.length, 1);
	assert.equal(module.sent[0].name, "TTS_SAY");
	clearTimeout(module.hideTimer);
});

test("the same view arriving again does not greet again", () => {
	const module = greeter();
	module.onPresence("heather", at(8));
	module.onPresence("heather", at(8));
	assert.equal(module.sent.length, 1);
	clearTimeout(module.hideTimer);
});

test("a short absence does not greet again, a long one does without speaking", () => {
	const module = greeter();
	const start = at(8).getTime();
	module.onPresence("heather", new Date(start));
	module.onPresence(null, new Date(start + 60 * 1000));
	module.greeting = null;
	module.onPresence("heather", new Date(start + 5 * 60 * 1000));
	assert.equal(module.greeting, null);
	module.onPresence(null, new Date(start + 6 * 60 * 1000));
	module.onPresence("heather", new Date(start + 50 * 60 * 1000));
	assert.ok(module.greeting);
	assert.equal(module.sent.length, 1);
	clearTimeout(module.hideTimer);
});

test("guests and unknown names are not greeted", () => {
	const module = greeter();
	module.onPresence("guest", at(8));
	assert.equal(module.greeting, null);
});

test("a hidden greeter stays silent", () => {
	const module = greeter();
	module.hidden = true;
	module.onPresence("heather", at(8));
	assert.equal(module.greeting, null);
	assert.equal(module.sent.length, 0);
});

test("air quality bands follow the US index", () => {
	const air = load(path.join(__dirname, "../MMM-AirQuality/MMM-AirQuality.js"), {});
	assert.equal(air.bandFor(0).label, "Good");
	assert.equal(air.bandFor(50).label, "Good");
	assert.equal(air.bandFor(51).label, "Moderate");
	assert.equal(air.bandFor(151).label, "Unhealthy");
	assert.equal(air.bandFor(480).label, "Hazardous");
});
