const { spawn } = require("node:child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { createHome } = require("../MMM-Lights/home");
const { DEFAULTS, decide, player } = require("./radio");

/* Plays a radio station on the mirror's speaker while a switch in Home
 * Assistant is on.
 *
 * The switch is the one thing that says whether music should play, so the
 * HomePods, the TVs and the mirror start and stop together. The speaker
 * takes one sound at a time: when the mirror is about to speak, the radio
 * stops, and it starts again afterwards. The Home Assistant token is read
 * from the environment and stays here. */
module.exports = NodeHelper.create({
	start () {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		this.home = createHome({ url: this.config.url });
		this.on = false;
		this.speaking = false;
		this.child = null;
		this.timer = null;
		this.quiet = null;
		this.holdUntil = 0;
		if (this.home.ready() && !this.config.stream) {
			Log.warn("MMM-Radio is idle: it has no stream address");
		}
	},

	stop () {
		clearInterval(this.timer);
		clearTimeout(this.quiet);
		this.halt();
	},

	socketNotificationReceived (notification, payload) {
		if (!this.home.ready() || !this.config.stream) {
			return;
		}
		if (notification === "START") {
			if (!this.timer) {
				this.timer = setInterval(() => this.look(), this.config.pollSeconds * 1000);
			}
			this.look();
		} else if (notification === "LOOK") {
			this.look();
		} else if (notification === "SPEAKING") {
			this.speaking = Boolean(payload && payload.speaking);
			clearTimeout(this.quiet);
			if (this.speaking) {
				// A line whose end never arrives must not keep the radio off.
				this.quiet = setTimeout(() => {
					this.speaking = false;
					this.sendSocketNotification("FORGET");
					this.act();
				}, this.config.speechSeconds * 1000);
				this.act();
			} else {
				// The line may have been the answer to "stop the music", so
				// ask Home Assistant again before the radio comes back.
				this.look();
			}
		}
	},

	/** Asks Home Assistant whether the switch is on, and acts on it. */
	async look () {
		try {
			const found = await this.home.read(this.config.entity);
			this.on = Boolean(found && found[0] && found[0].on);
		} catch (error) {
			// Home Assistant not answering is no reason to start or stop.
			Log.warn(`Could not read ${this.config.entity}: ${error.message}`);
			return;
		}
		this.act();
	},

	act () {
		const next = decide({ on: this.on, speaking: this.speaking, playing: Boolean(this.child) });
		if (next === "play" && Date.now() >= this.holdUntil) {
			this.play();
		} else if (next === "stop") {
			this.halt();
		}
	},

	play () {
		const { command, args } = player(this.config);
		let problem = "";
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		this.child = child;
		Log.log("Started the station");
		child.stderr.on("data", (chunk) => {
			problem = `${problem}${chunk}`.slice(-300);
		});
		child.on("error", (error) => {
			problem = error.message;
		});
		child.on("close", (code) => {
			if (this.child !== child) {
				return;
			}
			// It stopped by itself: the stream dropped or the speaker was
			// taken. Wait before trying again.
			this.child = null;
			this.holdUntil = Date.now() + this.config.retrySeconds * 1000;
			Log.warn(`The player stopped with ${code}: ${problem.trim().slice(0, 160)}`);
			setTimeout(() => this.act(), this.config.retrySeconds * 1000 + 100);
		});
	},

	halt () {
		if (this.child) {
			const child = this.child;
			this.child = null;
			child.kill("SIGTERM");
			Log.log("Stopped the station");
		}
	}
});
