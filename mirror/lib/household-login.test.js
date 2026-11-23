// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cookieValue, createLogin, hostAllowed, mayActFor, ownOnly } = require("./household-login");

const AUTH = "https://auth.home.example";
const ACCOUNTS = { "Sam@Example.org": "sam", "heather@example.org": "heather" };

/**
 * Builds a request as the settings server would see it.
 * @param {string} [cookie] the Cookie header
 * @param {string} [remoteAddress] where the request came from
 * @returns {object} the parts of an Express request the check reads
 */
const request = (cookie, remoteAddress = "192.168.10.50") => ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress } });

/**
 * Builds a login server stand-in.
 * @param {object} sessions cookie value -> email address
 * @returns {object} the fetch stand-in as `get` and what it was asked as `calls`
 */
const loginServer = (sessions) => {
	const calls = [];
	const get = (url, options) => {
		calls.push({ url, cookie: options.headers.Cookie });
		const token = options.headers.Cookie.split("=")[1];
		if (token === "boom") {
			return Promise.resolve({ ok: false, status: 500 });
		}
		if (!Object.hasOwn(sessions, token)) {
			return Promise.resolve({ ok: false, status: 401 });
		}
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { user: { email: sessions[token] } } }) });
	};
	return { get, calls };
};

test("cookieValue finds one cookie among several", () => {
	assert.equal(cookieValue("a=1; household_auth=abc.def; b=2", "household_auth"), "abc.def");
	assert.equal(cookieValue("household_auth_old=x; other=y", "household_auth"), "");
	assert.equal(cookieValue(undefined, "household_auth"), "");
	assert.equal(cookieValue("household_auth=a=b=c", "household_auth"), "a=b=c");
});

test("hostAllowed accepts the mirror's names and bare addresses, and refuses other names", () => {
	const names = ["mirror.home.example", "mirror.local", "localhost"];
	assert.equal(hostAllowed("mirror.home.example", names), true);
	assert.equal(hostAllowed("Mirror.Local:8081", names), true);
	assert.equal(hostAllowed("192.168.10.82:8081", names), true);
	assert.equal(hostAllowed("[::1]:8081", names), true);
	assert.equal(hostAllowed("evil.example.net:8081", names), false);
	assert.equal(hostAllowed("192.168.10.82.evil.example.net", names), false);
	assert.equal(hostAllowed("", names), false);
	assert.equal(hostAllowed(undefined, names), false);
});

test("with no login server configured everyone passes, as before", async () => {
	const login = createLogin({ authUrl: "" });
	assert.equal(login.enabled, false);
	assert.deepEqual(await login.identify(request()), { status: 200, email: null, person: null });
});

test("a signed-in account that is one of the mirror's people passes", async () => {
	const server = loginServer({ good: "sam@example.org" });
	const login = createLogin({ authUrl: `${AUTH}/`, accounts: ACCOUNTS, fetch: server.get });
	assert.deepEqual(await login.identify(request("household_auth=good")), { status: 200, email: "sam@example.org", person: "sam" });
	assert.deepEqual(server.calls, [{ url: `${AUTH}/api/v1/auth/me`, cookie: "household_auth=good" }]);
});

test("no cookie, a dead session and an unknown account are refused in three different ways", async () => {
	const server = loginServer({ stranger: "someone@else.example" });
	const login = createLogin({ authUrl: AUTH, accounts: ACCOUNTS, fetch: server.get });
	assert.equal((await login.identify(request())).status, 401);
	assert.equal(server.calls.length, 0);
	assert.equal((await login.identify(request("household_auth=expired"))).status, 401);
	assert.equal((await login.identify(request("household_auth=stranger"))).status, 403);
});

test("a login server that is down or broken closes the door", async () => {
	const login = createLogin({ authUrl: AUTH, accounts: ACCOUNTS, fetch: loginServer({}).get });
	assert.equal((await login.identify(request("household_auth=boom"))).status, 503);
	const down = createLogin({ authUrl: AUTH, accounts: ACCOUNTS, fetch: () => Promise.reject(new Error("no route")) });
	assert.equal((await down.identify(request("household_auth=good"))).status, 503);
});

test("requests made on the mirror itself pass without a cookie", async () => {
	const server = loginServer({});
	const login = createLogin({ authUrl: AUTH, accounts: ACCOUNTS, fetch: server.get });
	for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
		assert.equal((await login.identify(request("", address))).status, 200);
	}
	assert.equal(server.calls.length, 0);
});

test("an answer is reused for a minute, and a refusal only for seconds", async () => {
	let clock = 1000;
	const sessions = { good: "heather@example.org" };
	const server = loginServer(sessions);
	const login = createLogin({ authUrl: AUTH, accounts: ACCOUNTS, fetch: server.get, now: () => clock });
	await login.identify(request("household_auth=good"));
	await login.identify(request("household_auth=good"));
	assert.equal(server.calls.length, 1);
	clock += 61000;
	await login.identify(request("household_auth=good"));
	assert.equal(server.calls.length, 2);

	// Someone who was refused signs in: the refusal must not stick for a minute.
	assert.equal((await login.identify(request("household_auth=later"))).status, 401);
	sessions.later = "sam@example.org";
	clock += 6000;
	assert.equal((await login.identify(request("household_auth=later"))).person, "sam");
});

test("the middleware answers the refusal as JSON and passes a signed-in person on", async () => {
	const login = createLogin({ authUrl: AUTH, accounts: ACCOUNTS, fetch: loginServer({ good: "sam@example.org" }).get });
	const answer = {};
	const res = {
		status (code) {
			answer.code = code;
			return this;
		},
		json (body) {
			answer.body = body;
		}
	};
	let passed = false;
	await login.middleware(request(), res, () => { passed = true; });
	assert.equal(passed, false);
	assert.deepEqual(answer, { code: 401, body: { error: "Sign in to use the mirror's settings", signIn: true } });

	const req = request("household_auth=good");
	await login.middleware(req, res, () => { passed = true; });
	assert.equal(passed, true);
	assert.equal(req.login.person, "sam");
});

test("a signed-in person may act for themselves only", () => {
	assert.equal(mayActFor({ person: "sam", email: "sam@example.org" }, "sam"), true);
	assert.equal(mayActFor({ person: "sam", email: "sam@example.org" }, "heather"), false);
	// Login off, or a request made on the mirror itself: nobody is signed in.
	assert.equal(mayActFor(undefined, "heather"), true);
	assert.equal(mayActFor({ person: null, local: true }, "heather"), true);
});

test("ownOnly refuses a request about someone else and passes one's own", () => {
	const guard = ownOnly((req) => req.params.name);
	const run = (login, name) => {
		const answer = { passed: false };
		const res = {
			status (code) {
				answer.code = code;
				return this;
			},
			json (body) {
				answer.body = body;
			}
		};
		guard({ login, params: { name } }, res, () => {
			answer.passed = true;
		});
		return answer;
	};
	assert.deepEqual(run({ person: "heather" }, "sam"), { passed: false, code: 403, body: { error: "You can change only your own settings" } });
	assert.deepEqual(run({ person: "heather" }, "heather"), { passed: true });
	assert.deepEqual(run(undefined, "sam"), { passed: true });
});
