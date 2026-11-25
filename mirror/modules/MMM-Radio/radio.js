/* What the mirror's radio should be doing, and the command that plays it. No network and no process here. */

const DEFAULTS = {
	// Where Home Assistant answers. Empty leaves the module idle.
	url: "",
	// The switch in Home Assistant that says whether music should play.
	entity: "input_boolean.christmas_music",
	// The station, as a direct stream address that ffmpeg can read.
	stream: "",
	// The ALSA device. The mirror's voice uses the same one.
	speaker: "plughw:CARD=Device",
	// 0 to 1. Music sits under the mirror's voice.
	volume: 0.4,
	// Seconds between looks at the switch.
	pollSeconds: 10,
	// Seconds to wait before trying again when the player stopped by itself.
	retrySeconds: 15,
	// The longest the radio stays quiet for one spoken line, in case the
	// line's end never arrives.
	speechSeconds: 45
};

/**
 * Says what to do next.
 * @param {object} state where things stand
 * @param {boolean} state.on whether the switch is on
 * @param {boolean} state.speaking whether the mirror is speaking or about to
 * @param {boolean} state.playing whether the player is running
 * @returns {string|null} "play", "stop", or null for nothing
 */
const decide = ({ on, speaking, playing }) => {
	const wanted = Boolean(on) && !speaking;
	if (wanted && !playing) {
		return "play";
	}
	if (!wanted && playing) {
		return "stop";
	}
	return null;
};

/**
 * Builds the player's command line.
 * @param {object} config the module's config
 * @param {string} config.stream the station's stream address
 * @param {string} config.speaker the ALSA device
 * @param {number} config.volume 0 to 1
 * @returns {{command: string, args: string[]}} what to spawn
 */
const player = ({ stream, speaker, volume }) => {
	const level = Math.min(1, Math.max(0, Number(volume) || 0));
	return {
		command: "ffmpeg",
		args: ["-nostdin", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10", "-i", stream, "-vn", "-af", `volume=${level}`, "-f", "alsa", speaker]
	};
};

module.exports = { DEFAULTS, decide, player };
