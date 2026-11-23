/* Lets each person fill a slideshow folder from Google Photos.
 *
 * Google no longer lets an app read a person's albums. What it offers is a
 * picker: the app opens a session, the person chooses photos on a Google
 * page, and the app may then download exactly those. This file runs that
 * flow for the settings page and stores the photos on the Pi, in
 * ~/mirror-data/photos/<person>/, where a slideshow module shows them.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { SignInNeeded, accessToken } = require("../../lib/google-token");

const PICKER = "https://photospicker.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const TIMEOUT = 30000;
const MAX_WAIT = 20 * 60 * 1000;

/**
 * Reads a Google duration such as "5s" or "1.5s" as milliseconds.
 * @param {string} value the duration
 * @param {number} fallback milliseconds to use when it cannot be read
 * @returns {number} milliseconds, between one second and one minute
 */
const durationMs = (value, fallback) => {
	const seconds = Number.parseFloat(String(value || ""));
	const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
	return Math.min(60000, Math.max(1000, ms));
};

const KINDS = ["jpg", "png"];
const isPhotoFile = (name) => KINDS.some((kind) => name.endsWith(`.${kind}`));

/**
 * Names the file a picked photo is stored as. The same photo always gets the
 * same name, so picking it twice does not store it twice.
 * @param {string} id the media item's id
 * @param {string} [kind] the file extension, "jpg" or "png"
 * @returns {string} a file name
 */
const fileNameFor = (id, kind = "jpg") => `${crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 24)}.${kind}`;

/**
 * Tells what kind of picture a download is, from its first bytes. Google
 * sends some picked items back as GIF animations, which the slideshow
 * module cannot read, so only JPEG and PNG are kept.
 * @param {Buffer} data the downloaded bytes
 * @returns {string|null} "jpg", "png", or null for anything else
 */
const imageKind = (data) => {
	if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return "jpg";
	}
	if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "png";
	}
	return null;
};

/**
 * Keeps the picked items that are photos with a download address.
 * @param {object[]} items media items from the Picker API
 * @returns {object[]} items as { id, baseUrl }
 */
const photosIn = (items) => (items || [])
	.filter((item) => item && item.type === "PHOTO" && item.mediaFile && item.mediaFile.baseUrl)
	.map((item) => ({ id: item.id, baseUrl: item.mediaFile.baseUrl }));

const countPhotos = (directory) => {
	try {
		return fs.readdirSync(directory).filter(isPhotoFile).length;
	} catch {
		return 0;
	}
};

/**
 * Adds the photo routes to the settings server.
 * @param {object} app the settings Express app, after its access middleware
 * @param {object} options where things are and who may pick
 * @param {function(): string[]} options.people returns the names on this mirror
 * @param {function(string): string} options.accountFor maps a person to their Google account name
 * @param {string} options.googleDir the folder with the token files and the OAuth client file
 * @param {string} options.photosDir the folder that holds one photo folder per person
 * @param {number} options.maxPhotos the most photos kept per person
 * @param {object[]} options.guards the JSON-only middleware for requests that change something
 * @param {function(object, object, function(): void): void} [options.own] middleware that keeps a signed-in person to their own photos
 * @param {object} options.log a logger with log and warn
 */
const addPhotoRoutes = (app, { people, accountFor, googleDir, photosDir, maxPhotos = 300, guards, own = (req, res, next) => next(), log }) => {
	const state = new Map();
	// The number of the newest photo choice per person. An older choice that
	// was abandoned stops quietly when a newer one starts.
	const newest = new Map();
	const stateOf = (person) => state.get(person) || { picking: false, note: "" };
	const folderOf = (person) => path.join(photosDir, person);
	const tokenFor = (person) => accessToken(path.join(googleDir, `${accountFor(person)}.json`), path.join(googleDir, "credentials.json"), SCOPE);

	const call = async (token, method, route) => {
		const response = await fetch(`${PICKER}${route}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT) });
		if (response.status === 401 || response.status === 403) {
			throw new SignInNeeded("Google refused photo access for this sign-in");
		}
		if (!response.ok) {
			throw new Error(`Google Photos answered ${response.status}`);
		}
		return method === "DELETE" ? {} : response.json();
	};

	const download = async (person, token, photos) => {
		const folder = folderOf(person);
		fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		let added = 0;
		let skipped = 0;
		for (const photo of photos) {
			if (countPhotos(folder) >= maxPhotos) {
				break;
			}
			if (KINDS.some((kind) => fs.existsSync(path.join(folder, fileNameFor(photo.id, kind))))) {
				continue;
			}
			// "=w1600-h1600" asks Google for a copy that fits in 1600 by 1600 pixels.
			const response = await fetch(`${photo.baseUrl}=w1600-h1600`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT) });
			if (!response.ok) {
				log.warn(`A photo for ${person} could not be downloaded: ${response.status}`);
				continue;
			}
			const data = Buffer.from(await response.arrayBuffer());
			const kind = imageKind(data);
			if (!kind) {
				skipped += 1;
				continue;
			}
			const file = path.join(folder, fileNameFor(photo.id, kind));
			fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
			fs.renameSync(`${file}.tmp`, file);
			added += 1;
		}
		return { added, skipped };
	};

	/**
	 * Waits for the person to finish picking, then downloads what they chose.
	 * @param {string} person whose photos these are
	 * @param {object} session the picker session Google opened
	 * @param {number} number this choice's number, so a newer one can replace it
	 */
	const watch = async (person, session, number) => {
		const superseded = () => newest.get(person) !== number;
		const wait = durationMs(session.pollingConfig && session.pollingConfig.pollInterval, 5000);
		const deadline = Date.now() + MAX_WAIT;
		try {
			let current = session;
			while (!current.mediaItemsSet) {
				if (Date.now() > deadline) {
					throw new Error("nobody finished choosing photos in time");
				}
				await new Promise((resolve) => { setTimeout(resolve, wait); });
				if (superseded()) {
					return;
				}
				current = await call(await tokenFor(person), "GET", `/sessions/${encodeURIComponent(session.id)}`);
			}
			const token = await tokenFor(person);
			state.set(person, { picking: true, note: "Copying your photos to the mirror." });
			const photos = [];
			let page = "";
			do {
				const list = await call(token, "GET", `/mediaItems?sessionId=${encodeURIComponent(session.id)}&pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
				photos.push(...photosIn(list.mediaItems));
				page = list.nextPageToken || "";
			} while (page);
			const { added, skipped } = await download(person, token, photos);
			await call(token, "DELETE", `/sessions/${encodeURIComponent(session.id)}`).catch(() => {});
			log.log(`Added ${added} photos for ${person}, skipped ${skipped}`);
			if (!superseded()) {
				const left = skipped > 0 ? ` Left out ${skipped} that ${skipped === 1 ? "is" : "are"} not a still photo.` : "";
				state.set(person, { picking: false, note: `${added === 1 ? "Added 1 photo." : `Added ${added} photos.`}${left}` });
			}
		} catch (error) {
			if (superseded()) {
				return;
			}
			log.warn(`Choosing photos for ${person} did not finish: ${error.message}`);
			state.set(person, { picking: false, note: error instanceof SignInNeeded ? "This account has to sign in again with photo access." : "Choosing photos did not finish. Try again." });
		}
	};

	const known = (req, res, next) => {
		if (!people().includes(req.params.person)) {
			res.status(404).json({ error: "Nobody on this mirror has that name" });
			return;
		}
		next();
	};

	app.get("/api/photos/:person", known, own, (req, res) => {
		res.json({ count: countPhotos(folderOf(req.params.person)), ...stateOf(req.params.person) });
	});

	app.post("/api/photos/:person/pick", known, own, ...guards, async (req, res) => {
		const person = req.params.person;
		try {
			// A new choice replaces one that was opened and never finished.
			const session = await call(await tokenFor(person), "POST", "/sessions");
			const number = (newest.get(person) || 0) + 1;
			newest.set(person, number);
			state.set(person, { picking: true, note: "Waiting for you to choose photos on the Google page." });
			watch(person, session, number);
			// "/autoclose" makes Google close its page once the choice is made.
			res.json({ pickerUri: `${session.pickerUri}/autoclose` });
		} catch (error) {
			if (error instanceof SignInNeeded) {
				res.status(403).json({ error: "This Google account has not allowed photo access yet. Sign it in again with photo access." });
				return;
			}
			log.warn(`Could not open a photo choice for ${person}: ${error.message}`);
			res.status(502).json({ error: "Google Photos is not answering" });
		}
	});

	app.post("/api/photos/:person/clear", known, own, ...guards, (req, res) => {
		const folder = folderOf(req.params.person);
		let removed = 0;
		try {
			for (const name of fs.readdirSync(folder)) {
				if (isPhotoFile(name)) {
					fs.rmSync(path.join(folder, name), { force: true });
					removed += 1;
				}
			}
		} catch {
			// No folder yet means there is nothing to remove.
		}
		log.log(`Removed ${removed} photos for ${req.params.person}`);
		state.set(req.params.person, { picking: stateOf(req.params.person).picking, note: "" });
		res.json({ count: 0 });
	});
};

module.exports = { addPhotoRoutes, durationMs, fileNameFor, imageKind, photosIn };
