/* MMM-HouseholdTasks
 *
 * Shows the open tasks of one Google account, read-only. Use one instance
 * per account, each with that account's token file:
 *
 *   {
 *     module: "MMM-HouseholdTasks",
 *     classes: "heather",
 *     header: "Tasks",
 *     position: "top_left",
 *     config: {
 *       tokenFile: "/home/pi/mirror-data/google/heather-personal.json",
 *       credentialsFile: "/home/pi/mirror-data/google/credentials.json"
 *     }
 *   }
 *
 * mirror/tools/google-connect.py creates the token file. Until it exists the
 * module says a sign-in is needed and keeps checking.
 */
Module.register("MMM-HouseholdTasks", {
	defaults: {
		tokenFile: "",
		credentialsFile: "",
		// The most tasks to show.
		maxTasks: 6,
		// Minutes between updates.
		updateMinutes: 10,
		// Hide the whole module, header included, when there is nothing to do.
		hideWhenEmpty: false
	},

	start () {
		this.tasks = null;
		this.problem = null;
		this.sendSocketNotification("WATCH", {
			id: this.identifier,
			tokenFile: this.config.tokenFile,
			credentialsFile: this.config.credentialsFile,
			maxTasks: this.config.maxTasks,
			updateMinutes: this.config.updateMinutes
		});
		// Due labels such as "Today" change at midnight without any new data.
		setInterval(() => this.updateDom(0), 30 * 60 * 1000);
	},

	getStyles () {
		return [this.file("MMM-HouseholdTasks.css")];
	},

	getScripts () {
		return [this.file("due.js")];
	},

	socketNotificationReceived (notification, payload) {
		if (!payload || payload.id !== this.identifier) {
			return;
		}
		if (notification === "TASKS") {
			this.tasks = payload.tasks;
			this.problem = null;
		} else if (notification === "TASKS_ERROR") {
			this.problem = payload.signIn ? "Sign in to Google to show these tasks" : "Tasks are not available right now";
		}
		this.updateDom(500);
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "household-tasks small";
		if (this.problem && !this.tasks) {
			wrapper.classList.add("dimmed");
			wrapper.textContent = this.problem;
			return wrapper;
		}
		if (!this.tasks) {
			wrapper.classList.add("dimmed");
			wrapper.textContent = "Loading tasks";
			return wrapper;
		}
		if (this.tasks.length === 0) {
			wrapper.classList.add("dimmed");
			wrapper.textContent = this.config.hideWhenEmpty ? "" : "Nothing to do";
			return wrapper;
		}
		const now = new Date();
		for (const task of this.tasks) {
			const row = document.createElement("div");
			row.className = "household-task";
			const mark = document.createElement("span");
			mark.className = "household-task-mark";
			const title = document.createElement("span");
			title.className = "household-task-title bright";
			title.textContent = task.title;
			row.append(mark, title);
			const due = HouseholdTasksDue.dueLabel(task.due, now);
			if (due.text) {
				const label = document.createElement("span");
				label.className = `household-task-due due-${due.state}`;
				label.textContent = due.text;
				row.append(label);
			}
			wrapper.append(row);
		}
		return wrapper;
	}
});
