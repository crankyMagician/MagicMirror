/* Fills a person's picture frame from a published feed of paintings.
 *
 * A feed is a JSON file such as the ones built by
 * https://github.com/crankyMagician/tv-art:
 *
 *   { "name": "...", "updated": "2026-11-16T19:56:21+00:00",
 *     "images": [{ "url": "https://.../01.jpg", "title": "...", "artist": "..." }] }
 *
 * The pictures are copied to ~/mirror-data/art/<person>/ on the Pi, where a
 * slideshow module shows them. When the feed publishes a new set, the new
 * pictures are downloaded first and the old ones are removed after.
 */
const fs = require("node:fs");
const path = require("node:path");
const { fileNameFor, imageKind } = require("./photos-routes");

const TIMEOUT = 30000;
const MAX_BYTES = 15 * 1024 * 1024;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const RETRY_AFTER = 10 * 60 * 1000;

/**
 * Lists the pictures of a feed that the mirror is willing to download: HTTPS
 * addresses on the same host as the feed itself.
 * @param {object} feed the parsed feed
 * @param {string} feedUrl where the feed came from
 * @param {number} max the most pictures to keep
 * @returns {string[]} picture addresses
 */
const picturesIn = (feed, feedUrl, max) => {
	const host = new URL(feedUrl).host;
	const urls = [];
	for (const image of (feed && Array.isArray(feed.images) ? feed.images : [])) {
		let url;
		try {
			url = new URL(image.url);
		} catch {
			continue;
		}
		if (url.protocol === "https:" && url.host === host && !urls.includes(url.href)) {
			urls.push(url.href);
		}
	}
	return urls.slice(0, max);
};

/**
 * Names the file a feed picture is stored as. A feed reuses its addresses
 * from one set to the next, so the set's date is part of the name.
 * @param {string} updated the feed's date stamp
 * @param {string} url the picture's address
 * @param {string} kind "jpg" or "png"
 * @returns {string} a file name
 */
const pictureName = (updated, url, kind) => fileNameFor(`${updated}\n${url}`, kind);

const countPictures = (folder) => {
	try {
		return fs.readdirSync(folder).filter((name) => name.endsWith(".jpg") || name.endsWith(".png")).length;
	} catch {
		return 0;
	}
};

/**
 * Brings one folder in line with one feed.
 * @param {object} options what to fetch and where to put it
 * @param {string} options.feedUrl the feed's HTTPS address
 * @param {string} options.folder the folder to fill
 * @param {number} [options.max] the most pictures to keep
 * @param {Function} [options.fetch] stands in for fetch in tests
 * @returns {Promise<object>} the feed's name and date, and how many pictures the folder holds, were added and were removed
 */
const syncFeed = async ({ feedUrl, folder, max = 100, fetch: get = fetch }) => {
	if (new URL(feedUrl).protocol !== "https:") {
		throw new Error("the feed address must start with https://");
	}
	const response = await get(feedUrl, { signal: AbortSignal.timeout(TIMEOUT) });
	if (!response.ok) {
		throw new Error(`the feed answered ${response.status}`);
	}
	const feed = await response.json();
	const updated = String(feed.updated || "");
	const urls = picturesIn(feed, feedUrl, max);
	if (urls.length === 0) {
		throw new Error("the feed lists no pictures");
	}

	fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
	const keep = new Set();
	let added = 0;
	for (const url of urls) {
		const known = ["jpg", "png"].map((kind) => pictureName(updated, url, kind)).find((name) => fs.existsSync(path.join(folder, name)));
		if (known) {
			keep.add(known);
			continue;
		}
		const picture = await get(url, { signal: AbortSignal.timeout(TIMEOUT) });
		if (!picture.ok) {
			continue;
		}
		const data = Buffer.from(await picture.arrayBuffer());
		const kind = imageKind(data);
		if (!kind || data.length > MAX_BYTES) {
			continue;
		}
		const name = pictureName(updated, url, kind);
		fs.writeFileSync(path.join(folder, `${name}.tmp`), data, { mode: 0o600 });
		fs.renameSync(path.join(folder, `${name}.tmp`), path.join(folder, name));
		keep.add(name);
		added += 1;
	}

	// Keep the old set when the new one did not arrive, so the frame is never empty.
	let removed = 0;
	if (keep.size > 0) {
		for (const name of fs.readdirSync(folder)) {
			if (!keep.has(name)) {
				fs.rmSync(path.join(folder, name), { force: true });
				removed += 1;
			}
		}
	}
	return { name: String(feed.name || ""), updated, count: countPictures(folder), added, removed };
};

/**
 * Keeps each person's art folder current and tells the settings page about it.
 * @param {object} app the settings Express app, after its access middleware
 * @param {object} options where things are
 * @param {object} options.feeds person -> feed address
 * @param {string} options.artDir the folder that holds one art folder per person
 * @param {object} options.log a logger with log and warn
 * @returns {Function} call it to stop checking the feeds
 */
const addArtRoutes = (app, { feeds, artDir, log }) => {
	const state = new Map();
	const timers = new Map();

	const check = async (person) => {
		let wait = CHECK_EVERY;
		try {
			const result = await syncFeed({ feedUrl: feeds[person], folder: path.join(artDir, person) });
			state.set(person, { count: result.count, name: result.name, updated: result.updated, note: "" });
			if (result.added > 0 || result.removed > 0) {
				log.log(`Art for ${person}: ${result.count} pictures, ${result.added} new, ${result.removed} removed`);
			}
		} catch (error) {
			log.warn(`The art feed for ${person} could not be read: ${error.message}`);
			// The frame keeps showing what it already has.
			state.set(person, { name: "", updated: "", ...state.get(person), count: countPictures(path.join(artDir, person)), note: "The mirror could not reach the art feed. It will try again." });
			wait = RETRY_AFTER;
		}
		const timer = setTimeout(() => check(person), wait);
		timer.unref();
		timers.set(person, timer);
	};

	for (const person of Object.keys(feeds)) {
		check(person);
	}

	app.get("/api/art/:person", (req, res) => {
		if (!Object.hasOwn(feeds, req.params.person)) {
			res.status(404).json({ error: "This person has no art feed" });
			return;
		}
		res.json(state.get(req.params.person) || { count: 0, name: "", updated: "", note: "Fetching the first pictures." });
	});

	return () => timers.forEach((timer) => clearTimeout(timer));
};

module.exports = { addArtRoutes, pictureName, picturesIn, syncFeed };
