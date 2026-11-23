/* Which way the picture faces on the screen.
 *
 * The kiosk runs under sway, and sway turns the picture with
 * `output * transform VALUE`. /etc/magicmirror-kiosk/output.conf sets the
 * direction sway starts with. A direction saved on the settings page is
 * applied on top of that, at start and whenever it changes.
 */

// The directions on offer, as sway names them, with the page's words for them.
const ROTATIONS = [
	{ value: "90", label: "Tall" },
	{ value: "270", label: "Tall, turned around" },
	{ value: "normal", label: "Wide" },
	{ value: "180", label: "Wide, turned around" }
];

const VALUES = ROTATIONS.map((rotation) => rotation.value);

/**
 * Tells whether a value is a direction the mirror can be set to. The empty
 * string means that nothing was chosen and output.conf decides.
 * @param {unknown} value what was stored or submitted
 * @returns {boolean} true for "" and for each direction on offer
 */
const validRotation = (value) => value === "" || VALUES.includes(value);

/**
 * Builds the arguments for swaymsg that turn every output.
 * @param {string} rotation one of the directions on offer
 * @returns {string[]} the arguments
 */
const swayArguments = (rotation) => {
	if (!VALUES.includes(rotation)) {
		throw new Error(`"${rotation}" is not a direction the screen can face`);
	}
	return ["output", "*", "transform", rotation];
};

/**
 * Reads the direction of the screen from `swaymsg -t get_outputs -r`.
 * @param {string} json sway's answer
 * @returns {string} the direction of the first output that is switched on, or "" when none is on or sway reports something else
 */
const currentRotation = (json) => {
	let outputs;
	try {
		outputs = JSON.parse(json);
	} catch {
		return "";
	}
	const active = (Array.isArray(outputs) ? outputs : []).find((output) => output && output.active && typeof output.transform === "string");
	return active && VALUES.includes(active.transform) ? active.transform : "";
};

module.exports = { ROTATIONS, currentRotation, swayArguments, validRotation };
