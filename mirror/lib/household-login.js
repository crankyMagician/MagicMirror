/* Checks who is signed in on the settings page.
 *
 * The household has a login server of its own. It sets a cookie for the
 * whole home domain, so a browser that signed in there sends the cookie to
 * the mirror as well. The mirror cannot read the cookie's contents and holds
 * no secret of the login server. It hands the cookie back to the login
 * server and asks who it belongs to.
 *
 * Nothing here is specific to one login server beyond two conventions: the
 * session cookie's name, and a "who am I" address that answers 200 with
 * { data: { user: { email } } } for a live session and 401 otherwise.
 */
const crypto = require("node:crypto");

const WHO_AM_I = "/api/v1/auth/me";
const TIMEOUT = 4000;

/**
 * Reads one cookie from a Cookie header.
 * @param {string} header the request's Cookie header
 * @param {string} name the cookie to find
 * @returns {string} its value, or "" when it is absent
 */
const cookieValue = (header, name) => {
	for (const part of String(header || "").split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at).trim() === name) {
			return part.slice(at + 1).trim();
		}
	}
	return "";
};

/**
 * Tells whether a request names this mirror in its Host header. A page on
 * another site that points its own name at the mirror's address (DNS
 * rebinding) still sends its own name, and is refused. A bare address is
 * always accepted, because no outside name can be one.
 * @param {string} hostHeader the request's Host header
 * @param {string[]} names host names the mirror answers to
 * @returns {boolean} true when the request may go on
 */
const hostAllowed = (hostHeader, names) => {
	const host = String(hostHeader || "").trim().toLowerCase();
	if (host === "") {
		return false;
	}
	const bracketed = (/^\[([0-9a-f:.]+)\](?::\d+)?$/).exec(host);
	if (bracketed) {
		return true;
	}
	const name = host.replace(/:\d+$/, "");
	if ((/^\d{1,3}(\.\d{1,3}){3}$/).test(name)) {
		return true;
	}
	return names.map((entry) => String(entry).toLowerCase()).includes(name);
};

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/**
 * Builds the login check for the settings server.
 * @param {object} options how to reach the login server and who is who
 * @param {string} options.authUrl the login server's address, or "" to leave login off
 * @param {string} [options.cookie] the name of the login server's session cookie
 * @param {object} [options.accounts] email address -> person on this mirror
 * @param {number} [options.cacheMs] how long an answer from the login server is reused
 * @param {function(string, object): Promise<object>} [options.fetch] stands in for fetch in tests
 * @param {function(): number} [options.now] stands in for the clock in tests
 * @returns {object} `enabled`, `identify(req)` and Express `middleware`
 */
const createLogin = ({ authUrl = "", cookie = "household_auth", accounts = {}, cacheMs = 60000, fetch: get = fetch, now = Date.now } = {}) => {
	const base = String(authUrl || "").replace(/\/+$/, "");
	const enabled = base !== "";
	const people = Object.fromEntries(Object.entries(accounts || {}).map(([email, person]) => [email.toLowerCase(), person]));
	const cache = new Map();

	/**
	 * Asks the login server whose session a cookie value is.
	 * @param {string} token the cookie's value
	 * @returns {Promise<string|null>} the email address, or null when the session is not live
	 */
	const emailFor = async (token) => {
		const key = crypto.createHash("sha256").update(token).digest("hex");
		const known = cache.get(key);
		if (known && known.until > now()) {
			return known.email;
		}
		const response = await get(`${base}${WHO_AM_I}`, { headers: { Cookie: `${cookie}=${token}` }, signal: AbortSignal.timeout(TIMEOUT), redirect: "error" });
		let email = null;
		if (response.ok) {
			const body = await response.json();
			const found = body && body.data && body.data.user && body.data.user.email;
			email = typeof found === "string" ? found.toLowerCase() : null;
		} else if (response.status !== 401 && response.status !== 403) {
			throw new Error(`the login server answered ${response.status}`);
		}
		if (cache.size > 200) {
			cache.clear();
		}
		// A refusal is remembered only briefly, so signing in takes effect at once.
		cache.set(key, { email, until: now() + (email ? cacheMs : 5000) });
		return email;
	};

	/**
	 * Works out who sent a request.
	 * @param {object} req the Express request
	 * @returns {Promise<object>} `{ status: 200, email, person }`, or a refusal with `status` and `error`
	 */
	const identify = async (req) => {
		if (!enabled) {
			return { status: 200, email: null, person: null };
		}
		// Requests made on the mirror itself are the recovery path.
		if (LOOPBACK.includes(req.socket && req.socket.remoteAddress)) {
			return { status: 200, email: null, person: null, local: true };
		}
		const token = cookieValue(req.headers && req.headers.cookie, cookie);
		if (token === "") {
			return { status: 401, error: "Sign in to use the mirror's settings" };
		}
		let email;
		try {
			email = await emailFor(token);
		} catch {
			return { status: 503, error: "The login server is not answering" };
		}
		if (!email) {
			return { status: 401, error: "Sign in to use the mirror's settings" };
		}
		if (!Object.hasOwn(people, email)) {
			return { status: 403, error: "This account is not one of the mirror's people" };
		}
		return { status: 200, email, person: people[email] };
	};

	const middleware = async (req, res, next) => {
		const who = await identify(req);
		if (who.status !== 200) {
			res.status(who.status).json({ error: who.error, signIn: who.status === 401 });
			return;
		}
		req.login = who;
		next();
	};

	return { enabled, authUrl: base, identify, middleware };
};

/**
 * Tells whether the sender of a request may see and change one person's own
 * settings. A signed-in person may for themselves only. With login off, and
 * for requests made on the mirror itself, there is no signed-in person and
 * everyone's settings are open, as they were before login existed.
 * @param {object} [login] what the login check attached to the request
 * @param {string} person whose settings are asked for
 * @returns {boolean} true when the request may go on
 */
const mayActFor = (login, person) => !login || !login.person || login.person === person;

/**
 * Builds Express middleware that keeps a signed-in person to their own
 * settings.
 * @param {function(object): string} personOf picks the person a request is about
 * @returns {function(object, object, function(): void): void} the middleware
 */
const ownOnly = (personOf) => (req, res, next) => {
	if (!mayActFor(req.login, personOf(req))) {
		res.status(403).json({ error: "You can change only your own settings" });
		return;
	}
	next();
};

module.exports = { cookieValue, createLogin, hostAllowed, mayActFor, ownOnly };
