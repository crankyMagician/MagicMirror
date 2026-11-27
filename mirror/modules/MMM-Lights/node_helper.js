const NodeHelper = require("node_helper");
const Log = require("logger");
const { createHome } = require("./home");
const { DEFAULTS, answer, conversed, describe, parse, repeatGuard, summarize } = require("./lights");

/* Switches the household's lights through Home Assistant and tells the page
 * what they are doing.
 *
 * Which lights and scenes the mirror may use comes from the server's own
 * config and never from the page: the page sends a command id, or a sentence
 * for Assist, which only sees the lights and players shown to it. The access
 * token is read from the environment and stays here. */
module.exports = NodeHelper.create({
	start () {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		this.home = createHome({ url: this.config.url });
		this.repeated = repeatGuard(this.config.repeatSeconds);
		this.busy = new Set();
		this.timer = null;
		if (!this.home.ready()) {
			Log.warn("MMM-Lights is idle: set MIRROR_HA_URL and SECRET_HA_TOKEN in config.env");
		}
	},

	stop () {
		clearInterval(this.timer);
	},

	socketNotificationReceived (notification, payload) {
		if (!this.home.ready()) {
			// Without Home Assistant a sentence can still be a question for another module.
			if (notification === "CONVERSE" && payload && typeof payload.text === "string") {
				this.sendSocketNotification("CONVERSED", { text: payload.text, window: payload.window || null, unhandled: true });
			}
			return;
		}
		if (notification === "START") {
			if (!this.timer) {
				this.timer = setInterval(() => this.report(), this.config.pollSeconds * 1000);
			}
			this.report();
		} else if (notification === "COMMAND" && payload && typeof payload.id === "string") {
			this.run(payload.id);
		} else if (notification === "CONVERSE" && payload && typeof payload.text === "string" && payload.text.trim()) {
			this.converse(payload.text.trim().slice(0, 300), payload.window || null);
		}
	},

	/**
	 * Hands a sentence to Home Assistant and says its answer, or passes the
	 * sentence back to the page when Home Assistant has nothing to do with it.
	 * @param {string} text what was said, without the wake word
	 * @param {string|null} window the listening window it was said in
	 */
	async converse (text, window) {
		let reply;
		try {
			reply = await this.home.converse(text);
		} catch (error) {
			Log.warn(`Could not reach Home Assistant for "${text}": ${error.message}`);
			reply = { error: "unreachable" };
		}
		const outcome = conversed(text, reply);
		Log.log(`Assist on "${text}": ${reply.error || reply.kind}${reply.code ? ` (${reply.code})` : ""}${outcome.say ? `, says "${outcome.say}"` : ", passed on"}`);
		this.sendSocketNotification("CONVERSED", { text, window, ...outcome });
		if (reply.kind === "action_done") {
			// The lights take a few seconds to report their new state.
			setTimeout(() => this.report(), (this.config.confirmSeconds || 5) * 1000);
		}
	},

	/**
	 * Carries out one spoken command and says what the lights did.
	 * @param {string} id the command id from MMM-Voice
	 */
	async run (id) {
		const command = parse(id, this.config);
		if (!command) {
			Log.warn(`Ignored a light command the config does not list: ${id.slice(0, 60)}`);
			return;
		}
		// The microphone can hear one command twice, and a command for
		// lights that are still switching would only queue up behind it.
		if (this.repeated(id) || this.busy.has(command.key)) {
			Log.log(`Skipped a repeat of ${id}`);
			return;
		}
		this.busy.add(command.key);
		let outcome;
		try {
			outcome = command.kind === "scene"
				? await this.home.scene(command.target.entity, command.target.members)
				: await this.home.apply(command.target.entity, command.want, this.config.confirmSeconds);
		} catch (error) {
			Log.warn(`Could not reach Home Assistant for ${id}: ${error.message}`);
			outcome = { error: "unreachable" };
		}
		this.busy.delete(command.key);
		Log.log(`Light command ${id}: ${outcome.error || `${outcome.reached} of ${outcome.total} answered`}`);
		const text = answer(command, outcome);
		if (text) {
			this.sendSocketNotification("SAY", { id: `lights-${Date.now()}`, text });
		}
		this.report();
	},

	/** Reads every light on the card and sends the rows to the page. */
	async report () {
		const shown = Object.entries(this.config.lights).filter(([, light]) => light.card !== false);
		const rows = await Promise.all(shown.map(async ([key, light]) => {
			let summary = null;
			let reachable = true;
			try {
				const members = await this.home.read(light.entity);
				summary = members ? summarize(members) : null;
			} catch {
				reachable = false;
			}
			return { key, label: light.label || light.say, reachable, ...describe(summary) };
		}));
		this.sendSocketNotification("STATE", { rows, reachable: rows.length === 0 || rows.some((row) => row.reachable) });
	}
});
