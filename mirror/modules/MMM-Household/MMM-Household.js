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
 * on the settings page, which this module serves on its own port (8081). A feature is a module name. Give a
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
		// Minutes the mirror stays on after a spoken "wake up" with nobody recognized.
		wakeMinutes: 5,
		camera: "/dev/video0",
		// Milliseconds for the fade when modules appear and disappear.
		fadeSpeed: 800,
		// Names for features on the settings page, by feature key. They add to
		// and override the built-in names below. A feature without a name uses
		// the module's header, then its key.
		labels: {},
		// The settings page has a port of its own, and these addresses may open
		// it. Use CIDR ranges for the home network, for example "192.168.1.0/24".
		settingsPort: 8081,
		settingsAllow: ["127.0.0.1", "::1"],
		// Host names the settings page answers to, besides bare addresses.
		settingsHosts: ["localhost", "mirror", "mirror.local"],
		// The household's login server. With `authUrl` empty the page has no
		// login and the network filter above is the only guard. With it set,
		// the page and its API need a signed-in account from `accounts`
		// (email address -> person), and `host` is the name people open.
		login: { authUrl: "", host: "", cookie: "household_auth", accounts: {} },
		// Person -> the Google account whose photos they pick for their
		// slideshow. A person not listed uses "<name>-personal".
		photoAccounts: {},
		// Person -> the address of a picture feed (HTTPS, JSON) that fills their
		// frame with paintings. See art-feed.js for the format.
		artFeeds: {}
	},

	// Names shown on the settings page for MagicMirror's default modules.
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

	notificationReceived (notification, payload) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.domReady = true;
			this.sendSocketNotification("FEATURES", this.listFeatures());
			this.applyView();
		} else if (notification === "VOICE_COMMAND") {
			// From MMM-Voice: wake up, good night, and show or hide a feature.
			this.sendSocketNotification("VOICE", payload);
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

	/**
	 * Tells whether this module shows and hides the given module. Modules
	 * without a position draw nothing, so they are left alone and are not
	 * offered on the settings page.
	 * @param {object} module a MagicMirror module
	 * @returns {boolean} true for a visible module other than this one and alert
	 */
	isManaged (module) {
		return module.name !== this.name && module.name !== "alert" && Boolean(module.data.position);
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
				const label = this.config.labels[key] || this.featureLabels[key] || module.data.header || key;
				features.set(key, { key, label, owners });
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
		document.documentElement.dataset.theme = this.view.theme === "light" ? "light" : "dark";
		[...body.classList].filter((name) => name.startsWith("profile-")).forEach((name) => body.classList.remove(name));
		body.classList.add(`profile-${this.view.person || "nobody"}`);
	}
});
