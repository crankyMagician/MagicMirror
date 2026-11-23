const fs = require("node:fs");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { needsRefresh, pickTasks } = require("./tasks");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://tasks.googleapis.com/tasks/v1";
const TIMEOUT = 20000;

/** An error that means the account has to sign in again. */
class SignInNeeded extends Error {}

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
			const accessToken = await this.accessToken(tokenFile, credentialsFile);
			const lists = await this.get(`${API}/users/@me/lists?maxResults=100`, accessToken);
			const withTasks = [];
			for (const list of lists.items || []) {
				const tasks = await this.get(`${API}/lists/${encodeURIComponent(list.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100`, accessToken);
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

	/**
	 * Returns a working access token for one account, refreshing it when needed.
	 * @param {string} tokenFile the account's token file
	 * @param {string} credentialsFile the OAuth client file
	 * @returns {Promise<string>} an access token
	 */
	async accessToken (tokenFile, credentialsFile) {
		let token;
		let client;
		try {
			token = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
		} catch {
			throw new SignInNeeded("no sign-in yet");
		}
		if (!needsRefresh(token, Date.now())) {
			return token.access_token;
		}
		if (!token.refresh_token) {
			throw new SignInNeeded("the stored sign-in cannot be renewed");
		}
		try {
			client = JSON.parse(fs.readFileSync(credentialsFile, "utf8")).installed;
		} catch (error) {
			throw new Error(`cannot read the OAuth client file: ${error.message}`);
		}
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" }),
			signal: AbortSignal.timeout(TIMEOUT)
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			if (body.error === "invalid_grant") {
				throw new SignInNeeded("the sign-in was revoked or has expired");
			}
			throw new Error(`Google answered ${response.status} to the token refresh`);
		}
		const renewed = { ...token, access_token: body.access_token, expiry_date: Date.now() + (body.expires_in || 3600) * 1000 };
		// Re-read before writing, because the calendar module renews the same file.
		try {
			const current = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
			fs.writeFileSync(tokenFile, JSON.stringify({ ...current, access_token: renewed.access_token, expiry_date: renewed.expiry_date }), { mode: 0o600 });
		} catch (error) {
			Log.warn(`Could not save the renewed token: ${error.message}`);
		}
		return renewed.access_token;
	},

	async get (url, accessToken) {
		const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT) });
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
