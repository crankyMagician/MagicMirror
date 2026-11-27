/* What MMM-Ask sends to Claude and how it reads the answer. No network here,
 * so the tests can run it as it is. */

const MODEL = "claude-haiku-5-5";

// Fixed, so the start of every request is the same and can be cached.
const SYSTEM = [
	"You are the voice of a smart mirror in a family's home in Las Vegas, Nevada. People talk to it from across the room, and your answer is read aloud by a speech voice.",
	"Answer in one or two short sentences that sound natural when spoken. Use plain words. Do not use lists, headings, markdown, links, emoji or parenthetical asides. Write numbers, dates and times the way a person would say them.",
	"Search the web when the answer depends on recent or local facts, such as news, scores, opening hours, prices or anything that changes. Answer from what you know when it does not.",
	"The request ends with a short note about the household: who is at the mirror, the time, the weather and their calendar. Use it when it helps, and do not recite it.",
	"The house's lights and players are handled elsewhere. If someone asks you to switch something, say briefly that you cannot do that from here.",
	"If you do not know, or the question is unclear, say so in one sentence. Never make up calendar entries, people or places."
].join("\n\n");

/**
 * Builds the note about the household that goes with a question.
 * @param {object} context what the page knows
 * @param {string} [context.person] first name of the person at the mirror
 * @param {string} [context.assistant] the mirror's name
 * @param {string} [context.time] the local date and time, in words
 * @param {string} [context.weather] one line about the weather
 * @param {string[]} [context.events] the person's coming calendar entries, one line each
 * @returns {string} the note
 */
const contextNote = ({ person, assistant, time, weather, events = [] } = {}) => {
	const lines = [];
	if (assistant) {
		lines.push(`The mirror is called ${assistant}.`);
	}
	lines.push(person ? `${person} is at the mirror.` : "Nobody the mirror knows is in view.");
	if (time) {
		lines.push(`It is ${time}.`);
	}
	if (weather) {
		lines.push(`Weather: ${weather}`);
	}
	if (events.length > 0) {
		lines.push(`${person ? `${person}'s` : "The"} calendar: ${events.slice(0, 6).join("; ")}.`);
	}
	return lines.join("\n");
};

/**
 * Builds the request for one question.
 * @param {object} options the question and what goes with it
 * @param {string} options.question what was said, without the wake word
 * @param {object} [options.context] see contextNote
 * @param {object[]} [options.history] earlier turns of this conversation, as messages
 * @param {number} [options.searches] how many web searches the model may run
 * @returns {object} the body for messages.create
 */
const buildRequest = ({ question, context = {}, history = [], searches = 2 }) => ({
	model: MODEL,
	max_tokens: 2048,
	output_config: { effort: "low" },
	cache_control: { type: "ephemeral" },
	system: SYSTEM,
	tools: [
		{
			type: "web_search_20250305",
			name: "web_search",
			max_uses: searches,
			user_location: { type: "approximate", city: "Las Vegas", region: "Nevada", country: "US", timezone: "America/Los_Angeles" }
		}
	],
	messages: [...history, { role: "user", content: `${question}\n\n<household>\n${contextNote(context)}\n</household>` }]
});

/**
 * Reads Claude's answer: the words to speak and the sites it searched.
 * @param {object} message the response from messages.create
 * @returns {object} `{ text, sources, refused, paused }`
 */
const readAnswer = (message) => {
	const content = Array.isArray(message && message.content) ? message.content : [];
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	const urls = [];
	for (const block of content) {
		if (block.type === "text" && Array.isArray(block.citations)) {
			urls.push(...block.citations.map((citation) => citation.url).filter(Boolean));
		}
	}
	if (urls.length === 0) {
		for (const block of content) {
			if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
				urls.push(...block.content.map((result) => result.url).filter(Boolean));
			}
		}
	}
	const hostOf = (url) => {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return null;
		}
	};
	const sources = Array.from(new Set(urls.map(hostOf).filter(Boolean))).slice(0, 2);
	return {
		text,
		sources,
		refused: message && message.stop_reason === "refusal",
		paused: message && message.stop_reason === "pause_turn"
	};
};

/**
 * Keeps the last few turns of a conversation for a short while, so "and
 * tomorrow?" follows the question before it.
 * @param {object} [options] how much to keep and for how long
 * @param {number} [options.turns] question and answer pairs to keep
 * @param {number} [options.seconds] how long a conversation lasts after its last answer
 * @param {function(): number} [options.now] the clock, in milliseconds
 * @returns {object} `{ messages(person), add(person, question, answer), clear() }`
 */
const memory = ({ turns = 3, seconds = 120, now = Date.now } = {}) => {
	let kept = { person: null, until: 0, messages: [] };
	return {
		messages (person) {
			return kept.person === person && now() < kept.until ? kept.messages : [];
		},
		add (person, question, answer) {
			const before = this.messages(person);
			const messages = [...before, { role: "user", content: question }, { role: "assistant", content: answer }];
			kept = { person, until: now() + seconds * 1000, messages: messages.slice(-2 * turns) };
		},
		clear () {
			kept = { person: null, until: 0, messages: [] };
		}
	};
};

/**
 * Counts questions per local day, so a stuck microphone cannot run up a bill.
 * @param {number} limit questions a day
 * @param {function(): Date} [today] the clock
 * @returns {function(): boolean} true while today's questions are within the limit, counting this one
 */
const dailyLimit = (limit, today = () => new Date()) => {
	let day = "";
	let count = 0;
	return () => {
		const now = today().toDateString();
		if (now !== day) {
			day = now;
			count = 0;
		}
		count += 1;
		return count <= limit;
	};
};

module.exports = { MODEL, SYSTEM, buildRequest, contextNote, dailyLimit, memory, readAnswer };
