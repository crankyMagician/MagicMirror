// Run with: node --test "mirror/**/*.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createVocabularyCheck, phraseProblem, startsWithPhrase, tidyPhrase } = require("./wake-phrase");

test("tidyPhrase lowers the case and drops punctuation and extra spaces", () => {
	assert.equal(tidyPhrase("  Hey,  Mirror! "), "hey mirror");
	assert.equal(tidyPhrase("MIRROR"), "mirror");
	assert.equal(tidyPhrase("mirror-mirror"), "mirror mirror");
	assert.equal(tidyPhrase(undefined), "");
	assert.equal(tidyPhrase(42), "");
});

test("phraseProblem accepts one to three plain words and refuses the rest", () => {
	for (const good of ["mirror", "hey mirror", "magic mirror please"]) {
		assert.equal(phraseProblem(good), null);
	}
	for (const bad of ["", "a", "one two three four", "mirror2", "hey  mirror", "Hey Mirror", "supercalifragilisticexpialidocious"]) {
		assert.match(phraseProblem(bad), /one to three plain words/);
	}
});

test("startsWithPhrase matches a whole phrase at the start of what was heard", () => {
	assert.equal(startsWithPhrase("hey mirror wake up", "hey mirror"), true);
	assert.equal(startsWithPhrase("mirror wake up", "mirror"), true);
	// The old phrase inside the new one is not a match for the new one, or the other way round.
	assert.equal(startsWithPhrase("hey mirror wake up", "mirror"), false);
	assert.equal(startsWithPhrase("mirrors wake up", "mirror"), false);
	assert.equal(startsWithPhrase("mirror wake up", ""), false);
	assert.equal(startsWithPhrase(undefined, "mirror"), false);
});

/**
 * Builds a stand-in for running the recognizer's check.
 * @param {string} stdout what the recognizer prints
 * @param {Error} [error] the error it ends with
 * @returns {object} the stand-in as `run` and the arguments it was given as `calls`
 */
const runner = (stdout, error = null) => {
	const calls = [];
	const run = (command, args, options, done) => {
		calls.push({ command, args, timeout: options.timeout });
		done(error, stdout);
	};
	return { run, calls };
};

test("the vocabulary check reads the recognizer's answer", async () => {
	const known = runner("{\"type\": \"checked\", \"missing\": []}\n");
	const check = createVocabularyCheck({ python: "/venv/python", script: "/mirror/services/voice.py", run: known.run });
	assert.deepEqual(await check("hey mirror"), []);
	assert.deepEqual(known.calls, [{ command: "/venv/python", args: ["/mirror/services/voice.py", "--check-words", "hey mirror"], timeout: 60000 }]);

	const unknown = runner("some model noise\n{\"type\": \"checked\", \"missing\": [\"jarvis\"]}\n");
	assert.deepEqual(await createVocabularyCheck({ python: "p", script: "s", run: unknown.run })("jarvis"), ["jarvis"]);
});

test("the vocabulary check fails loudly when the recognizer cannot answer", async () => {
	const noModel = runner("{\"type\": \"error\", \"message\": \"Missing speech model\"}\n");
	await assert.rejects(createVocabularyCheck({ python: "p", script: "s", run: noModel.run })("mirror"), /Missing speech model/);
	const crashed = runner("", new Error("spawn ENOENT"));
	await assert.rejects(createVocabularyCheck({ python: "p", script: "s", run: crashed.run })("mirror"), /ENOENT/);
	const silent = runner("nothing useful\n");
	await assert.rejects(createVocabularyCheck({ python: "p", script: "s", run: silent.run })("mirror"), /no answer/);
});
