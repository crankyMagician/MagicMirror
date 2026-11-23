/* Pure helpers for MMM-HouseholdTasks: ordering tasks and judging whether a
 * stored Google token still works. Due-date naming lives in due.js. */

const { dueLabel, localDay } = require("./due");

/**
 * Picks the tasks to show: open, titled, top-level, dated ones first by due
 * date and the rest in the order Google keeps them.
 * @param {object[]} lists task lists as { title, tasks: [...] } in Google's order
 * @param {number} limit the most tasks to return
 * @returns {object[]} tasks as { title, due, list }
 */
const pickTasks = (lists, limit) => {
	const all = [];
	lists.forEach((list, listIndex) => {
		[...(list.tasks || [])]
			.filter((task) => task.status !== "completed" && !task.parent && (task.title || "").trim())
			.sort((a, b) => String(a.position || "").localeCompare(String(b.position || "")))
			.forEach((task, taskIndex) => all.push({ title: task.title.trim(), due: task.due, list: list.title, order: listIndex * 100000 + taskIndex }));
	});
	all.sort((a, b) => {
		if (a.due && b.due) {
			return a.due.localeCompare(b.due) || a.order - b.order;
		}
		if (a.due || b.due) {
			return a.due ? -1 : 1;
		}
		return a.order - b.order;
	});
	return all.slice(0, limit).map(({ title, due, list }) => ({ title, due, list }));
};

/**
 * Tells whether a stored token needs refreshing before use.
 * @param {object} token the stored token
 * @param {number} now the current time in ms
 * @returns {boolean} true when there is no access token or it expires within a minute
 */
const needsRefresh = (token, now) => !token.access_token || !token.expiry_date || token.expiry_date - now < 60 * 1000;

module.exports = { dueLabel, localDay, needsRefresh, pickTasks };
