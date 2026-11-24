/* Talks to the kiosk's sway session from outside it.
 *
 * The MagicMirror server runs as a service of its own, apart from the kiosk,
 * so it does not inherit SWAYSOCK. sway keeps its socket in the user's
 * runtime directory, and the newest one there belongs to the session that is
 * running. With no kiosk there is no socket, and screen commands are skipped.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SOCKET_NAME = /^sway-ipc\.\d+\.\d+\.sock$/;

/**
 * Finds the socket of the running sway session.
 * @param {object} [options] where to look, for tests
 * @param {object} [options.env] the environment
 * @param {number} [options.uid] the user's id
 * @param {object} [options.files] stands in for node:fs
 * @returns {string|null} the socket's path, or null when no session is running
 */
const swaySocket = ({ env = process.env, uid = process.getuid(), files = fs } = {}) => {
	if (env.SWAYSOCK && files.existsSync(env.SWAYSOCK)) {
		return env.SWAYSOCK;
	}
	const dir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
	let names;
	try {
		names = files.readdirSync(dir).filter((name) => SOCKET_NAME.test(name));
	} catch {
		return null;
	}
	const newest = names
		.map((name) => {
			const file = path.join(dir, name);
			try {
				return { file, time: files.statSync(file).mtimeMs };
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a, b) => b.time - a.time)[0];
	return newest ? newest.file : null;
};

/**
 * Runs swaymsg against the running session.
 * @param {string[]} args the arguments after the socket
 * @param {function(Error|null, string): void} callback gets an error, or sway's answer. The error has `noSession` set when no kiosk is running.
 */
const swaymsg = (args, callback) => {
	const socket = swaySocket();
	if (!socket) {
		const error = new Error("no sway session is running");
		error.noSession = true;
		callback(error, "");
		return;
	}
	execFile("swaymsg", ["-s", socket, ...args], (error, stdout) => callback(error, stdout));
};

module.exports = { swaySocket, swaymsg };
