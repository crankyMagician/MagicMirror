// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHome } = require("./home");

const GROUP = "light.master_bedroom_lights";
const ONE = "light.bulb_one";
const TWO = "light.bulb_two";
const SCENE = "scene.bedroom_evening";
const SCRIPT = "script.christmas_lights_on";

/**
 * Stands in for Home Assistant: two bulbs, a group of both, a scene and a script.
 * @param {object} [options] how the stand-in behaves
 * @param {string[]} [options.dead] bulbs that are off at the wall
 * @param {number} [options.lag] reads of a bulb that still show the old state after a call
 * @param {number} [options.callStatus] the status every service call answers with
 * @param {boolean} [options.down] whether Home Assistant is unreachable
 * @returns {object} the client, the requests it made and a clock to move
 */
const setup = ({ dead = [], lag = 0, callStatus = 200, down = false } = {}) => {
	const bulbs = { [ONE]: { state: "off", attributes: {} }, [TWO]: { state: "on", attributes: { brightness: 255 } } };
	for (const entity of dead) {
		bulbs[entity] = { state: "unavailable", attributes: {} };
	}
	const pending = {};
	const calls = [];
	const clock = { time: 0 };
	const reply = (status, body) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
	const request = (url, options) => {
		if (down) {
			return Promise.reject(new TypeError("fetch failed"));
		}
		const path = new URL(url).pathname;
		calls.push({ method: options.method, path, body: options.body ? JSON.parse(options.body) : undefined, authorization: options.headers.Authorization });
		if (options.method === "POST") {
			const on = path.endsWith("/turn_on");
			const body = JSON.parse(options.body);
			if (path.startsWith("/api/services/light/")) {
				for (const entity of [ONE, TWO].filter((bulb) => !dead.includes(bulb))) {
					const brightness = body.brightness_pct ? Math.round(body.brightness_pct * 2.55) : 200;
					pending[entity] = { after: lag, value: on ? { state: "on", attributes: { brightness } } : { state: "off", attributes: {} } };
				}
			}
			return reply(callStatus, []);
		}
		const entity = path.replace("/api/states/", "");
		if (entity === GROUP || entity === SCENE) {
			return reply(200, { state: "on", attributes: { entity_id: [ONE, TWO] } });
		}
		if (entity === SCRIPT) {
			return reply(200, { state: "off", attributes: { mode: "single" } });
		}
		if (!bulbs[entity]) {
			return reply(404, { message: "Entity not found." });
		}
		if (pending[entity]) {
			if (pending[entity].after <= 0) {
				bulbs[entity] = pending[entity].value;
				delete pending[entity];
			} else {
				pending[entity].after -= 1;
			}
		}
		return reply(200, bulbs[entity]);
	};
	const wait = (ms) => {
		clock.time += ms;
		return Promise.resolve();
	};
	const home = createHome({ url: "http://ha.test:8123/", env: { SECRET_HA_TOKEN: "token-1" }, fetch: request, wait, now: () => clock.time });
	return { home, calls, clock };
};

test("without an address or a token the client is not ready", () => {
	assert.equal(createHome({ url: "", env: { SECRET_HA_TOKEN: "t" } }).ready(), false);
	assert.equal(createHome({ url: "http://ha.test:8123", env: {} }).ready(), false);
	assert.equal(setup().home.ready(), true);
});

test("a group is read bulb by bulb, with brightness in percent", async () => {
	const { home, calls } = setup({ dead: [ONE] });
	assert.deepEqual(await home.read(GROUP), [
		{ entity: ONE, available: false, on: false, level: null },
		{ entity: TWO, available: true, on: true, level: 100 }
	]);
	assert.deepEqual(await home.read(TWO), [{ entity: TWO, available: true, on: true, level: 100 }]);
	assert.equal(await home.read("light.nowhere"), null);
	assert.ok(calls.every((call) => call.authorization === "Bearer token-1"));
});

test("switching names the state, then waits for the bulbs to report it", async () => {
	const { home, calls } = setup({ lag: 2 });
	assert.deepEqual(await home.apply(GROUP, { on: false }, 5), { total: 2, reached: 2 });
	const posts = calls.filter((call) => call.method === "POST");
	assert.deepEqual(posts, [{ method: "POST", path: "/api/services/light/turn_off", body: { entity_id: GROUP }, authorization: "Bearer token-1" }]);
	assert.equal(calls.some((call) => call.path.includes("toggle")), false);
});

test("a level goes out as a percentage and counts once the bulbs are near it", async () => {
	const { home, calls } = setup();
	assert.deepEqual(await home.apply(GROUP, { on: true, level: 50 }, 5), { total: 2, reached: 2 });
	assert.deepEqual(calls.find((call) => call.method === "POST").body, { entity_id: GROUP, brightness_pct: 50 });
});

test("a bulb that is off at the wall is counted as not answering, once the wait is over", async () => {
	const { home, clock } = setup({ dead: [ONE] });
	assert.deepEqual(await home.apply(GROUP, { on: true }, 2), { total: 2, reached: 1 });
	assert.ok(clock.time >= 2000);
});

test("a failed call still reports what the bulbs did", async () => {
	const { home } = setup({ callStatus: 500 });
	assert.deepEqual(await home.apply(GROUP, { on: false }, 1), { total: 2, reached: 2 });
});

test("an unknown light or scene is reported as unknown", async () => {
	const { home, calls } = setup();
	assert.deepEqual(await home.apply("light.nowhere", { on: true }, 1), { error: "unknown" });
	assert.deepEqual(await home.scene("scene.nowhere"), { error: "unknown" });
	assert.equal(calls.some((call) => call.path === "/api/services/scene/turn_on"), false);
});

test("a scene is set and the answering lights in it are counted", async () => {
	const { home, calls } = setup({ dead: [TWO] });
	assert.deepEqual(await home.scene(SCENE), { total: 2, reached: 1 });
	assert.deepEqual(calls.find((call) => call.method === "POST"), { method: "POST", path: "/api/services/scene/turn_on", body: { entity_id: SCENE }, authorization: "Bearer token-1" });
});

test("a script is started and the lights the config lists for it are counted", async () => {
	const { home, calls } = setup({ dead: [TWO] });
	assert.deepEqual(await home.scene(SCRIPT, [GROUP]), { total: 2, reached: 1 });
	assert.deepEqual(calls.find((call) => call.method === "POST"), { method: "POST", path: "/api/services/script/turn_on", body: { entity_id: SCRIPT }, authorization: "Bearer token-1" });
	assert.deepEqual(await home.scene(SCRIPT, [GROUP, "light.nowhere"]), { error: "unknown" });
});

test("only a scene or a script can be started by name", async () => {
	const { home, calls } = setup();
	assert.deepEqual(await home.scene(ONE), { error: "unknown" });
	assert.deepEqual(await home.scene("automation.anything"), { error: "unknown" });
	assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("an unreachable Home Assistant is an error for the caller to report", async () => {
	const { home } = setup({ down: true });
	await assert.rejects(home.apply(GROUP, { on: true }, 1), /fetch failed/);
	await assert.rejects(home.read(GROUP), /fetch failed/);
});

test("a sentence goes to Assist's built-in agent and its answer comes back", async () => {
	const calls = [];
	const reply = { response: { response_type: "action_done", speech: { plain: { speech: "Turned off the lights" } }, data: { success: [] } } };
	const home = createHome({
		url: "http://ha:8123",
		env: { SECRET_HA_TOKEN: "T" },
		fetch: (url, options) => {
			calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body), authorization: options.headers.Authorization });
			return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(reply) });
		}
	});
	assert.deepEqual(await home.converse("turn off upstairs"), { kind: "action_done", code: null, speech: "Turned off the lights" });
	assert.deepEqual(calls, [{ path: "/api/conversation/process", body: { text: "turn off upstairs", language: "en", agent_id: "conversation.home_assistant" }, authorization: "Bearer T" }]);
});

test("an Assist error carries its code", async () => {
	const reply = { response: { response_type: "error", speech: { plain: { speech: "Sorry, I couldn't understand that" } }, data: { code: "no_intent_match" } } };
	const home = createHome({ url: "http://ha:8123", env: { SECRET_HA_TOKEN: "T" }, fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(reply) }) });
	assert.deepEqual(await home.converse("how tall is Everest"), { kind: "error", code: "no_intent_match", speech: "Sorry, I couldn't understand that" });
});
