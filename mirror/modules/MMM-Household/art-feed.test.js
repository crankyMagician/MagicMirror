// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { picturesIn, syncFeed } = require("./art-feed");

const FEED = "https://art.example/mirror/feed.json";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/**
 * Builds a fetch that serves one feed and counts the picture downloads.
 * @param {object} feed the feed to serve
 * @param {object} [pictures] bytes to serve per picture address, or null for one that is missing
 * @returns {object} the fetch stand-in as `get` and the addresses it was asked for as `calls`
 */
const fakeFetch = (feed, pictures = {}) => {
	const calls = [];
	const get = (url) => {
		calls.push(url);
		if (url === FEED) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(feed) });
		}
		const data = pictures[url] === undefined ? JPEG : pictures[url];
		return Promise.resolve(data === null ? { ok: false, status: 404 } : { ok: true, arrayBuffer: () => Promise.resolve(data) });
	};
	return { get, calls };
};

const tempFolder = (t) => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "art-feed-"));
	t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
	return folder;
};

test("picturesIn keeps HTTPS pictures on the feed's own host", () => {
	const feed = {
		images: [
			{ url: "https://art.example/mirror/01.jpg" },
			{ url: "http://art.example/mirror/02.jpg" },
			{ url: "https://elsewhere.example/03.jpg" },
			{ url: "file:///etc/passwd" },
			{ url: "not an address" },
			{ url: "https://art.example/mirror/01.jpg" },
			{}
		]
	};
	assert.deepEqual(picturesIn(feed, FEED, 10), ["https://art.example/mirror/01.jpg"]);
	assert.deepEqual(picturesIn({ images: "nope" }, FEED, 10), []);
	assert.equal(picturesIn({ images: [{ url: "https://art.example/a.jpg" }, { url: "https://art.example/b.jpg" }] }, FEED, 1).length, 1);
});

test("syncFeed downloads a set once and replaces it when the feed changes", async (t) => {
	const folder = tempFolder(t);
	const images = [{ url: "https://art.example/mirror/01.jpg" }, { url: "https://art.example/mirror/02.jpg" }];
	const first = fakeFetch({ name: "Mix", updated: "week-1", images });

	const one = await syncFeed({ feedUrl: FEED, folder, fetch: first.get });
	assert.deepEqual({ count: one.count, added: one.added, removed: one.removed, name: one.name }, { count: 2, added: 2, removed: 0, name: "Mix" });
	const firstFiles = fs.readdirSync(folder).sort();
	assert.equal(firstFiles.length, 2);

	// The same set again downloads nothing.
	const again = await syncFeed({ feedUrl: FEED, folder, fetch: first.get });
	assert.deepEqual({ count: again.count, added: again.added, removed: again.removed }, { count: 2, added: 0, removed: 0 });
	assert.equal(first.calls.filter((url) => url !== FEED).length, 2);

	// A new set at the same addresses replaces the old files.
	const second = fakeFetch({ name: "Mix", updated: "week-2", images });
	const two = await syncFeed({ feedUrl: FEED, folder, fetch: second.get });
	assert.deepEqual({ count: two.count, added: two.added, removed: two.removed }, { count: 2, added: 2, removed: 2 });
	assert.equal(fs.readdirSync(folder).filter((name) => firstFiles.includes(name)).length, 0);
});

test("syncFeed keeps the old set when the new one cannot be downloaded", async (t) => {
	const folder = tempFolder(t);
	const images = [{ url: "https://art.example/mirror/01.jpg" }];
	await syncFeed({ feedUrl: FEED, folder, fetch: fakeFetch({ updated: "week-1", images }).get });

	const broken = fakeFetch({ updated: "week-2", images }, { "https://art.example/mirror/01.jpg": null });
	const result = await syncFeed({ feedUrl: FEED, folder, fetch: broken.get });
	assert.deepEqual({ count: result.count, added: result.added, removed: result.removed }, { count: 1, added: 0, removed: 0 });
	assert.equal(fs.readdirSync(folder).length, 1);
});

test("syncFeed skips files that are not pictures and refuses bad feeds", async (t) => {
	const folder = tempFolder(t);
	const images = [{ url: "https://art.example/mirror/01.jpg" }, { url: "https://art.example/mirror/02.jpg" }];
	const mixed = fakeFetch({ updated: "week-1", images }, { "https://art.example/mirror/02.jpg": Buffer.from("<html>not found</html>") });
	const result = await syncFeed({ feedUrl: FEED, folder, fetch: mixed.get });
	assert.equal(result.count, 1);

	await assert.rejects(syncFeed({ feedUrl: "http://art.example/feed.json", folder, fetch: mixed.get }), /https/);
	await assert.rejects(syncFeed({ feedUrl: FEED, folder, fetch: fakeFetch({ images: [] }).get }), /no pictures/);
});
