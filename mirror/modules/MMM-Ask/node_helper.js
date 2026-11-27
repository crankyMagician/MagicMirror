const NodeHelper = require("node_helper");
const Log = require("logger");
const { buildRequest, dailyLimit, memory, readAnswer } = require("./ask");

/* Asks Claude the questions that nothing else on the mirror could answer.
 *
 * The key is SECRET_ANTHROPIC_KEY in config.env and stays here. The page
 * sends the question and a short note about the household, and gets back
 * the words to speak. */

const SAY = {
	refused: "I cannot help with that one.",
	failed: "I could not get an answer just now.",
	limit: "That is enough questions for today. Ask me again tomorrow.",
	empty: "I do not have an answer for that."
};

module.exports = NodeHelper.create({
	start () {
		this.client = null;
		this.config = null;
		this.memory = memory();
		this.allowed = null;
		this.busy = false;
	},

	/**
	 * Makes the client once, the first time it is needed.
	 * @returns {object|null} the Anthropic client, or null without a key
	 */
	anthropic () {
		const key = (process.env.SECRET_ANTHROPIC_KEY || "").trim();
		if (!key) {
			return null;
		}
		if (!this.client) {
			const Anthropic = require("@anthropic-ai/sdk");
			this.client = new Anthropic({ apiKey: key, timeout: 20000, maxRetries: 1 });
		}
		return this.client;
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CONFIG") {
			this.config = payload;
			this.allowed = dailyLimit(Number(payload.questionsPerDay) || 200);
			if (!this.anthropic()) {
				Log.warn("MMM-Ask is idle: set SECRET_ANTHROPIC_KEY in config.env");
			}
		} else if (notification === "ASK" && payload && typeof payload.question === "string" && payload.question.trim()) {
			this.ask(payload);
		} else if (notification === "FORGET") {
			this.memory.clear();
		}
	},

	/**
	 * Answers one question and sends the words back to the page.
	 * @param {object} payload what the page asks
	 * @param {string} payload.id names the answer, so the page can match it
	 * @param {string} payload.question the sentence, without the wake word
	 * @param {string|null} payload.person the person at the mirror, for the conversation
	 * @param {object} payload.context the note about the household, see contextNote in ask.js
	 */
	async ask ({ id, question, person = null, context = {} }) {
		const reply = (answer) => this.sendSocketNotification("ANSWER", { id, question, ...answer });
		const client = this.anthropic();
		if (!client || !this.allowed) {
			reply({ text: SAY.failed, sources: [], failed: true });
			return;
		}
		if (this.busy) {
			Log.log(`Skipped "${question}" while another question is answered`);
			return;
		}
		if (!this.allowed()) {
			reply({ text: SAY.limit, sources: [], failed: true });
			return;
		}
		this.busy = true;
		const asked = String(question).trim().slice(0, 500);
		const started = Date.now();
		try {
			const request = buildRequest({ question: asked, context, history: this.memory.messages(person), searches: this.config.searches });
			let message = await client.messages.create(request);
			// A turn with web searches can pause. Sending it back lets it go on.
			for (let more = 0; more < 2 && message.stop_reason === "pause_turn"; more++) {
				request.messages = [...request.messages, { role: "assistant", content: message.content }];
				message = await client.messages.create(request);
			}
			const answer = readAnswer(message);
			const usage = message.usage || {};
			const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
			Log.log(`Asked "${asked}" in ${((Date.now() - started) / 1000).toFixed(1)} s: ${usage.input_tokens || 0} in, ${usage.output_tokens || 0} out, ${searches} searches, stop ${message.stop_reason}`);
			if (answer.refused) {
				reply({ text: SAY.refused, sources: [] });
			} else if (!answer.text) {
				reply({ text: SAY.empty, sources: [] });
			} else {
				this.memory.add(person, asked, answer.text);
				reply({ text: answer.text, sources: answer.sources });
			}
		} catch (error) {
			Log.warn(`Could not ask "${asked}": ${error.status ? `${error.status} ` : ""}${error.message}`);
			reply({ text: SAY.failed, sources: [], failed: true });
		} finally {
			this.busy = false;
		}
	}
});
