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
 *
 * Each person can also switch features on and off for each part of the day
 * on the settings page at /household. A feature is a module name. Give a
 * module the class `feature-NAME` to list it separately from other modules
 * with the same name, as the config does for the weather forecast.
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

	// Names shown on the settings page. Other modules use their header or name.
	featureLabels: {
		clock: "Clock",
		weather: "Weather now",
		forecast: "Forecast",
		calendar: "Calendar",
		compliments: "Compliments",
		newsfeed: "News"
	},

	start () {
		this.view = { person: null, features: null };
		this.domReady = false;
		this.sendSocketNotification("CONFIG", this.config);
	},

	notificationReceived (notification) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.domReady = true;
			this.sendSocketNotification("FEATURES", this.listFeatures());
			this.applyView();
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "VIEW") {
			this.view = payload;
			this.applyView();
			this.sendNotification("HOUSEHOLD_PRESENCE", payload);
		} else if (notification === "ALERT") {
			this.sendNotification("SHOW_ALERT", payload);
		}
	},

	isManaged (module) {
		return module.name !== this.name && module.name !== "alert";
	},

	classesOf (module) {
		return (module.data.classes || "").split(/\s+/);
	},

	featureKeyOf (module) {
		const tagged = this.classesOf(module).find((name) => name.startsWith("feature-"));
		return tagged ? tagged.slice("feature-".length) : module.name;
	},

	ownersOf (module) {
		return this.classesOf(module).filter((name) => this.config.people.includes(name));
	},

	/**
	 * Lists the features the settings page can offer, one per feature key.
	 * @returns {object[]} features with a key, a label and the people who own them
	 */
	listFeatures () {
		const features = new Map();
		MM.getModules().enumerate((module) => {
			if (!this.isManaged(module)) {
				return;
			}
			const key = this.featureKeyOf(module);
			const owners = this.ownersOf(module);
			const known = features.get(key);
			if (known) {
				// A feature with one instance per person belongs to all of them.
				known.owners = known.owners.length === 0 || owners.length === 0 ? [] : [...new Set([...known.owners, ...owners])];
			} else {
				features.set(key, { key, label: this.featureLabels[key] || module.data.header || key, owners });
			}
		});
		return [...features.values()];
	},

	/**
	 * Decides whether a module shows in the current view.
	 * @param {object} module a MagicMirror module
	 * @returns {boolean} true when the module should be visible
	 */
	isVisible (module) {
		const owners = this.ownersOf(module);
		const person = this.view.person;
		if (owners.length > 0 && (person === null || !owners.includes(person))) {
			return false;
		}
		// A person's own switches apply to shared modules as well.
		if (this.view.features && this.view.features[this.featureKeyOf(module)] === false) {
			return false;
		}
		return true;
	},

	applyView () {
		if (!this.domReady) {
			return;
		}
		const lockString = this.identifier;
		MM.getModules().enumerate((module) => {
			if (!this.isManaged(module)) {
				return;
			}
			if (this.isVisible(module)) {
				module.show(this.config.fadeSpeed, { lockString });
			} else {
				module.hide(this.config.fadeSpeed, { lockString });
			}
		});

		const body = document.body;
		[...body.classList].filter((name) => name.startsWith("profile-")).forEach((name) => body.classList.remove(name));
		body.classList.add(`profile-${this.view.person || "nobody"}`);
	}
});
