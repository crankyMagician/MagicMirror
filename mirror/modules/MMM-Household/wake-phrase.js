/* The words people say before a command, as in "mirror, good morning".
 *
 * The recognizer runs on the Pi with a fixed vocabulary, so a phrase can
 * only work when the speech model knows every word in it. A new phrase is
 * therefore checked against the model first, and then tried out beside the
 * phrase that already works: the mirror listens for both, and the new one
 * takes over only after the mirror has heard it once. A mistyped or badly
 * recognized phrase can never leave the mirror deaf.
 */
const { execFile } = require("node:child_process");

// One to three plain words, each of two letters or more.
const PHRASE_PATTERN = /^[a-z]{2,16}( [a-z]{2,16}){0,2}$/;

/**
 * Tidies what someone typed: lowercase, single spaces, no punctuation.
 * @param {unknown} phrase the typed phrase
 * @returns {string} the tidied phrase
 */
const tidyPhrase = (phrase) => String(typeof phrase === "string" ? phrase : "").toLowerCase().replace(/[^a-z ]+/g, " ").trim()
	.replace(/\s+/g, " ");

/**
 * Checks the shape of a wake phrase.
 * @param {string} phrase a tidied phrase
 * @returns {string|null} what is wrong with it, or null
 */
const phraseProblem = (phrase) => {
	if (!PHRASE_PATTERN.test(phrase)) {
		return "Use one to three plain words of letters only, such as mirror or hey mirror";
	}
	return null;
};

/**
 * Tells whether a heard command began with a phrase.
 * @param {string} text what the recognizer heard, such as "hey mirror wake up"
 * @param {string} phrase a wake phrase
 * @returns {boolean} true when the command started with exactly that phrase
 */
const startsWithPhrase = (text, phrase) => phrase !== "" && String(text || "").startsWith(`${phrase} `);

/**
 * Builds the check that asks the speech model whether it knows a phrase's words.
 * @param {object} options how to run the recognizer's own check
 * @param {string} options.python the Python of the mirror's virtual environment
 * @param {string} options.script the path of services/voice.py
 * @param {function(string, string[], object, function(Error, string): void): void} [options.run] stands in for execFile in tests
 * @returns {function(string): Promise<string[]>} resolves to the words the model does not know
 */
const createVocabularyCheck = ({ python, script, run = execFile }) => (phrase) => new Promise((resolve, reject) => {
	run(python, [script, "--check-words", phrase], { timeout: 60000 }, (error, stdout) => {
		const lines = String(stdout || "").split("\n").filter((line) => line.trim().startsWith("{"));
		for (const line of lines) {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.type === "checked" && Array.isArray(message.missing)) {
				resolve(message.missing.map(String));
				return;
			}
			if (message.type === "error") {
				reject(new Error(message.message));
				return;
			}
		}
		reject(error || new Error("the speech model gave no answer"));
	});
});

module.exports = { createVocabularyCheck, phraseProblem, startsWithPhrase, tidyPhrase };
