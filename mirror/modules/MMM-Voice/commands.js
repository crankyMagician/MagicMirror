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
 * Expands the module's config into commands with full phrases.
 * @param {object} config MMM-Voice's config
 * @param {string} config.wakeWord the word every phrase starts with
 * @param {string[]} [config.wakeWords] several wake phrases in place of the one word: every command answers to each of them
 * @param {object} config.commands command id -> phrases without the wake word
 * @param {object} config.features spoken name -> feature key. Each gets "show NAME", "hide NAME" and "show only NAME".
 * @param {object} [config.lights] spoken name -> light key. Each gets "turn on the NAME", "turn off the NAME" and "set the NAME to LEVEL".
 * @param {object} [config.scenes] spoken name -> scene key. The name alone is the command.
 * @param {object} [config.lightLevels] spoken brightness -> percent
 * @returns {object[]} commands as { id, phrases }
 */
const buildCommands = ({ wakeWord, wakeWords, commands = {}, features = {}, lights = {}, scenes = {}, lightLevels = LIGHT_LEVELS }) => {
	const wakes = Array.isArray(wakeWords) && wakeWords.length > 0 ? wakeWords : [wakeWord];
	const withWake = (phrase) => wakes.map((wake) => `${wake} ${phrase}`.toLowerCase());
	const list = Object.entries(commands).map(([id, phrases]) => ({ id, phrases: phrases.flatMap(withWake) }));
	for (const [spoken, key] of Object.entries(features)) {
		for (const action of ["show", "hide"]) {
			list.push({ id: `${action}:${key}`, phrases: [...withWake(`${action} ${spoken}`), ...withWake(`${action} the ${spoken}`)] });
		}
		// "Show only the calendar" puts that one feature alone on the screen.
		list.push({ id: `only:${key}`, phrases: [...withWake(`show only ${spoken}`), ...withWake(`show only the ${spoken}`), ...withWake(`just the ${spoken}`)] });
	}
	// Lights name the state they want. There is no "toggle", so a command
	// heard twice does the same thing twice.
	for (const [spoken, key] of Object.entries(lights)) {
		for (const state of ["on", "off"]) {
			list.push({ id: `light:${state}:${key}`, phrases: [...withWake(`turn ${state} the ${spoken}`), ...withWake(`${spoken} ${state}`)] });
		}
		for (const [level, percent] of Object.entries(lightLevels)) {
			list.push({ id: `light:level:${key}:${percent}`, phrases: [...withWake(`set the ${spoken} to ${level}`), ...withWake(`${spoken} to ${level}`)] });
		}
	}
	for (const [spoken, key] of Object.entries(scenes)) {
		list.push({ id: `light:scene:${key}`, phrases: withWake(spoken) });
	}
	return list;
};

/**
 * Writes a short two-note tone as a 16-bit mono WAV file.
 * @param {number} sampleRate samples per second
 * @returns {Buffer} the WAV file's bytes
 */
const chimeWav = (sampleRate = 22050) => {
	const notes = [{ hz: 660, seconds: 0.09 }, { hz: 880, seconds: 0.14 }];
	const total = Math.round(notes.reduce((sum, note) => sum + note.seconds, 0) * sampleRate);
	const data = Buffer.alloc(total * 2);
	let offset = 0;
	for (const note of notes) {
		const count = Math.round(note.seconds * sampleRate);
		for (let i = 0; i < count; i++) {
			// Fade each note in and out so it does not click.
			const envelope = Math.min(1, i / 200, (count - i) / 600);
			const sample = Math.sin(2 * Math.PI * note.hz * i / sampleRate) * envelope * 0.22;
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

module.exports = { buildCommands, chimeWav, LIGHT_LEVELS };
