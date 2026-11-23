const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { DEFAULT_BLOCKS, defaultProfile } = require("./profiles");

test("quick profile switches save both themes independently and preserve the feature schedule", async (t) => {
	const people = ["sam", "heather"];
	const profiles = Object.fromEntries(people.map((name) => [name, defaultProfile(["unifi"], DEFAULT_BLOCKS)]));
	const state = { people, profiles, blocks: DEFAULT_BLOCKS, features: [{ key: "unifi", label: "Network devices", owners: people }], enrolled: [], now: { camera: false, block: "day" } };
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
