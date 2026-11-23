/* MMM-Greeter
 *
 * Greets a person when MMM-Household recognizes them. A person with a list
 * of favorite Pokémon gets one of them beside the greeting, a different one
 * each day.
 *
 *   {
 *     module: "MMM-Greeter",
 *     position: "upper_third",
 *     config: {
 *       people: {
 *         sam: { name: "Sam" },
 *         heather: { name: "Heather", favorites: ["mew", "miltank"] }
 *       }
 *     }
 *   }
 *
 * It listens for the HOUSEHOLD_PRESENCE notification. When `speak` is on it
 * sends TTS_SAY with the greeting, for a speech module to say aloud.
 */
Module.register("MMM-Greeter", {
	defaults: {
		// Keyed by the names MMM-Household uses. Each person has a display
		// `name` and optionally `favorites`, a list of Pokémon names as PokéAPI
		// spells them (lowercase, for example "mr-mime").
		people: {},
		// Seconds the greeting stays on screen.
		displaySeconds: 25,
		// Minutes a person has to be away before they are greeted again.
		awayMinutes: 30,
		// Send TTS_SAY so a speech module can say the greeting.
		speak: true,
		// Hours between spoken greetings for the same person.
		speakEveryHours: 4,
		// {name} is the person's name and {pokemon} is the day's favorite.
		greetings: {
			morning: "Good morning, {name}.",
			afternoon: "Good afternoon, {name}.",
			evening: "Good evening, {name}.",
			night: "Hello, {name}."
		},
		companionLine: "{pokemon} is with you today."
	},

	start () {
		this.current = null;
		this.greeting = null;
		this.lastSeen = {};
		this.lastSpoken = {};
		this.sprites = {};
		this.hideTimer = null;

		const wanted = new Set();
		Object.values(this.config.people).forEach((person) => (person.favorites || []).forEach((name) => wanted.add(String(name).toLowerCase())));
		if (wanted.size > 0) {
			this.sendSocketNotification("SPRITES", [...wanted]);
		}
	},

	getStyles () {
		return [this.file("MMM-Greeter.css")];
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "SPRITES_READY") {
			this.sprites = payload;
			if (this.greeting) {
				this.updateDom(0);
			}
		}
	},

	notificationReceived (notification, payload) {
		if (notification === "HOUSEHOLD_PRESENCE") {
			this.onPresence(payload && payload.person, new Date());
		}
	},

	/**
	 * Names the part of the day for a greeting.
	 * @param {Date} now the current time
	 * @returns {string} morning, afternoon, evening or night
	 */
	partOfDay (now) {
		const hour = now.getHours();
		if (hour >= 5 && hour < 12) {
			return "morning";
		}
		if (hour >= 12 && hour < 17) {
			return "afternoon";
		}
		return hour >= 17 && hour < 22 ? "evening" : "night";
	},

	/**
	 * Picks the day's favorite from a list, moving to the next one each day.
	 * @param {string[]} favorites Pokémon names
	 * @param {Date} now the current time
	 * @returns {string|null} a name, or null for an empty list
	 */
	favoriteFor (favorites, now) {
		if (!favorites || favorites.length === 0) {
			return null;
		}
		const day = Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
		return String(favorites[day % favorites.length]).toLowerCase();
	},

	displayName (pokemon) {
		return pokemon.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
	},

	/**
	 * Builds the greeting for a person at a given time.
	 * @param {string} key the person's key in config.people
	 * @param {Date} now the current time
	 * @returns {object} the lines to show and the Pokémon, if any
	 */
	buildGreeting (key, now) {
		const person = this.config.people[key];
		const pokemon = this.favoriteFor(person.favorites, now);
		const fill = (text) => text.replaceAll("{name}", person.name || key).replaceAll("{pokemon}", pokemon ? this.displayName(pokemon) : "");
		return {
			text: fill(this.config.greetings[this.partOfDay(now)]),
			companion: pokemon ? fill(this.config.companionLine) : null,
			pokemon
		};
	},

	/**
	 * Decides whether a person who just appeared gets a greeting.
	 * @param {string|null|undefined} person who MMM-Household sees now
	 * @param {Date} now the current time
	 */
	onPresence (person, now) {
		const previous = this.current;
		this.current = person || null;
		if (previous && previous !== this.current) {
			this.lastSeen[previous] = now.getTime();
		}
		if (!this.current || this.current === previous || !this.config.people[this.current]) {
			return;
		}
		const away = now.getTime() - (this.lastSeen[this.current] || 0);
		if (away < this.config.awayMinutes * 60 * 1000) {
			return;
		}
		this.greet(this.current, now);
	},

	greet (key, now) {
		// MMM-Household hides this module for a person who switched greetings off.
		if (this.hidden) {
			return;
		}
		this.greeting = this.buildGreeting(key, now);
		this.updateDom(1000);

		clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => {
			this.greeting = null;
			this.updateDom(1500);
		}, this.config.displaySeconds * 1000);

		const sinceSpoken = now.getTime() - (this.lastSpoken[key] || 0);
		if (this.config.speak && sinceSpoken >= this.config.speakEveryHours * 3600 * 1000) {
			this.lastSpoken[key] = now.getTime();
			const spoken = [this.greeting.text, this.greeting.companion].filter(Boolean).join(" ");
			this.sendNotification("TTS_SAY", { text: spoken, id: `greeting-${key}` });
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "greeter";
		if (!this.greeting) {
			return wrapper;
		}

		const sprite = this.greeting.pokemon && this.sprites[this.greeting.pokemon];
		if (sprite) {
			const image = document.createElement("img");
			image.className = "greeter-sprite";
			image.src = sprite;
			image.alt = "";
			wrapper.append(image);
		}

		const text = document.createElement("div");
		text.className = "greeter-text medium bright light";
		text.textContent = this.greeting.text;
		wrapper.append(text);

		if (this.greeting.companion) {
			const companion = document.createElement("div");
			companion.className = "greeter-companion small dimmed";
			companion.textContent = this.greeting.companion;
			wrapper.append(companion);
		}
		return wrapper;
	}
});
