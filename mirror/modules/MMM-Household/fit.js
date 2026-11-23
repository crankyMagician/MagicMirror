/* Decides which modules of a column are shown when they do not all fit.
 *
 * The mirror's page has two columns of fixed height. Modules stack in a
 * column in the order of the config. When their heights add up to more than
 * the column holds, the ones that do not fit wait, and the column gives them
 * a turn later. Pinned modules never wait.
 *
 * This one file serves both sides: the browser loads it as a script and gets
 * HouseholdFit, and Node requires it in the tests. It only does arithmetic.
 *
 * It also works out where a single module goes when someone asks to see only
 * that one ("mirror, show only the calendar").
 */
(function (root) {

	/**
	 * Packs a column.
	 * @param {object} column what to pack
	 * @param {object[]} column.items the column's modules in display order, each as { id, height, pinned }. The height includes the gap under the module.
	 * @param {number} column.available the column's height
	 * @param {number} [column.start] where this turn starts among the modules that are not pinned
	 * @returns {{shown: string[], waiting: string[], next: number}} the ids to show and to hide, and the start of the next turn
	 */
	const pack = ({ items, available, start = 0 }) => {
		const shown = new Set();
		let left = Math.max(0, available);
		// A pinned module is in every turn. One that is taller than what is
		// left still shows, cut off at the column's edge, when it is the first.
		for (const item of items.filter((entry) => entry.pinned)) {
			if (item.height <= left || shown.size === 0) {
				shown.add(item.id);
				left = Math.max(0, left - item.height);
			}
		}
		const turning = items.filter((entry) => !entry.pinned);
		const count = turning.length;
		const first = count === 0 ? 0 : ((start % count) + count) % count;
		// The room that the turning modules share. A module taller than that
		// could never fit, so it counts as exactly that tall and shows alone.
		const room = left;
		let next = first;
		let missed = false;
		for (let step = 0; step < count; step++) {
			const index = (first + step) % count;
			const item = turning[index];
			const height = Math.min(item.height, room);
			if (height <= left && (room > 0 || shown.size === 0)) {
				shown.add(item.id);
				left -= height;
			} else if (!missed) {
				// The next turn starts with the first module this one left out.
				missed = true;
				next = index;
			}
		}
		return {
			shown: items.filter((entry) => shown.has(entry.id)).map((entry) => entry.id),
			waiting: items.filter((entry) => !shown.has(entry.id)).map((entry) => entry.id),
			next: missed ? next : first
		};
	};

	/**
	 * Works out how to move a box to the middle of the screen and enlarge it.
	 * @param {object} box where the box is now: left, top, width and height in pixels
	 * @param {object} screen the screen's width and height in pixels
	 * @param {object} [limits] how far to go
	 * @param {number} [limits.maxScale] the most to enlarge by
	 * @param {number} [limits.widthShare] the most of the screen's width to fill
	 * @param {number} [limits.heightShare] the most of the screen's height to fill
	 * @returns {{x: number, y: number, scale: number}} the shift of the box's center and the scale around that center
	 */
	const center = (box, screen, { maxScale = 1.8, widthShare = 0.9, heightShare = 0.8 } = {}) => {
		if (!(box.width > 0) || !(box.height > 0)) {
			return { x: 0, y: 0, scale: 1 };
		}
		const scale = Math.min(maxScale, (screen.width * widthShare) / box.width, (screen.height * heightShare) / box.height);
		return {
			x: Math.round(screen.width / 2 - (box.left + box.width / 2)),
			y: Math.round(screen.height / 2 - (box.top + box.height / 2)),
			scale: Math.round(scale * 1000) / 1000
		};
	};

	const api = { center, pack };
	root.HouseholdFit = api;
	if (typeof module !== "undefined") {
		module.exports = api;
	}
}(typeof window === "undefined" ? globalThis : window));
