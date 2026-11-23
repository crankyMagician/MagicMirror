// Run with: node --test "mirror/modules/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cacheName, prepare, providerFor, retrying, sampleRate, scalePcm, speakerBusy, spend, voiceFor, wavFrom } = require("./speech");

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

test("voiceFor picks a listed voice by id and falls back to the configured one", () => {
	const config = {
		provider: "cartesia",
		voiceId: "built-in",
		model: "",
		format: "pcm_22050",
		voices: [{ id: "julia", provider: "cartesia", voiceId: "voice-julia" }, { id: "eleven", provider: "elevenlabs", voiceId: "voice-e", model: "special" }]
	};
	assert.deepEqual(voiceFor(config, "julia"), { provider: "cartesia", voiceId: "voice-julia", model: "sonic-3.5", format: "pcm_22050" });
	assert.equal(voiceFor(config, "eleven").model, "special");
	assert.equal(voiceFor(config, "eleven").provider, "elevenlabs");
	// No choice, or a voice that is no longer offered, gives the built-in voice.
	assert.equal(voiceFor(config, "").voiceId, "built-in");
	assert.equal(voiceFor(config, "gone").voiceId, "built-in");
	assert.equal(voiceFor({ ...config, voices: undefined }, "julia").voiceId, "built-in");
});

test("scalePcm makes samples quieter and leaves full volume alone", () => {
	const pcm = Buffer.alloc(6);
	pcm.writeInt16LE(1000, 0);
	pcm.writeInt16LE(-2000, 2);
	pcm.writeInt16LE(32767, 4);
	const half = scalePcm(pcm, 50);
	assert.deepEqual([half.readInt16LE(0), half.readInt16LE(2), half.readInt16LE(4)], [500, -1000, 16384]);
	assert.equal(scalePcm(pcm, 100), pcm);
	assert.equal(scalePcm(pcm, 0).readInt16LE(4), 0);
	// Out of range is held to the range, and an odd trailing byte is dropped.
	assert.equal(scalePcm(pcm, 250), pcm);
	assert.equal(scalePcm(Buffer.alloc(5), 50).length, 4);
});

test("wavFrom wraps raw audio in a WAV header a browser accepts", () => {
	const wav = wavFrom(Buffer.alloc(100), 22050);
	assert.equal(wav.length, 144);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
	assert.equal(wav.readUInt32LE(4), 136);
	assert.equal(wav.readUInt16LE(22), 1);
	assert.equal(wav.readUInt32LE(24), 22050);
	assert.equal(wav.readUInt32LE(28), 44100);
	assert.equal(wav.readUInt16LE(34), 16);
	assert.equal(wav.readUInt32LE(40), 100);
});
