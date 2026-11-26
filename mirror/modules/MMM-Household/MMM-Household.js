/* global HouseholdFit */

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
		// The positions that are columns of a fixed height. When a column's
		// modules do not all fit, the ones left out wait for a turn, so
		// nothing ever runs into something else (see fit.js).
		columns: ["top_left", "top_right"],
		// Feature keys of the modules that never wait for a turn.
		pinned: ["clock", "weather", "calendar"],
		// Seconds before a full column gives its waiting modules a turn.
		turnSeconds: 40,
		// Seconds a feature stays alone on the screen after "show only".
		focusSeconds: 60,
		// The most a feature shown alone is enlarged.
		focusScale: 1.8,
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

	getScripts () {
		return [this.file("fit.js")];
	},

	start () {
		this.view = { person: null, features: null };
		this.domReady = false;
		// Per column: where the current turn starts and where the next one will.
		this.turns = {};
		this.waiting = false;
		this.sendSocketNotification("CONFIG", this.config);
	},

	notificationReceived (notification, payload) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.domReady = true;
			this.sendSocketNotification("FEATURES", this.listFeatures());
			this.applyView();
			this.watchSizes();
		} else if (notification === "VOICE_COMMAND") {
			// From MMM-Voice: wake up, good night, and show or hide a feature.
			this.sendSocketNotification("VOICE", payload);
		} else if (notification === "VOICE_LISTENING" && payload && payload.on && payload.reason === "wake") {
			// Someone said the mirror's name. A dark screen comes on to show it listens.
			this.sendSocketNotification("HEARD_NAME");
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "VIEW") {
			if (payload.person !== this.view.person) {
				// Another person has other modules, so the turns start over.
				this.turns = {};
			}
			this.view = payload;
			this.applyView();
			this.sendNotification("HOUSEHOLD_PRESENCE", payload);
		} else if (notification === "ALERT") {
			this.sendNotification("SHOW_ALERT", payload);
		} else if (notification === "SAY") {
			// Something the helper wants said, in the voice of whoever is there.
			this.sendNotification("TTS_SAY", payload);
		} else if (notification === "MIRROR") {
			// The mirror's name and the phrases to listen for. MMM-Voice acts on it.
			this.sendNotification("HOUSEHOLD_MIRROR", payload);
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
		// "Show only X": that feature and nothing else, whatever the switches say.
		if (this.view.focus) {
			return this.featureKeyOf(module) === this.view.focus;
		}
		// A person's own switches apply to shared modules as well.
		if (this.view.features && this.view.features[this.featureKeyOf(module)] === false) {
			return false;
		}
		return true;
	},

	/**
	 * Packs each column and lists the modules that have to wait for a turn.
	 * A hidden module keeps its width (see custom.css), so its height can be
	 * measured before it is shown.
	 * @param {boolean} advance true to give the waiting modules their turn
	 * @returns {Set<string>} the identifiers of the modules that wait
	 */
	packColumns (advance) {
		const waiting = new Set();
		if (this.view.focus) {
			// One feature alone needs no turns.
			return waiting;
		}
		for (const position of this.config.columns) {
			const region = document.querySelector(`.region.${position.replace("_", ".")}`);
			if (!region || region.clientHeight === 0) {
				continue;
			}
			const items = [];
			let gap = 0;
			MM.getModules().enumerate((module) => {
				const wrapper = document.getElementById(module.identifier);
				if (module.data.position !== position || !wrapper || !this.isManaged(module) || !this.isVisible(module)) {
					return;
				}
				const style = getComputedStyle(wrapper);
				const under = parseFloat(style.marginBottom) || 0;
				gap = Math.max(gap, under);
				items.push({
					id: module.identifier,
					height: wrapper.offsetHeight + under + (parseFloat(style.marginTop) || 0),
					pinned: this.config.pinned.includes(this.featureKeyOf(module))
				});
			});
			const turn = this.turns[position] || { start: 0, next: 0 };
			if (advance) {
				turn.start = turn.next;
			}
			// The gap under the last module may hang over the column's edge.
			const result = HouseholdFit.pack({ items, available: region.clientHeight + gap, start: turn.start });
			turn.next = result.next;
			this.turns[position] = turn;
			result.waiting.forEach((id) => waiting.add(id));
		}
		return waiting;
	},

	/**
	 * Fits the columns again when a module or a column changes its size, and
	 * gives waiting modules a turn every `turnSeconds`.
	 */
	watchSizes () {
		let timer = null;
		const again = () => {
			clearTimeout(timer);
			timer = setTimeout(() => this.applyView(), 250);
		};
		const observer = new ResizeObserver(again);
		for (const position of this.config.columns) {
			const region = document.querySelector(`.region.${position.replace("_", ".")}`);
			if (region) {
				observer.observe(region);
			}
		}
		MM.getModules().enumerate((module) => {
			const wrapper = document.getElementById(module.identifier);
			if (wrapper && this.config.columns.includes(module.data.position)) {
				observer.observe(wrapper);
			}
		});
		if (this.config.turnSeconds > 0) {
			setInterval(() => {
				if (this.waiting) {
					this.applyView(true);
				}
			}, this.config.turnSeconds * 1000);
		}
	},

	/**
	 * Moves a feature that is shown alone to the middle of the screen and
	 * enlarges it, and puts every other module back where it belongs. The
	 * place a module has in the page's flow is not changed by the move, so it
	 * can be measured again at any time.
	 */
	placeFocus () {
		const focus = this.view.focus || null;
		document.body.classList.toggle("household-focus", Boolean(focus));
		const page = document.body.getBoundingClientRect();
		const screen = { width: window.innerWidth, height: window.innerHeight };
		const chosen = [];
		// MagicMirror sets a fade on each module's own style when it shows or
		// hides it, so the glide to the middle has to be set there as well.
		const glide = `opacity ${this.config.fadeSpeed / 1000}s, transform ${this.config.fadeSpeed / 1000}s ease`;
		MM.getModules().enumerate((module) => {
			const wrapper = document.getElementById(module.identifier);
			if (!wrapper || !this.isManaged(module)) {
				return;
			}
			if (focus && this.isVisible(module)) {
				chosen.push(wrapper);
			} else if (wrapper.classList.contains("household-focused")) {
				wrapper.classList.remove("household-focused");
				wrapper.style.transition = glide;
				wrapper.style.transform = "";
			}
		});
		if (chosen.length === 0) {
			return;
		}
		// Several modules can share a feature. They move as one block.
		const boxes = chosen.map((wrapper) => ({ left: page.left + wrapper.offsetLeft, top: page.top + wrapper.offsetTop, width: wrapper.offsetWidth, height: wrapper.offsetHeight }));
		const left = Math.min(...boxes.map((box) => box.left));
		const top = Math.min(...boxes.map((box) => box.top));
		const block = { left, top, width: Math.max(...boxes.map((box) => box.left + box.width)) - left, height: Math.max(...boxes.map((box) => box.top + box.height)) - top };
		const move = HouseholdFit.center(block, screen, { maxScale: this.config.focusScale });
		chosen.forEach((wrapper, index) => {
			// Each module scales around the block's center, so they stay together.
			const box = boxes[index];
			const originX = block.left + block.width / 2 - box.left;
			const originY = block.top + block.height / 2 - box.top;
			wrapper.classList.add("household-focused");
			wrapper.style.transition = glide;
			wrapper.style.transformOrigin = `${originX}px ${originY}px`;
			wrapper.style.transform = `translate(${move.x}px, ${move.y}px) scale(${move.scale})`;
		});
	},

	/**
	 * Shows and hides modules. A module can be held back for two reasons, each
	 * with a lock of its own: the view (it is not for this person, or they
	 * switched it off) and the fit (its column is full and it waits its turn).
	 * @param {boolean} [advance] true to give the waiting modules their turn
	 */
	applyView (advance = false) {
		if (!this.domReady) {
			return;
		}
		const waiting = this.packColumns(advance);
		this.waiting = waiting.size > 0;
		const viewLock = this.identifier;
		const fitLock = `${this.identifier}-fit`;
		const speed = this.config.fadeSpeed;
		MM.getModules().enumerate((module) => {
			if (!this.isManaged(module)) {
				return;
			}
			const visible = this.isVisible(module);
			const held = waiting.has(module.identifier);
			const locks = module.lockStrings;
			if (held && !locks.includes(fitLock)) {
				module.hide(speed, { lockString: fitLock });
			}
			if (!visible && !locks.includes(viewLock)) {
				module.hide(speed, { lockString: viewLock });
			}
			if (visible && locks.includes(viewLock)) {
				module.show(speed, { lockString: viewLock });
			}
			if (!held && locks.includes(fitLock)) {
				module.show(speed, { lockString: fitLock });
			}
		});

		this.placeFocus();

		const body = document.body;
		document.documentElement.dataset.theme = this.view.theme === "light" ? "light" : "dark";
		[...body.classList].filter((name) => name.startsWith("profile-")).forEach((name) => body.classList.remove(name));
		body.classList.add(`profile-${this.view.person || "nobody"}`);
	}
});
