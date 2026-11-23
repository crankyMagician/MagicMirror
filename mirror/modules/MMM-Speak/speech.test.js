// Run with: node --test "mirror/modules/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cacheName, prepare, providerFor, retrying, sampleRate, speakerBusy, spend } = require("./speech");

const voice = { provider: "elevenlabs", voiceId: "v1", model: "eleven_flash_v2_5", format: "pcm_22050" };

test("prepare flattens whitespace and control characters", () => {
	assert.equal(prepare("  Good\n morning,\tHeather.  ", 100), "Good morning, Heather.");
	assert.equal(prepare(null, 100), "");
});

test("prepare cuts long text at a sentence end when one is near", () => {
	const text = "It is sunny today. You have two meetings and a dentist appointment this afternoon.";
	assert.equal(prepare(text, 40), "It is sunny today.");
});

test("prepare cuts at a word when no sentence end fits", () => {
	const cut = prepare("one two three four five six seven eight nine ten", 20);
	assert.ok(cut.length <= 20);
	assert.equal(cut, "one two three four");
});

test("the same words in the same voice share one cache file", () => {
	assert.equal(cacheName(voice, "Good night."), cacheName(voice, "Good night."));
	assert.notEqual(cacheName(voice, "Good night."), cacheName(voice, "Good night!"));
	assert.notEqual(cacheName(voice, "Good night."), cacheName({ ...voice, voiceId: "v2" }, "Good night."));
	assert.notEqual(cacheName(voice, "Good night."), cacheName({ ...voice, provider: "cartesia" }, "Good night."));
	assert.match(cacheName(voice, "Good night."), /^[0-9a-f]{32}\.pcm$/);
});

test("spend counts characters per day and refuses past the limit", () => {
	let result = spend(null, 400, 1000, "2026-11-22");
	assert.deepEqual(result, { allowed: true, usage: { day: "2026-11-22", characters: 400 } });
	result = spend(result.usage, 500, 1000, "2026-11-22");
	assert.equal(result.usage.characters, 900);
	result = spend(result.usage, 200, 1000, "2026-11-22");
	assert.equal(result.allowed, false);
	assert.equal(result.usage.characters, 900);
});

test("spend starts again on a new day", () => {
	const result = spend({ day: "2026-11-22", characters: 990 }, 200, 1000, "2026-11-23");
	assert.deepEqual(result, { allowed: true, usage: { day: "2026-11-23", characters: 200 } });
});

test("sampleRate reads PCM formats and refuses others", () => {
	assert.equal(sampleRate("pcm_22050"), 22050);
	assert.throws(() => sampleRate("mp3_44100_128"), /raw PCM only/);
});

test("the ElevenLabs request asks for the configured PCM format", () => {
	const request = providerFor("elevenlabs").request(voice, "Hello.", "KEY");
	assert.equal(request.url, "https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=pcm_22050");
	assert.equal(request.headers["xi-api-key"], "KEY");
	assert.deepEqual(request.body, { text: "Hello.", model_id: "eleven_flash_v2_5", apply_text_normalization: "on" });
});

test("the Cartesia request asks for raw 16-bit PCM at the same rate", () => {
	const request = providerFor("cartesia").request({ ...voice, provider: "cartesia", model: "sonic-3.5" }, "Hello.", "KEY");
	assert.equal(request.url, "https://api.cartesia.ai/tts/bytes");
	assert.equal(request.headers.Authorization, "Bearer KEY");
	assert.equal(request.headers["Cartesia-Version"], "2026-03-01");
	assert.deepEqual(request.body.output_format, { container: "raw", encoding: "pcm_s16le", sample_rate: 22050 });
	assert.deepEqual(request.body.voice, { mode: "id", id: "v1" });
	assert.equal(request.body.transcript, "Hello.");
});

test("an unknown provider is refused by name", () => {
	assert.throws(() => providerFor("festival"), /unknown speech provider "festival"/);
});

test("speakerBusy recognizes a speaker that something else is using", () => {
	assert.equal(speakerBusy(new Error("aplay exited with 1: aplay: main:834: audio open error: Device or resource busy")), true);
	assert.equal(speakerBusy(new Error("aplay exited with 1: No such file or directory")), false);
	assert.equal(speakerBusy(undefined), false);
});

test("retrying waits out a busy speaker and gives up on anything else", async () => {
	const busy = new Error("audio open error: Device or resource busy");
	const pauses = [];
	const sleep = (ms) => {
		pauses.push(ms);
		return Promise.resolve();
	};
	const failing = (error) => () => {
		calls += 1;
		return Promise.reject(error);
	};
	let calls = 0;
	const result = await retrying(() => {
		calls += 1;
		return calls < 3 ? Promise.reject(busy) : Promise.resolve("played");
	}, { attempts: 8, waitMs: 250, when: speakerBusy, sleep });
	assert.equal(result, "played");
	assert.equal(calls, 3);
	assert.deepEqual(pauses, [250, 250]);

	// It stops after the last attempt.
	calls = 0;
	await assert.rejects(retrying(failing(busy), { attempts: 4, waitMs: 1, when: speakerBusy, sleep }), /busy/);
	assert.equal(calls, 4);

	// A failure that waiting cannot fix is not retried.
	calls = 0;
	await assert.rejects(retrying(failing(new Error("no such device")), { attempts: 4, waitMs: 1, when: speakerBusy, sleep }), /no such device/);
	assert.equal(calls, 1);
});
