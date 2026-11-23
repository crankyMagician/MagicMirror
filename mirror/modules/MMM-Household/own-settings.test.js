// Run with: node --test "mirror/**/*.test.js"
// The routes that belong to one person, behind the same guard the settings
// server uses, answered over real HTTP.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const { ownOnly } = require("../../lib/household-login");
const { addArtRoutes } = require("./art-feed");
const { addPhotoRoutes } = require("./photos-routes");

/**
 * Starts a small settings server whose requests come from one signed-in person.
 * @param {object} t the test context
 * @param {string|null} person who is signed in, or null for nobody
 * @returns {Promise<string>} the server's address
 */
const serve = async (t, person) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "own-settings-"));
	const app = express();
	app.use((req, res, next) => {
		req.login = person ? { person } : undefined;
		next();
	});
	const json = express.json();
	const own = ownOnly((req) => req.params.person);
	const quiet = { log () {}, warn () {} };
	addPhotoRoutes(app, { people: () => ["sam", "heather"], accountFor: (name) => name, googleDir: directory, photosDir: directory, guards: [json], own, log: quiet });
	const stopArt = addArtRoutes(app, { feeds: {}, artDir: directory, own, log: quiet });
	const server = app.listen(0);
	await new Promise((resolve) => {
		server.once("listening", resolve);
	});
	t.after(() => {
		stopArt();
		server.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return `http://127.0.0.1:${server.address().port}`;
};

const status = async (url, method = "GET") => (await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" })).status;

test("a signed-in person reaches their own photos and is refused someone else's", async (t) => {
	const base = await serve(t, "heather");
	assert.equal(await status(`${base}/api/photos/heather`), 200);
	assert.equal(await status(`${base}/api/photos/heather/clear`, "POST"), 200);
	assert.equal(await status(`${base}/api/photos/sam`), 403);
	assert.equal(await status(`${base}/api/photos/sam/clear`, "POST"), 403);
	assert.equal(await status(`${base}/api/photos/sam/pick`, "POST"), 403);
	assert.equal(await status(`${base}/api/art/sam`), 403);
	// Their own frame has no feed here, which is a plain 404 and not a refusal.
	assert.equal(await status(`${base}/api/art/heather`), 404);
});

test("with nobody signed in, as on the mirror itself, everyone's photos are open", async (t) => {
	const base = await serve(t, null);
	assert.equal(await status(`${base}/api/photos/sam`), 200);
	assert.equal(await status(`${base}/api/photos/heather`), 200);
});
