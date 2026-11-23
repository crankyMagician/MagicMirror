const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { SignInNeeded, accessToken } = require("../../lib/google-token");
const { pickTasks } = require("./tasks");

const API = "https://tasks.googleapis.com/tasks/v1";
const TIMEOUT = 20000;

module.exports = NodeHelper.create({
	start () {
		this.instances = new Map();
	},

	stop () {
		for (const instance of this.instances.values()) {
			clearTimeout(instance.timer);
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "WATCH" || !payload || !payload.id) {
			return;
		}
		const known = this.instances.get(payload.id);
		if (known) {
			// A browser reload asks again. Answer with what we have and keep the one loop.
			known.config = payload;
			if (known.last) {
				this.sendSocketNotification(known.last.notification, known.last.payload);
			}
			return;
		}
		this.instances.set(payload.id, { config: payload, timer: null, last: null });
		this.update(payload.id);
	},

	async update (id) {
		const instance = this.instances.get(id);
		const { tokenFile, credentialsFile, maxTasks, updateMinutes } = instance.config;
		try {
			const token = await accessToken(tokenFile, credentialsFile);
			const lists = await this.get(`${API}/users/@me/lists?maxResults=100`, token);
			const withTasks = [];
			for (const list of lists.items || []) {
				const tasks = await this.get(`${API}/lists/${encodeURIComponent(list.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100`, token);
				withTasks.push({ title: list.title, tasks: tasks.items || [] });
			}
			this.report(id, "TASKS", { id, tasks: pickTasks(withTasks, maxTasks) });
		} catch (error) {
			if (error instanceof SignInNeeded) {
				Log.warn(`${path.basename(String(tokenFile))}: ${error.message}`);
				this.report(id, "TASKS_ERROR", { id, signIn: true });
			} else {
				// A network hiccup. Keep showing the last list and try again.
				Log.warn(`Could not load tasks for ${path.basename(String(tokenFile))}: ${error.message}`);
				if (!instance.last) {
					this.report(id, "TASKS_ERROR", { id, signIn: false });
				}
			}
		}
		instance.timer = setTimeout(() => this.update(id), Math.max(1, updateMinutes) * 60 * 1000);
	},

	report (id, notification, payload) {
		this.instances.get(id).last = { notification, payload };
		this.sendSocketNotification(notification, payload);
	},

	async get (url, token) {
		const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT) });
		if (response.status === 401) {
			throw new SignInNeeded("Google no longer accepts the sign-in");
		}
		if (response.status === 403) {
			throw new SignInNeeded("the sign-in does not include Google Tasks");
		}
		if (!response.ok) {
			throw new Error(`Google Tasks answered ${response.status}`);
		}
		return response.json();
	}
});
