/* Prints the direction of the picture that the settings page last saved, or
 * nothing when none is saved. kiosk-session.sh hands it to sway before the
 * page is drawn. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROTATIONS } = require("../modules/MMM-Household/rotation");

const dataDir = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
try {
	const { mirror } = JSON.parse(fs.readFileSync(path.join(dataDir, "profiles.json"), "utf8"));
	if (mirror && ROTATIONS.some((rotation) => rotation.value === mirror.rotation)) {
		process.stdout.write(mirror.rotation);
	}
} catch {
	// No settings yet. The kiosk keeps the direction from output.conf.
}
