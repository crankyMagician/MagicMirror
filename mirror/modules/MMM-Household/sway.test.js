const assert = require("node:assert/strict");
const { test } = require("node:test");
const { swaySocket } = require("./sway");

const folder = (entries) => ({
	existsSync: (file) => Object.keys(entries).some((name) => file.endsWith(name)),
	readdirSync: () => Object.keys(entries),
	statSync: (file) => ({ mtimeMs: entries[file.split("/").pop()] })
});

test("inside the kiosk session the socket comes from SWAYSOCK", () => {
	const files = folder({ "sway-ipc.1000.967.sock": 10 });
	assert.equal(swaySocket({ env: { SWAYSOCK: "/run/user/1000/sway-ipc.1000.967.sock" }, uid: 1000, files }), "/run/user/1000/sway-ipc.1000.967.sock");
});

test("outside it the newest socket in the runtime directory is the running session", () => {
	const files = folder({ "sway-ipc.1000.967.sock": 10, "sway-ipc.1000.19095.sock": 50, "wayland-1": 60, "sway-ipc.1000.sock.bak": 70 });
	assert.equal(swaySocket({ env: {}, uid: 1000, files }), "/run/user/1000/sway-ipc.1000.19095.sock");
	assert.equal(swaySocket({ env: { XDG_RUNTIME_DIR: "/tmp/run" }, uid: 1000, files }), "/tmp/run/sway-ipc.1000.19095.sock");
});

test("a SWAYSOCK that no longer exists falls back to the directory", () => {
	const files = folder({ "sway-ipc.1000.19095.sock": 50 });
	assert.equal(swaySocket({ env: { SWAYSOCK: "/run/user/1000/sway-ipc.1000.1.sock" }, uid: 1000, files }), "/run/user/1000/sway-ipc.1000.19095.sock");
});

test("with no kiosk there is no socket", () => {
	assert.equal(swaySocket({ env: {}, uid: 1000, files: folder({ "wayland-1": 60 }) }), null);
	const missing = { existsSync: () => false, readdirSync: () => { throw new Error("ENOENT"); } };
	assert.equal(swaySocket({ env: {}, uid: 1000, files: missing }), null);
});
