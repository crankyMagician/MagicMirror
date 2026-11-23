/* MMM-Household
 *
 * Shows each person their own set of modules, based on who the camera
 * recognizes, and lets the screen sleep when nobody is there.
 *
 * Give a module one or more person names in its `classes` to show it only to
 * those people:
 *
 *   { module: "calendar", classes: "heather", ... }
 *
 * A module with no person name in its classes is shared. Shared modules show
 * for anyone, including a guest.
 */
Module.register("MMM-Household", {
	defaults: {
		// Names of the people who have profiles. They match the names used at enrollment.
		people: ["sam", "heather"],
		// Seconds with nobody recognized before the screen turns off.
		absentDelay: 60,
		// Seconds a person stays current after the camera last saw them.
		holdSeconds: 8,
		camera: "/dev/video0",
		// Milliseconds for the fade when modules appear and disappear.
		fadeSpeed: 800
	},

	start () {
		this.person = null;
		this.domReady = false;
		this.sendSocketNotification("CONFIG", this.config);
	},

	notificationReceived (notification) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.domReady = true;
			this.applyProfile();
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "PRESENCE") {
			this.person = payload.person;
			this.applyProfile();
			this.sendNotification("HOUSEHOLD_PRESENCE", payload);
		} else if (notification === "ALERT") {
			this.sendNotification("SHOW_ALERT", payload);
		}
	},

	/**
	 * Decides whether a module shows for the current person.
	 * @param {string[]} classes the module's classes
	 * @returns {boolean} true when the module should be visible
	 */
	isVisibleFor (classes) {
		const owners = classes.filter((name) => this.config.people.includes(name));
		if (owners.length === 0) {
			return true;
		}
		return this.person !== null && owners.includes(this.person);
	},

	applyProfile () {
		if (!this.domReady) {
			return;
		}
		const lockString = this.identifier;
		MM.getModules().enumerate((module) => {
			if (module.name === this.name || module.name === "alert") {
				return;
			}
			const classes = (module.data.classes || "").split(/\s+/);
			if (this.isVisibleFor(classes)) {
				module.show(this.config.fadeSpeed, { lockString });
			} else {
				module.hide(this.config.fadeSpeed, { lockString });
			}
		});

		const body = document.body;
		[...body.classList].filter((name) => name.startsWith("profile-")).forEach((name) => body.classList.remove(name));
		body.classList.add(`profile-${this.person || "nobody"}`);
	}
});
