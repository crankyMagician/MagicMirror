const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const express = require("express");
const { addUniFiRoutes } = require("./unifi-routes");

test("phone bridge only serves fixed UniFi GET routes without forwarding credentials", async (t) => {
	const requests = [];
	const upstream = http.createServer((req, res) => {
		requests.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ clients: [] }));
	});
	await new Promise((resolve) => upstream.listen(0, resolve));
	t.after(() => upstream.close());
	const app = express();
	addUniFiRoutes(app, { port: upstream.address().port });
	const server = app.listen(0);
	t.after(() => server.close());
	const base = `http://localhost:${server.address().port}`;
	const response = await fetch(`${base}/unifi/api/snapshot?url=https://untrusted.invalid`, { headers: { Cookie: "secret=test", Authorization: "Bearer test" } });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { clients: [] });
	assert.deepEqual(requests, [{ path: "/unifi/api/snapshot", authorization: undefined, cookie: undefined }]);
	assert.equal((await fetch(`${base}/unifi/`)).status, 200);
	assert.equal((await fetch(`${base}/unifi`, { redirect: "manual" })).status, 302);
	assert.equal((await fetch(`${base}/unifi/api/snapshot`, { method: "POST" })).status, 404);
	assert.equal((await fetch(`${base}/unifi/config/config.env`)).status, 404);
	assert.equal((await fetch(`${base}/unifi/assets/credentials.json`)).status, 404);
});
