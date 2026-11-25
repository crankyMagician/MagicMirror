/* MMM-Lights
 *
 * Switches the household's lights by voice, through Home Assistant, and
 * shows what they are doing. MMM-Voice hears the command, this module's
 * helper asks Home Assistant, waits for the lights to report, and the
 * mirror says what happened:
 *
 *   "mirror, turn on the bedroom lights"       "Bedroom lights on."
 *   "mirror, turn off the bedroom lights"      "Bedroom lights off."
 *   "mirror, set the bedroom lights to fifty percent"
 *   "mirror, bedroom evening"                  a scene, by its name
 *   "mirror, christmas lights"                 a script, by its name
 *
 * A command always names the state it wants. Nothing toggles.
 *
 *   {
 *     module: "MMM-Lights",
 *     header: "Lights",
 *     position: "top_right",
 *     config: {
 *       url: "http://192.168.10.212:8123",
 *       lights: { bedroom: { label: "Bedroom", say: "bedroom lights", entity: "light.master_bedroom_lights" } },
 *       scenes: { bedroom_evening: { say: "bedroom evening", entity: "scene.bedroom_evening" } }
 *     }
 *   }
 *
 * The spoken names also go into MMM-Voice's `lights` and `scenes` options,
 * which is where the phrases are built. The access token is
 * SECRET_HA_TOKEN in config.env and stays in the node helper. The helper
 * takes the lights it may use from the server's config and accepts only a
 * command id from this page.
 */
Module.register("MMM-Lights", {
	defaults: {
		url: "",
		lights: {},
		scenes: {}
	},

	start () {
		this.rows = [];
		this.reachable = true;
		this.sendSocketNotification("START");
	},

	getStyles () {
		return [this.file("MMM-Lights.css")];
	},

	notificationReceived (notification, payload) {
		if (notification === "VOICE_COMMAND" && payload && typeof payload.id === "string" && payload.id.startsWith("light:")) {
			this.sendSocketNotification("COMMAND", { id: payload.id });
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "STATE") {
			this.rows = payload.rows;
			this.reachable = payload.reachable;
			this.updateDom(400);
		} else if (notification === "SAY") {
			// In the voice of whoever is at the mirror. MMM-Speak picks it.
			this.sendNotification("TTS_SAY", payload);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "lights-card";
		if (!this.reachable) {
			const note = document.createElement("div");
			note.className = "small dimmed";
			note.textContent = "The house controls are not answering.";
			wrapper.appendChild(note);
			return wrapper;
		}
		const table = document.createElement("table");
		table.className = "small";
		this.rows.forEach((row) => {
			const line = document.createElement("tr");
			line.className = `lights-row lights-${row.tone}`;
			const label = document.createElement("td");
			label.className = "lights-label";
			label.textContent = row.label;
			const status = document.createElement("td");
			status.className = "lights-status";
			status.textContent = row.status;
			line.appendChild(label);
			line.appendChild(status);
			table.appendChild(line);
		});
		wrapper.appendChild(table);
		return wrapper;
	}
});
