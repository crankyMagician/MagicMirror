/* Builds the command list that mirror/services/voice.py listens for. */

/**
 * Expands the module's config into commands with full phrases.
 * @param {object} config MMM-Voice's config
 * @param {string} config.wakeWord the word every phrase starts with
 * @param {string[]} [config.wakeWords] several wake phrases in place of the one word: every command answers to each of them
 * @param {object} config.commands command id -> phrases without the wake word
 * @param {object} config.features spoken name -> feature key. Each gets "show NAME", "hide NAME" and "show only NAME".
 * @returns {object[]} commands as { id, phrases }
 */
const buildCommands = ({ wakeWord, wakeWords, commands = {}, features = {} }) => {
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

module.exports = { buildCommands, chimeWav };
