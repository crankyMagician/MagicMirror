/* Pure helpers for MMM-HouseholdTasks: ordering tasks. Due-date naming lives
 * in due.js and token handling in mirror/lib/google-token.js. */

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

module.exports = { dueLabel, localDay, pickTasks };
