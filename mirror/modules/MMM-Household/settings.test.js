const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { DEFAULT_BLOCKS, defaultMirror, defaultProfile } = require("./profiles");

test("quick profile switches save both themes independently and preserve the feature schedule", async (t) => {
	const people = ["sam", "heather"];
	const profiles = Object.fromEntries(people.map((name) => [name, defaultProfile(["unifi"], DEFAULT_BLOCKS)]));
	const state = { people, profiles, blocks: DEFAULT_BLOCKS, mirror: defaultMirror(), features: [{ key: "unifi", label: "Network devices", owners: people }], enrolled: [], now: { camera: false, block: "day" } };
	const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "public/settings.html"), "utf8"), { url: "http://mirror.test", runScripts: "outside-only" });
	t.after(() => dom.window.close());
	dom.window.structuredClone = structuredClone;
	const saved = new Map();
	dom.window.fetch = (url, options) => {
		if (!options?.method) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(structuredClone(state)) });
		}
		const profile = JSON.parse(options.body);
		saved.set(url, profile);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ profile }) });
	};
	dom.window.eval(fs.readFileSync(path.join(__dirname, "public/settings.js"), "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const document = dom.window.document;
	const select = document.getElementById("theme");
	select.value = "light";
	select.dispatchEvent(new dom.window.Event("change"));
	assert.equal(document.documentElement.dataset.theme, "light");
	assert.match(document.getElementById("network-link").href, /theme=light/);
	document.querySelectorAll("#people button")[1].click();
	assert.equal(select.value, "dark");
	const checkbox = document.querySelector("#grid input[aria-label=\"Network devices, day\"]");
	checkbox.checked = false;
	checkbox.dispatchEvent(new dom.window.Event("change"));
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.equal(saved.get("/api/profiles/sam").theme, "light");
	assert.equal(saved.get("/api/profiles/heather").theme, "dark");
	assert.equal(saved.get("/api/profiles/heather").blocks.day.unifi, false);
	assert.equal(saved.get("/api/profiles/sam").blocks.day.unifi, true);
});

test("each person sees the frame section that matches their view: photos or art", async (t) => {
	const people = ["sam", "heather"];
	const features = [{ key: "photos", label: "Photos", owners: ["sam"] }, { key: "art", label: "Art", owners: ["heather"] }];
	const profiles = Object.fromEntries(people.map((name) => [name, defaultProfile(["photos", "art"], DEFAULT_BLOCKS)]));
	const state = { people, profiles, blocks: DEFAULT_BLOCKS, mirror: defaultMirror(), features, enrolled: [], now: { camera: false, block: "day" } };
	const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "public/settings.html"), "utf8"), { url: "http://mirror.test", runScripts: "outside-only" });
	t.after(() => dom.window.close());
	dom.window.structuredClone = structuredClone;
	const asked = [];
	dom.window.fetch = (url) => {
		asked.push(url);
		let body = structuredClone(state);
		if (url.startsWith("/api/art/")) {
			body = { count: 40, name: "Mix", updated: "2026-11-16T19:56:21+00:00", note: "" };
		} else if (url.startsWith("/api/photos/")) {
			body = { count: 3, picking: false, note: "" };
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
	};
	dom.window.eval(fs.readFileSync(path.join(__dirname, "public/settings.js"), "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const document = dom.window.document;
	assert.equal(document.getElementById("photos-section").hidden, false);
	assert.equal(document.getElementById("art-section").hidden, true);
	assert.match(document.getElementById("photos-state").textContent, /3 photos/);

	document.querySelectorAll("#people button")[1].click();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(document.getElementById("photos-section").hidden, true);
	assert.equal(document.getElementById("art-section").hidden, false);
	assert.match(document.getElementById("art-state").textContent, /40 paintings from the set of November 1[56]/);
	assert.equal(asked.includes("/api/photos/heather"), false);
	assert.equal(asked.includes("/api/art/sam"), false);
});

test("the Mirror tab saves quiet hours and day-part times for the mirror, not for a person", async (t) => {
	const people = ["sam", "heather"];
	const profiles = Object.fromEntries(people.map((name) => [name, defaultProfile(["clock"], DEFAULT_BLOCKS)]));
	const state = { people, profiles, blocks: DEFAULT_BLOCKS, mirror: defaultMirror(), features: [{ key: "clock", label: "Clock", owners: [] }], enrolled: [], now: { camera: false, block: "day" } };
	const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "public/settings.html"), "utf8"), { url: "http://mirror.test", runScripts: "outside-only" });
	t.after(() => dom.window.close());
	dom.window.structuredClone = structuredClone;
	const saved = [];
	dom.window.fetch = (url, options) => {
		if (!options?.method) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(structuredClone(state)) });
		}
		const body = JSON.parse(options.body);
		saved.push({ url, method: options.method, body });
		return Promise.resolve({ ok: true, json: () => Promise.resolve(url === "/api/mirror" ? { mirror: body } : { profile: body }) });
	};
	dom.window.eval(fs.readFileSync(path.join(__dirname, "public/settings.js"), "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const document = dom.window.document;
	const change = (element) => element.dispatchEvent(new dom.window.Event("change"));

	// A person's page has no quiet hours any more.
	assert.equal(document.getElementById("person-view").hidden, false);
	assert.equal(document.getElementById("mirror-view").hidden, true);
	assert.equal(document.getElementById("person-view").contains(document.getElementById("quiet-enabled")), false);

	const tabs = document.querySelectorAll("#people button");
	assert.equal(tabs.length, 3);
	assert.equal(tabs[2].textContent, "Mirror");
	tabs[2].click();
	assert.equal(document.getElementById("person-view").hidden, true);
	assert.equal(document.getElementById("mirror-view").hidden, false);
	assert.equal(document.querySelectorAll("#people button")[2].getAttribute("aria-pressed"), "true");
	assert.equal(document.querySelectorAll("#people button")[0].getAttribute("aria-pressed"), "false");

	const enabled = document.getElementById("quiet-enabled");
	enabled.checked = true;
	change(enabled);
	const from = document.getElementById("quiet-from");
	assert.equal(from.disabled, false);
	from.value = "22:15";
	change(from);
	const parts = document.querySelectorAll("#parts input[type=time]");
	assert.equal(parts.length, 4);
	assert.match(document.querySelector("#parts label").textContent, /Morning starts at/);
	parts[0].value = "06:30";
	change(parts[0]);
	await new Promise((resolve) => setTimeout(resolve, 450));

	// The three changes go out as one save, to the mirror and to no profile.
	assert.equal(saved.length, 1);
	assert.equal(saved[0].url, "/api/mirror");
	assert.equal(saved[0].method, "PUT");
	assert.deepEqual(saved[0].body.quietHours, { enabled: true, from: "22:15", to: "06:00" });
	assert.deepEqual(saved[0].body.blocks.map((block) => [block.key, block.from]), [["morning", "06:30"], ["day", "11:00"], ["evening", "17:00"], ["night", "22:00"]]);

	// Back on a person's page, the schedule shows the new start time.
	document.querySelectorAll("#people button")[0].click();
	assert.equal(document.getElementById("mirror-view").hidden, true);
	assert.match(document.querySelector("#grid thead").textContent, /6:30 am to 11 am/);
});

/**
 * Loads the settings page with a mirror that has login switched on.
 * @param {object} t the test context
 * @param {object} session what GET /api/session answers
 * @param {string} [url] the address the page is opened at
 * @returns {Promise<object>} the page's document and every request it made
 */
const loadWithLogin = async (t, session, url = "https://mirror.home.example/") => {
	const people = ["sam", "heather"];
	const profiles = Object.fromEntries(people.map((name) => [name, defaultProfile(["clock"], DEFAULT_BLOCKS)]));
	const state = { people, profiles, blocks: DEFAULT_BLOCKS, mirror: defaultMirror(), features: [{ key: "clock", label: "Clock", owners: [] }], enrolled: [], now: { camera: false, block: "day" } };
	const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "public/settings.html"), "utf8"), { url, runScripts: "outside-only" });
	t.after(() => dom.window.close());
	dom.window.structuredClone = structuredClone;
	const asked = [];
	dom.window.fetch = (address, options = {}) => {
		asked.push({ address, method: options.method || "GET", credentials: options.credentials, body: options.body });
		if (address === "/api/session") {
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(session) });
		}
		if (String(address).startsWith("https://auth.home.example")) {
			const ok = String(address).endsWith("/login") && JSON.parse(options.body).password === "right";
			return Promise.resolve({ ok, status: ok ? 200 : 401, json: () => Promise.resolve(ok ? { data: { user: { email: "sam@example.org" } } } : { error: { message: "Invalid credentials" } }) });
		}
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(state)) });
	};
	dom.window.eval(fs.readFileSync(path.join(__dirname, "public/settings.js"), "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	return { document: dom.window.document, window: dom.window, asked };
};

const LOGIN_ON = { login: true, signedIn: false, refused: false, problem: "Sign in to use the mirror's settings", email: null, person: null, authUrl: "https://auth.home.example", home: "https://mirror.home.example/" };

test("with login on and nobody signed in, the page shows only the sign-in form", async (t) => {
	const { document, window, asked } = await loadWithLogin(t, LOGIN_ON);
	assert.equal(document.getElementById("signin").hidden, false);
	assert.equal(document.getElementById("signin-ways").hidden, false);
	assert.equal(document.getElementById("people").hidden, true);
	assert.equal(document.getElementById("person-view").hidden, true);
	assert.equal(document.getElementById("signin-google").href, "https://auth.home.example/api/v1/auth/google");
	// Nothing was asked of the mirror beyond the session.
	assert.deepEqual(asked.map((entry) => entry.address), ["/api/session"]);

	// A wrong password shows the login server's message. The password goes to the login server only.
	document.getElementById("signin-email").value = " Sam@Example.org ";
	document.getElementById("signin-password").value = "wrong";
	document.getElementById("signin-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(document.getElementById("signin-note").textContent, "Invalid credentials");
	const sent = asked.at(-1);
	assert.equal(sent.address, "https://auth.home.example/api/v1/auth/login");
	assert.equal(sent.credentials, "include");
	assert.deepEqual(JSON.parse(sent.body), { identifier: "sam@example.org", password: "wrong" });
});

test("opened at a bare address, the page points to the mirror's own name to sign in", async (t) => {
	const { document } = await loadWithLogin(t, LOGIN_ON, "http://192.168.10.82:8081/");
	assert.equal(document.getElementById("signin-ways").hidden, true);
	assert.equal(document.getElementById("signin-home").hidden, false);
	assert.equal(document.getElementById("signin-home").href, "https://mirror.home.example/");
	assert.match(document.getElementById("signin-home").textContent, /mirror\.home\.example/);
});

test("a Google account that is not one of the mirror's people gets a plain reason", async (t) => {
	const { document } = await loadWithLogin(t, LOGIN_ON, "https://mirror.home.example/login?error=OAUTH_ACCOUNT_NOT_FOUND");
	assert.match(document.getElementById("signin-note").textContent, /not one of the mirror's people/);
});

test("a signed-in person sees their own settings and a way to sign out", async (t) => {
	const { document } = await loadWithLogin(t, { ...LOGIN_ON, signedIn: true, problem: null, email: "heather@example.org", person: "heather" });
	assert.equal(document.getElementById("signin").hidden, true);
	assert.equal(document.getElementById("account").hidden, false);
	assert.match(document.getElementById("account").textContent, /Signed in as heather@example\.org/);
	assert.equal(document.querySelectorAll("#people button")[1].getAttribute("aria-pressed"), "true");
});
