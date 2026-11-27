/* Talks to Home Assistant for MMM-Lights: reads lights, switches them and
 * waits for them to report what was asked.
 *
 * The access token comes from the environment (SECRET_HA_TOKEN in
 * config.env on the Pi) and never leaves this helper. Every state is read
 * from Home Assistant when it is needed. Nothing is kept here.
 */
const { reached } = require("./lights");

const pause = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});

/**
 * Builds a client for one Home Assistant.
 * @param {object} options where it is and how to reach it
 * @param {string} options.url its address, for example "http://192.168.10.212:8123"
 * @param {object} [options.env] stands in for the environment in tests
 * @param {function(string, object): Promise<object>} [options.fetch] stands in for fetch in tests
 * @param {function(number): Promise} [options.wait] stands in for a pause in tests
 * @param {function(): number} [options.now] the clock, in milliseconds
 * @returns {object} `ready()`, `read(entity)`, `apply(entity, want, seconds)`, `scene(entity, members)` and `converse(text)`
 */
const createHome = ({ url, env = process.env, fetch: request = fetch, wait = pause, now = Date.now }) => {
	const base = String(url || "").replace(/\/+$/, "");
	const token = env.SECRET_HA_TOKEN || "";

	const ready = () => Boolean(base && token);

	/**
	 * Sends one request. A 404 means Home Assistant does not know the entity.
	 * @param {string} method GET or POST
	 * @param {string} path the path under the address
	 * @param {object} [body] what to send as JSON
	 * @returns {Promise<object|null>} the answer, or null for a 404
	 */
	const ask = async (method, path, body) => {
		const response = await request(`${base}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(6000)
		});
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			throw Object.assign(new Error(`Home Assistant answered ${response.status}`), { status: response.status });
		}
		return response.json();
	};

	const asLight = (entity, state) => {
		const brightness = state && state.attributes ? state.attributes.brightness : null;
		return {
			entity,
			available: Boolean(state) && state.state !== "unavailable" && state.state !== "unknown",
			on: Boolean(state) && state.state === "on",
			level: typeof brightness === "number" ? Math.round(brightness / 255 * 100) : null
		};
	};

	/**
	 * Reads a light, or every light of a group or a scene.
	 * @param {string} entity an entity id
	 * @returns {Promise<object[]|null>} the lights as `{ entity, available, on, level }`, or null when Home Assistant does not know the entity
	 */
	const read = async (entity) => {
		const state = await ask("GET", `/api/states/${entity}`);
		if (!state) {
			return null;
		}
		const members = state.attributes && Array.isArray(state.attributes.entity_id) ? state.attributes.entity_id : null;
		if (!members) {
			return [asLight(entity, state)];
		}
		return Promise.all(members.map(async (member) => asLight(member, await ask("GET", `/api/states/${member}`))));
	};

	/**
	 * Switches a light or a group and waits for it to report the new state.
	 * @param {string} entity the light or group
	 * @param {object} want `{ on, level }`, the level in percent and optional
	 * @param {number} seconds how long to wait for the report
	 * @returns {Promise<object>} `{ total, reached }`, or `{ error: "unknown" }`
	 */
	const apply = async (entity, want, seconds) => {
		const data = { entity_id: entity };
		if (want.on && want.level !== undefined) {
			data.brightness_pct = want.level;
		}
		try {
			await ask("POST", `/api/services/light/${want.on ? "turn_on" : "turn_off"}`, data);
		} catch (error) {
			// A group with one dead bulb can fail as a whole while the other
			// bulbs did switch. What the lights report below is what counts.
			if (!error.status) {
				throw error;
			}
		}
		const deadline = now() + seconds * 1000;
		for (;;) {
			const lights = await read(entity);
			if (!lights) {
				return { error: "unknown" };
			}
			const done = lights.filter((light) => reached(light, want)).length;
			if (done === lights.length || now() >= deadline) {
				return { total: lights.length, reached: done };
			}
			await wait(400);
		}
	};

	/**
	 * Sets a scene or starts a script. Neither reports back, so this counts
	 * the lights that are answering afterwards: the scene's own lights, or
	 * the lights the config lists for a script.
	 * @param {string} entity the scene or the script
	 * @param {string[]} [members] lights or groups to count in place of the scene's own
	 * @returns {Promise<object>} `{ total, reached }`, or `{ error: "unknown" }`
	 */
	const scene = async (entity, members) => {
		const [domain] = String(entity).split(".");
		if (!["scene", "script"].includes(domain) || await ask("GET", `/api/states/${entity}`) === null) {
			return { error: "unknown" };
		}
		await ask("POST", `/api/services/${domain}/turn_on`, { entity_id: entity });
		await wait(1500);
		const groups = await Promise.all((Array.isArray(members) && members.length > 0 ? members : [entity]).map(read));
		if (groups.includes(null)) {
			return { error: "unknown" };
		}
		const lights = groups.flat();
		return { total: lights.length, reached: lights.filter((light) => light.available).length };
	};

	/**
	 * Hands a sentence to Assist, Home Assistant's own understanding of the
	 * house: "turn off the upstairs lights", "dim the kitchen to 30%". It uses
	 * the built-in agent, which needs no LLM and knows the floors, rooms and
	 * lights that are shown to Assist.
	 * @param {string} text what a person said, without the wake word
	 * @returns {Promise<object>} `{ kind, code, speech }`: kind is action_done, query_answer or error
	 */
	const converse = async (text) => {
		const reply = await ask("POST", "/api/conversation/process", { text, language: "en", agent_id: "conversation.home_assistant" });
		const response = (reply && reply.response) || {};
		const speech = response.speech && response.speech.plain ? String(response.speech.plain.speech || "") : "";
		return { kind: String(response.response_type || "error"), code: (response.data && response.data.code) || null, speech };
	};

	return { apply, converse, read, ready, scene };
};

module.exports = { createHome };
