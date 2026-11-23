// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createSynth } = require("./synth");

const VOICE = { provider: "cartesia", voiceId: "voice-1", model: "sonic-3.5", format: "pcm_22050" };
const LIMITS = { dailyCharacterLimit: 100, maxCachedPhrases: 2 };

/**
 * Builds a synthesizer over a temporary cache and a speech service stand-in.
 * @param {object} t the test context
 * @param {object} [options] how the stand-in behaves
 * @param {boolean} [options.ok] whether the service answers with audio
 * @param {object} [options.env] the environment, with or without the key
 * @returns {object} the synthesizer, the requests it made and its cache folder
 */
const setup = (t, { ok = true, env = { SECRET_CARTESIA_API_KEY: "key" } } = {}) => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-"));
	t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
	const calls = [];
	const post = (url, options) => {
		calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
		return Promise.resolve(ok
			? { ok: true, arrayBuffer: () => Promise.resolve(Buffer.from([1, 2, 3, 4])) }
			: { ok: false, status: 500, text: () => Promise.resolve("boom") });
	};
	const lines = [];
	return { synth: createSynth({ cacheDir, log: { log: (line) => lines.push(line) }, fetch: post, env }), calls, cacheDir, lines };
};

test("a phrase is fetched once and then served from the cache", async (t) => {
	const { synth, calls, lines } = setup(t);
	const first = await synth.audioFor(VOICE, "Hello there.", LIMITS);
	assert.equal(first.cached, false);
	assert.deepEqual([...fs.readFileSync(first.file)], [1, 2, 3, 4]);
	const again = await synth.audioFor(VOICE, "Hello there.", LIMITS);
	assert.deepEqual({ cached: again.cached, file: again.file }, { cached: true, file: first.file });
	assert.equal(calls.length, 1);
	// The same words in another voice are a different phrase.
	const other = await synth.audioFor({ ...VOICE, voiceId: "voice-2" }, "Hello there.", LIMITS);
	assert.notEqual(other.file, first.file);
	assert.equal(calls.length, 2);
	// The log counts characters and never holds the words.
	assert.equal(lines.some((line) => line.includes("Hello")), false);
	assert.match(lines[0], /12 characters \(12 of 100 today\)/);
});

test("new text stops at the daily limit, and cached text does not count", async (t) => {
	const { synth, calls } = setup(t);
	await synth.audioFor(VOICE, "a".repeat(60), LIMITS);
	await assert.rejects(synth.audioFor(VOICE, "b".repeat(50), LIMITS), /limit of 100/);
	assert.equal(calls.length, 1);
	await synth.audioFor(VOICE, "a".repeat(60), LIMITS);
	await synth.audioFor(VOICE, "c".repeat(40), LIMITS);
	assert.equal(calls.length, 2);
});

test("a missing key, a missing voice and a failing service are reported, and nothing is cached", async (t) => {
	const noKey = setup(t, { env: {} });
	await assert.rejects(noKey.synth.audioFor(VOICE, "Hello.", LIMITS), /SECRET_CARTESIA_API_KEY is not set/);
	const { synth, cacheDir } = setup(t, { ok: false });
	await assert.rejects(synth.audioFor({ ...VOICE, voiceId: "" }, "Hello.", LIMITS), /no voice/);
	await assert.rejects(synth.audioFor(VOICE, "Hello.", LIMITS), /answered 500 boom/);
	assert.deepEqual(fs.readdirSync(cacheDir).filter((name) => name.endsWith(".pcm")), []);
	// A failed fetch does not use up the day's characters.
	assert.equal(fs.existsSync(path.join(cacheDir, "usage.json")), false);
});

test("the cache keeps the phrases used most recently", async (t) => {
	const { synth, cacheDir } = setup(t);
	for (const text of ["one", "two", "three"]) {
		await synth.audioFor(VOICE, text, LIMITS);
		await new Promise((resolve) => {
			setTimeout(resolve, 15);
		});
	}
	assert.equal(fs.readdirSync(cacheDir).filter((name) => name.endsWith(".pcm")).length, 2);
});
