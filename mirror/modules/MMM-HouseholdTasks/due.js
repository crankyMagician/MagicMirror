/* Names due dates. This one file serves both sides: the browser loads it as
 * a script and gets HouseholdTasksDue, and Node requires it from tasks.js. */
(function (root) {
	const DAY = 24 * 60 * 60 * 1000;

	// The local calendar date of a moment, as YYYY-MM-DD.
	const localDay = (date) => {
		const pad = (number) => String(number).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	};
	// Names a task's due date relative to today. Google Tasks stores a due date
	// as midnight UTC of that day, so only the date part means anything.
	// Returns a short text and a state: overdue, today, soon, later or none.
	const dueLabel = (due, now) => {
		if (!due) {
			return { text: "", state: "none" };
		}
		const dueDay = due.slice(0, 10);
		const today = localDay(now);
		const days = Math.round((Date.parse(`${dueDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
		if (days < 0) {
			return { text: "Overdue", state: "overdue" };
		}
		if (days === 0) {
			return { text: "Today", state: "today" };
		}
		if (days === 1) {
			return { text: "Tomorrow", state: "soon" };
		}
		const date = new Date(`${dueDay}T12:00:00Z`);
		const text = days < 7
			? date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
			: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
		return { text, state: days < 7 ? "soon" : "later" };
	};
	root.HouseholdTasksDue = { dueLabel, localDay };
	if (typeof module !== "undefined") {
		module.exports = { dueLabel, localDay };
	}
}(typeof window === "undefined" ? globalThis : window));
