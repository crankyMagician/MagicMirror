const NodeHelper = require("node_helper");
const Log = require("logger");
const { createHome } = require("./home");
const { DEFAULTS, answer, describe, parse, repeatGuard, summarize } = require("./lights");

/* Switches the household's lights through Home Assistant and tells the page
 * what they are doing.
 *
 * Which lights and scenes the mirror may use comes from the server's own
 * config and never from the page: the page sends a command id and nothing
 * else. The access token is read from the environment and stays here. */
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
			return;
		}
		if (notification === "START") {
			if (!this.timer) {
				this.timer = setInterval(() => this.report(), this.config.pollSeconds * 1000);
			}
			this.report();
		} else if (notification === "COMMAND" && payload && typeof payload.id === "string") {
			this.run(payload.id);
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
		const rows = await Promise.all(Object.entries(this.config.lights).map(async ([key, light]) => {
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
