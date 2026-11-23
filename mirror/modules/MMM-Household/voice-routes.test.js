// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const { SAMPLE, addVoiceRoutes, voicesOn } = require("./voice-routes");

const CONFIG = {
	provider: "cartesia",
	voiceId: "built-in",
	model: "",
	format: "pcm_22050",
	dailyCharacterLimit: 1500,
	maxCachedPhrases: 400,
	voices: [
		{ id: "julia", name: "Julia", about: "British.", provider: "cartesia", voiceId: "voice-julia" },
		{ id: "Bad Id", name: "Nope", provider: "cartesia", voiceId: "x" },
		{ id: "half", name: "No voice id", provider: "cartesia" },
		null
	]
};

test("voicesOn lists usable voices without their provider details", () => {
	assert.deepEqual(voicesOn(CONFIG), [{ id: "julia", name: "Julia", about: "British." }]);
	assert.deepEqual(voicesOn({}), []);
});

/**
 * Serves the preview route with a synthesizer stand-in.
 * @param {object} t the test context
 * @param {function(): Promise<object>} [fail] makes the synthesizer fail with this error
 * @returns {Promise<object>} the server's address and what the synthesizer was asked
 */
const serve = async (t, fail) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-routes-"));
	const file = path.join(directory, "sample.pcm");
	fs.writeFileSync(file, Buffer.alloc(200, 7));
	const asked = [];
	const synth = {
		audioFor: (voice, text) => {
			asked.push({ voice, text });
			return fail ? Promise.reject(fail) : Promise.resolve({ file, cached: false });
		}
	};
	const app = express();
	addVoiceRoutes(app, { speakConfig: () => CONFIG, synth, log: { warn () {} } });
	const server = app.listen(0);
	await new Promise((resolve) => {
		server.once("listening", resolve);
	});
	t.after(() => {
		server.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return { base: `http://127.0.0.1:${server.address().port}`, asked };
};

test("a sample comes back as WAV in the chosen voice, and the built-in voice has one too", async (t) => {
	const { base, asked } = await serve(t);
	const response = await fetch(`${base}/api/voices/julia/preview`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type"), /audio\/wav/);
	const wav = Buffer.from(await response.arrayBuffer());
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.length, 244);
	assert.equal(asked[0].voice.voiceId, "voice-julia");
	assert.equal(asked[0].text, SAMPLE);

	assert.equal((await fetch(`${base}/api/voices/default/preview`)).status, 200);
	assert.equal(asked[1].voice.voiceId, "built-in");
});

test("an unknown voice is a 404 and never reaches the speech service", async (t) => {
	const { base, asked } = await serve(t);
	assert.equal((await fetch(`${base}/api/voices/nobody/preview`)).status, 404);
	assert.equal((await fetch(`${base}/api/voices/half/preview`)).status, 404);
	assert.equal(asked.length, 0);
});

test("a used-up day and a failing service are told apart", async (t) => {
	const spent = await serve(t, new Error("today's limit of 1500 new characters is used up"));
	const first = await fetch(`${spent.base}/api/voices/julia/preview`);
	assert.equal(first.status, 429);
	assert.match((await first.json()).error, /used up today's speech/);
	const down = await serve(t, new Error("the speech service answered 500"));
	assert.equal((await fetch(`${down.base}/api/voices/julia/preview`)).status, 502);
});
