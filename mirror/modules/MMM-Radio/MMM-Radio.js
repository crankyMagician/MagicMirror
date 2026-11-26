/* MMM-Radio
 *
 * Plays a radio station on the mirror's own speaker while a switch in Home
 * Assistant is on. It shows nothing. The household's Christmas music uses
 * it: "mirror, christmas music" runs a script in Home Assistant that turns
 * the switch on and starts the HomePods and the TVs, and this module makes
 * the mirror join in. The players are not in step with each other.
 *
 *   {
 *     module: "MMM-Radio",
 *     config: {
 *       url: "http://192.168.10.212:8123",
 *       entity: "input_boolean.christmas_music",
 *       stream: "https://ice2.somafm.com/christmas-256-mp3"
 *     }
 *   }
 *
 * The speaker takes one sound at a time, so the radio stops while the
 * mirror speaks and starts again afterwards. It also stops while the mirror
 * listens for a command (VOICE_LISTENING from MMM-Voice), so the music does
 * not drown out the person. The access token is
 * SECRET_HA_TOKEN in config.env and stays in the node helper, which needs
 * ffmpeg on the Pi.
 */
Module.register("MMM-Radio", {
	defaults: {
		url: "",
		entity: "input_boolean.christmas_music",
		stream: ""
	},

	start () {
		// Lines asked for and not yet finished. Two lines in a row must
		// not let the radio back in between them.
		this.pending = 0;
		this.listeningNow = false;
		this.sendSocketNotification("START");
	},

	notificationReceived (notification, payload) {
		if (notification === "TTS_SAY") {
			this.pending += 1;
			this.quietNow();
		} else if (notification === "TTS_SAY_ENDING" || notification === "TTS_SAY_ERROR") {
			this.pending = Math.max(0, this.pending - 1);
			this.quietNow();
		} else if (notification === "VOICE_LISTENING" && payload) {
			this.listeningNow = Boolean(payload.on);
			this.quietNow();
		} else if (notification === "VOICE_COMMAND") {
			// A spoken command may have just changed the switch. Look soon
			// after, without waiting for the next regular look.
			setTimeout(() => this.sendSocketNotification("LOOK"), 4000);
		}
	},

	/** Tells the helper whether the speaker must be left quiet now. */
	quietNow () {
		this.sendSocketNotification("SPEAKING", { speaking: this.pending > 0 || this.listeningNow });
	},

	socketNotificationReceived (notification) {
		// The helper gave up waiting for a line to end.
		if (notification === "FORGET") {
			this.pending = 0;
		}
	},

	getDom () {
		return document.createElement("div");
	}
});
