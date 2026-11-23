// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { SignInNeeded, accessToken, hasScope, needsRefresh } = require("./google-token");

test("needsRefresh is true for a missing or nearly expired access token", () => {
	const at = 1_000_000_000_000;
	assert.equal(needsRefresh({ refresh_token: "r" }, at), true);
	assert.equal(needsRefresh({ access_token: "a", expiry_date: at + 30 * 1000 }, at), true);
	assert.equal(needsRefresh({ access_token: "a", expiry_date: at + 10 * 60 * 1000 }, at), false);
});

test("hasScope reads the token's space-separated scope list", () => {
	const token = { scope: "https://a.example/one https://a.example/two" };
	assert.equal(hasScope(token, "https://a.example/two"), true);
	assert.equal(hasScope(token, "https://a.example/tw"), false);
	assert.equal(hasScope({}, "https://a.example/two"), false);
});

test("accessToken asks for a sign-in when the token file is missing", async () => {
	await assert.rejects(accessToken("/nonexistent/token.json", "/nonexistent/credentials.json"), SignInNeeded);
});

test("accessToken returns a still-valid token without calling Google, and checks the scope", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "google-token-"));
	const file = path.join(directory, "token.json");
	fs.writeFileSync(file, JSON.stringify({ access_token: "abc", expiry_date: Date.now() + 30 * 60 * 1000, scope: "https://a.example/one" }));
	assert.equal(await accessToken(file, "/nonexistent/credentials.json"), "abc");
	assert.equal(await accessToken(file, "/nonexistent/credentials.json", "https://a.example/one"), "abc");
	await assert.rejects(accessToken(file, "/nonexistent/credentials.json", "https://a.example/photos"), SignInNeeded);
	fs.rmSync(directory, { recursive: true });
});
