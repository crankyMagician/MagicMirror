/* Builds the command list that mirror/services/voice.py listens for. */

// Spoken brightness -> percent, for "set the NAME to fifty percent".
const LIGHT_LEVELS = {
	"ten percent": 10,
	"twenty five percent": 25,
	"fifty percent": 50,
	"seventy five percent": 75,
	"one hundred percent": 100
};

/**
 * Lists the wake phrases in force.
 * @param {object} config MMM-Voice's config
 * @returns {string[]} wake phrases, lowercased
 */
const wakesOf = (config) => {
	const { wakeWord, wakeWords } = config;
	return (Array.isArray(wakeWords) && wakeWords.length > 0 ? wakeWords : [wakeWord]).map((wake) => String(wake).toLowerCase());
};

/**
 * Lists what can be said after the wake word, before the wake word is added.
 * @param {object} config see buildCommands
 * @returns {object[]} commands as { id, bare }
 */
const bareCommands = (config) => {
	const { commands = {}, features = {}, lights = {}, scenes = {}, lightLevels = LIGHT_LEVELS } = config;
	const lower = (phrases) => phrases.map((phrase) => phrase.toLowerCase());
	const list = Object.entries(commands).map(([id, phrases]) => ({ id, bare: lower(phrases) }));
	for (const [spoken, key] of Object.entries(features)) {
		list.push({ id: `show:${key}`, bare: lower([`show ${spoken}`, `show the ${spoken}`, `show me ${spoken}`, `show me the ${spoken}`]) });
		list.push({ id: `hide:${key}`, bare: lower([`hide ${spoken}`, `hide the ${spoken}`]) });
		// "Show only the calendar" puts that one feature alone on the screen.
		list.push({ id: `only:${key}`, bare: lower([`show only ${spoken}`, `show only the ${spoken}`, `just the ${spoken}`]) });
	}
	// Lights name the state they want. There is no "toggle", so a command
	// heard twice does the same thing twice.
	for (const [spoken, key] of Object.entries(lights)) {
		for (const state of ["on", "off"]) {
			list.push({ id: `light:${state}:${key}`, bare: lower([`turn ${state} the ${spoken}`, `${spoken} ${state}`, `turn the ${spoken} ${state}`, `switch ${state} the ${spoken}`]) });
		}
		for (const [level, percent] of Object.entries(lightLevels)) {
			list.push({ id: `light:level:${key}:${percent}`, bare: lower([`set the ${spoken} to ${level}`, `${spoken} to ${level}`]) });
		}
	}
	for (const [spoken, key] of Object.entries(scenes)) {
		list.push({ id: `light:scene:${key}`, bare: lower([spoken]) });
	}
	return list;
};

/**
 * Expands the module's config into commands with full phrases.
 *
 * Each command has its `phrases`, which start with a wake phrase, and its
 * `bare` phrases without one. The recognizer takes a bare phrase only in
 * the few seconds after someone said the wake phrase alone.
 * @param {object} config MMM-Voice's config
 * @param {string} config.wakeWord the word every phrase starts with
 * @param {string[]} [config.wakeWords] several wake phrases in place of the one word: every command answers to each of them
 * @param {object} config.commands command id -> phrases without the wake word
 * @param {object} config.features spoken name -> feature key. Each gets "show NAME", "hide NAME" and "show only NAME".
 * @param {object} [config.lights] spoken name -> light key. Each gets "turn on the NAME", "turn off the NAME" and "set the NAME to LEVEL".
 * @param {object} [config.scenes] spoken name -> scene key. The name alone is the command.
 * @param {object} [config.lightLevels] spoken brightness -> percent
 * @returns {object[]} commands as { id, phrases, bare }
 */
const buildCommands = (config) => {
	const wakes = wakesOf(config);
	return bareCommands(config).map(({ id, bare }) => ({ id, phrases: bare.flatMap((phrase) => wakes.map((wake) => `${wake} ${phrase}`)), bare }));
};

/**
 * Sums up what people can say, for the settings page. Each group has a
 * title, the shapes of its phrases, and the names that fill them in.
 * @param {object} config see buildCommands
 * @returns {object} { wake, groups: [{ title, say, names }] }
 */
const summarize = (config) => {
	const { commands = {}, features = {}, lights = {}, scenes = {} } = config;
	const groups = [{ title: "Anytime", say: Object.values(commands).map((phrases) => phrases[0]).filter(Boolean), names: [] }];
	if (Object.keys(features).length > 0) {
		groups.push({ title: "On the screen", say: ["show the NAME", "hide the NAME", "show only the NAME"], names: Object.keys(features) });
	}
	if (Object.keys(lights).length > 0) {
		groups.push({ title: "Lights", say: ["turn on the NAME", "turn off the NAME", "set the NAME to fifty percent"], names: Object.keys(lights) });
	}
	if (Object.keys(scenes).length > 0) {
		groups.push({ title: "Light shows and scenes", say: ["NAME"], names: Object.keys(scenes) });
	}
	return { wake: wakesOf(config)[0], groups };
};

// The mirror's tones. Each is two short notes, so they are easy to tell apart.
const TONES = {
	// A command was understood.
	heard: { notes: [{ hz: 660, seconds: 0.09 }, { hz: 880, seconds: 0.14 }], volume: 0.22 },
	// "Mirror" alone: it is waiting for the command.
	listening: { notes: [{ hz: 587, seconds: 0.07 }, { hz: 784, seconds: 0.1 }], volume: 0.18 },
	// It heard someone and understood nothing it knows.
	missed: { notes: [{ hz: 494, seconds: 0.1 }, { hz: 370, seconds: 0.16 }], volume: 0.14 }
};

/**
 * Writes a short tone as a 16-bit mono WAV file.
 * @param {object} tone notes as { hz, seconds } and a volume from 0 to 1
 * @param {number} sampleRate samples per second
 * @returns {Buffer} the WAV file's bytes
 */
const toneWav = (tone, sampleRate = 22050) => {
	const { notes, volume } = tone;
	const total = Math.round(notes.reduce((sum, note) => sum + note.seconds, 0) * sampleRate);
	const data = Buffer.alloc(total * 2);
	let offset = 0;
	for (const note of notes) {
		const count = Math.round(note.seconds * sampleRate);
		for (let i = 0; i < count && offset < data.length; i++) {
			// Fade each note in and out so it does not click.
			const envelope = Math.min(1, i / 200, (count - i) / 600);
			const sample = Math.sin(2 * Math.PI * note.hz * i / sampleRate) * envelope * volume;
			data.writeInt16LE(Math.round(sample * 32767), offset);
			offset += 2;
		}
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
};

/**
 * Writes the tone for an understood command.
 * @param {number} sampleRate samples per second
 * @returns {Buffer} the WAV file's bytes
 */
const chimeWav = (sampleRate = 22050) => toneWav(TONES.heard, sampleRate);

module.exports = { buildCommands, chimeWav, summarize, toneWav, wakesOf, LIGHT_LEVELS, TONES };
