/* MagicMirror config for the household mirror.
 *
 * setup-pi.sh links this file to config/config.js on the Pi.
 *
 * Values written as ${NAME} come from config/config.env on the Pi, which is
 * not committed (see config.env.sample). MagicMirror hides any name that
 * starts with SECRET_ from the copy of this config it sends to the browser.
 */
// Each Google account has a token file on the Pi, written by
// mirror/tools/google-connect.py. MagicMirror evaluates this file in Node, so
// the paths can come from the environment. Strings are joined with text()
// here and never with template literals, because MagicMirror replaces
// dollar-brace names from the environment in this file's text before it runs.
const text = (...parts) => parts.join("");
const dataDir = process.env.MIRROR_DATA_DIR || text(process.env.HOME, "/mirror-data");
const googleDir = text(dataDir, "/google");
const googleAccount = (name) => ({
	tokenFile: text(googleDir, "/", name, ".json"),
	credentialsFile: text(googleDir, "/credentials.json")
});
const googleCalendar = (person, account, header, feature) => ({
	module: "MMM-GoogleCalendar",
	classes: text(person, " feature-", feature),
	header,
	position: "top_left",
	config: {
		...googleAccount(account),
		maximumEntries: 4,
		// MMM-Briefing reads the events to answer "what is next".
		broadcastEvents: true,
		calendars: [{ symbol: "calendar-check", calendarID: "primary" }]
	}
});
const googleTasks = (person, account, header, feature) => ({
	module: "MMM-HouseholdTasks",
	classes: text(person, " feature-", feature),
	header,
	position: "top_left",
	config: {
		...googleAccount(account),
		maxTasks: 4
	}
});
// A framed photo from the person's own folder, filled from Google Photos on
// the settings page. It changes every 20 seconds. It sits in the right
// column, under the network card.
const photoFrame = (person) => ({
	module: "MMM-ImagesPhotos",
	classes: text(person, " feature-photos"),
	position: "top_right",
	config: {
		path: text(dataDir, "/photos/", person),
		updateInterval: 20 * 1000,
		maxWidth: "100%",
		maxHeight: "300px",
		opacity: 1
	}
});

// A framed painting from a feed of public domain art, for someone who would
// sooner see art than their own photos. MMM-Household downloads the feed.
const artFrame = (person) => ({
	module: "MMM-ImagesPhotos",
	classes: text(person, " feature-art"),
	position: "top_right",
	config: {
		path: text(dataDir, "/art/", person),
		updateInterval: 60 * 1000,
		maxWidth: "100%",
		maxHeight: "380px",
		opacity: 1
	}
});

// The lights and scenes the mirror may use, through Home Assistant. `say` is
// the name people speak and the mirror says back, `label` is the name on the
// card, and the entity is a light or a group of lights in Home Assistant.
// With MIRROR_HA_URL empty in config.env the mirror has no light commands
// and no light card.
const homeUrl = process.env.MIRROR_HA_URL || "";
const lights = {
	bedroom: { label: "Bedroom", say: "bedroom lights", entity: "light.master_bedroom_lights" },
	living: { label: "Living room", say: "living room lights", entity: "light.living_room_lights" },
	kitchen: { label: "Kitchen", say: "kitchen lights", entity: "light.kitchen_lights" },
	dining: { label: "Dining room", say: "dining room lights", entity: "light.dining_room_lights" },
	nook: { label: "Nook", say: "nook lights", entity: "light.nook_all_lights" },
	stairwell: { label: "Stairwell", say: "stairwell lights", entity: "light.stairwell_lights" },
	landing: { label: "Landing", say: "landing lights", entity: "light.landing_lights" },
	office: { label: "Office", say: "office lights", entity: "light.upstairs_office_lights" },
	guest: { label: "Guest room", say: "guest room lights", entity: "light.guest_room_lights" },
	sitting: { label: "Sitting room", say: "sitting room lights", entity: "light.sitting_room_lights" }
};
// A scene's name alone is its command. The entity is a scene or a script in
// Home Assistant. `also` lists more ways to say it, `members` are the lights
// counted after a script has started, and `done` is what the mirror says.
// A holiday show is a script in Home Assistant that turns every light to that
// holiday's colors. What plays is decided there, and one script puts the
// lights back whichever show is on.
const everyRoom = Object.values(lights).map((light) => light.entity);
// Whole floors. They take the same commands as a room, and they stay off the
// card, which shows the rooms.
const floors = {
	upstairs: { label: "Upstairs", say: "upstairs lights", entity: "light.upstairs_lights", card: false },
	downstairs: { label: "Downstairs", say: "downstairs lights", entity: "light.downstairs_lights", card: false },
	// Both floors at once. "Turn off the lights" means every light.
	all: { label: "All lights", say: "all lights", also: ["lights", "every light"], entity: "light.all_lights", card: false }
};
const show = (key, say, also = []) => ({
	say: text(say, " lights"),
	also: [text("turn on the ", say, " lights"), ...also.map((name) => text(name, " lights"))],
	entity: text("script.", key, "_lights_on"),
	members: everyRoom,
	done: text(say.charAt(0).toUpperCase(), say.slice(1), " lights are on.")
});
const scenes = {
	bedroom_evening: { say: "bedroom evening", entity: "scene.bedroom_evening" },
	christmas: { ...show("christmas", "christmas"), also: ["christmas lights on", "turn on the christmas lights"] },
	thanksgiving: show("thanksgiving", "thanksgiving"),
	hanukkah: show("hanukkah", "hanukkah", ["snow", "blue and white"]),
	candy_cane: show("candy_cane", "candy cane"),
	new_year: show("new_year", "new year", ["gold"]),
	party: show("party", "party", ["birthday"]),
	valentine: show("valentine", "valentine", ["pink"]),
	saint_patrick: show("saint_patrick", "saint patrick", ["green and gold"]),
	easter: show("easter", "easter", ["pastel"]),
	patriotic: show("patriotic", "fourth of july", ["red white and blue"]),
	halloween: show("halloween", "halloween", ["orange and purple"]),
	// Music: a script in Home Assistant starts a holiday station on the
	// HomePods and the TVs and turns on a switch. MMM-Radio follows that
	// switch and plays the station on the mirror's own speaker.
	christmas_music: { say: "christmas music", also: ["play christmas music"], entity: "script.christmas_music_on", done: "Christmas music is playing." },
	music_off: { say: "stop the music", also: ["christmas music off", "music off", "stop playing music", "turn off the music", "stop the christmas music"], entity: "script.christmas_music_off", done: "The music is off." },
	// Lights and music together. A special day's line starts it, so it is quiet.
	christmas_morning: { say: "christmas morning", entity: "script.christmas_morning", quiet: true },
	// Ends a show and turns every light that is on to warm white.
	white: { say: "white lights", also: ["all lights white", "turn the lights white", "make the lights white", "lights white", "turn all lights white"], entity: "script.white_lights", members: everyRoom, done: "The lights are white." },
	christmas_off: {
		say: "christmas lights off",
		also: ["turn off the christmas lights", "holiday lights off", "lights back to normal", "turn the lights back to normal"],
		entity: "script.christmas_lights_off",
		members: everyRoom,
		done: "The lights are back to normal."
	}
};
// Spoken name -> key, the form MMM-Voice builds its phrases from.
const spoken = (things) => Object.fromEntries(Object.entries(homeUrl ? things : {}).flatMap(([key, thing]) => [thing.say, ...thing.also || []].map((name) => [name, key])));

const config = {
	// MagicMirror answers only on the Pi itself. The settings page that phones
	// open is served separately by MMM-Household (see settingsPort below).
	address: "localhost",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::1"],

	// The server runs apart from the screen (magicmirror-server.service). When
	// it restarts, the page on the screen loads again by itself.
	reloadAfterServerRestart: true,

	language: "en",
	locale: "en-US",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 12,
	units: "imperial",

	// The page is a band on top (top_bar) for what the mirror says, two
	// columns (top_left and top_right) and the news (bottom_bar). Use only
	// these four positions: custom.css lays them out so they cannot overlap,
	// and MMM-Household gives a full column's modules turns. A module's place
	// in its column is its place in this list.
	modules: [
		{
			module: "alert"
		},
		{
			// Switches the view by who the camera recognizes and lets the screen
			// sleep when nobody is there. A module with a person's name in its
			// classes shows only for that person. A module without one is shared.
			module: "MMM-Household",
			config: {
				people: ["sam", "heather"],
				absentDelay: 60,
				// The settings page: http://mirror.local:8081/ from the home network.
				settingsPort: 8081,
				// Addresses that may reach the settings page. The mirror itself
				// always may. MIRROR_SETTINGS_ALLOW in config.env replaces the two
				// home subnets, for example with the one address of an HTTPS proxy.
				settingsAllow: ["127.0.0.1", "::1"].concat((process.env.MIRROR_SETTINGS_ALLOW || "192.168.1.0/24,192.168.10.0/24").split(",").map((entry) => entry.trim()).filter(Boolean)),
				// The household login server. Empty values in config.env leave the
				// page without login, guarded by the network filter alone.
				login: {
					authUrl: process.env.MIRROR_AUTH_URL || "",
					host: process.env.MIRROR_SETTINGS_HOST || "",
					accounts: JSON.parse(process.env.MIRROR_ACCOUNTS || "{}")
				},
				// Heather's frame shows a weekly set of paintings from The Met.
				artFeeds: { heather: "https://crankymagician.github.io/tv-art/mirror/feed.json" },
				// Names on the settings page for the third-party modules below.
				labels: {
					calendar: "Calendar",
					"work-calendar": "Work calendar",
					tasks: "Tasks",
					"work-tasks": "Work tasks",
					photos: "Photos",
					art: "Art",
					unifi: "Network devices",
					lights: "Lights",
					"MMM-MoonPhase": "Moon",
					"MMM-APOD": "Space picture",
					"MMM-CoupleDays": "Days together",
					"MMM-CountEvents": "Countdowns",
					"MMM-WordOfTheDay": "Word of the day",
					"MMM-History": "On this day",
					"MMM-PokemonGOEvents": "Pokémon GO events",
					"MMM-DailyPokemon": "Pokémon of the day",
					"MMM-AirQuality": "Air quality",
					"MMM-Greeter": "Greeting"
				}
			}
		},
		{
			// Offline voice commands: "mirror, wake up", "mirror, good night",
			// "mirror, show the calendar", "mirror, hide news". It draws nothing.
			module: "MMM-Voice",
			config: {
				// Command -> the phrases that trigger it, after the wake word.
				// MMM-Household acts on the first three and MMM-Briefing answers
				// the rest aloud. MMM-Lights acts on the light commands, which
				// are built from `lights` and `scenes` below.
				commands: {
					wake_up: ["wake up"],
					good_night: ["good night"],
					// Ends "show only NAME" before its minute is up.
					show_all: ["go back", "show everything"],
					good_morning: ["good morning"],
					weather: ["what is the weather", "how is the weather", "what's the weather", "what is the weather like"],
					what_is_next: ["what is next", "what is on my calendar", "what's next", "what is coming up"],
					// MMM-Voice answers these two itself.
					help: ["what can i say", "help"],
					cancel: ["never mind", "cancel"]
				},
				// Spoken name -> feature, for "show NAME", "hide NAME" and
				// "show only NAME", which puts that one alone on the screen.
				features: {
					clock: "clock",
					network: "unifi",
					"pokemon go": "MMM-PokemonGOEvents",
					"days together": "MMM-CoupleDays",
					calendar: "calendar",
					"work calendar": "work-calendar",
					tasks: "tasks",
					"work tasks": "work-tasks",
					photos: "photos",
					art: "art",
					weather: "weather",
					forecast: "forecast",
					news: "newsfeed",
					compliments: "compliments",
					moon: "MMM-MoonPhase",
					"air quality": "MMM-AirQuality",
					countdown: "MMM-CountEvents",
					pokemon: "MMM-DailyPokemon",
					"word of the day": "MMM-WordOfTheDay",
					history: "MMM-History",
					"space picture": "MMM-APOD",
					...(homeUrl ? { lights: "lights" } : {})
				},
				// "Turn on the NAME", "turn off the NAME", "set the NAME to fifty
				// percent", and a scene by its name.
				lights: spoken({ ...lights, ...floors }),
				scenes: spoken(scenes),
				// After "mirror" alone it waits this long for the command, and after
				// an answer it listens this long for another one.
				windowSeconds: 8,
				followUpSeconds: 5
			}
		},
		{
			module: "clock",
			position: "top_left"
		},
		// Google Calendar and Google Tasks, read-only, for each person's personal
		// and Merrows accounts. An account shows a sign-in note until
		// mirror/tools/google-connect.py has been run for it.
		googleCalendar("sam", "sam-personal", "Calendar", "calendar"),
		googleCalendar("sam", "sam-merrows", "Merrows calendar", "work-calendar"),
		googleCalendar("heather", "heather-personal", "Calendar", "calendar"),
		googleCalendar("heather", "heather-merrows", "Merrows calendar", "work-calendar"),
		googleTasks("sam", "sam-personal", "Tasks", "tasks"),
		googleTasks("sam", "sam-merrows", "Merrows tasks", "work-tasks"),
		googleTasks("heather", "heather-personal", "Tasks", "tasks"),
		googleTasks("heather", "heather-merrows", "Merrows tasks", "work-tasks"),
		{
			module: "weather",
			position: "top_right",
			config: {
				weatherProvider: "openmeteo",
				type: "current",
				lat: Number("${MIRROR_LAT}"),
				lon: Number("${MIRROR_LON}")
			}
		},
		{
			module: "weather",
			// Lists the forecast separately from the current weather on the settings page.
			classes: "feature-forecast",
			position: "top_right",
			header: "Forecast",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: Number("${MIRROR_LAT}"),
				lon: Number("${MIRROR_LON}")
			}
		},
		{
			module: "MMM-AirQuality",
			classes: "heather",
			position: "top_right",
			config: {
				lat: Number("${MIRROR_LAT}"),
				lon: Number("${MIRROR_LON}")
			}
		},
		{
			module: "MMM-MoonPhase",
			classes: "heather",
			position: "top_right",
			config: {
				size: 110,
				title: false,
				alpha: 0.85
			}
		},
		{
			// Shows only once MIRROR_TOGETHER_SINCE has a date in config.env.
			module: "MMM-CoupleDays",
			classes: "heather",
			position: "top_left",
			disabled: "${MIRROR_TOGETHER_SINCE}" === "",
			config: {
				name1: "Sam",
				name2: "Heather",
				date: "${MIRROR_TOGETHER_SINCE}"
			}
		},
		{
			// MMM-CountEvents needs this helper module. It draws nothing.
			module: "MMM-CustomElementTime"
		},
		{
			module: "MMM-CountEvents",
			classes: "sam heather",
			position: "top_left",
			config: {
				// The countdowns are private, so they live in config.env as JSON:
				// [{"title": "...", "targetTime": "2026-12-25", "repeat": "yearly", "unit": "day"}]
				// MagicMirror loads config.env before evaluating this server config.
				events: JSON.parse(process.env.MIRROR_EVENTS || "[]")
			}
		},
		{
			// Spoken answers ("mirror, good morning", "mirror, what is next")
			// and a special message on special days. The days are private and
			// live in config.env.
			module: "MMM-Briefing",
			position: "top_bar",
			config: {
				people: {
					sam: { name: "Sam" },
					heather: { name: "Heather" }
				},
				specialDays: JSON.parse(process.env.MIRROR_SPECIAL_DAYS || "[]")
			}
		},
		{
			// The mirror's voice. Other modules send TTS_SAY and this one speaks
			// through ElevenLabs or Cartesia and the USB speaker. The provider,
			// the voice and the API keys are in config.env. It draws nothing.
			module: "MMM-Speak",
			config: {
				provider: "${MIRROR_SPEECH_PROVIDER}",
				voiceId: "${MIRROR_SPEECH_VOICE}",
				// Voices each person can choose on the settings page. The two
				// values above are the built-in voice, used until someone chooses.
				voices: [
					{ id: "katie", name: "Katie", about: "Bright and upbeat.", provider: "cartesia", voiceId: "f786b574-daa5-4673-aa0c-cbe3e8534c02" },
					{ id: "lily", name: "Lily", about: "Casual and friendly.", provider: "cartesia", voiceId: "dda51133-5d43-4a3b-84e6-e68c13f60cba" },
					{ id: "layla", name: "Layla", about: "Casual and relaxed.", provider: "cartesia", voiceId: "999df508-4de5-40a7-8bd3-8c12f678c284" },
					{ id: "mason", name: "Mason", about: "Casual, a man's voice.", provider: "cartesia", voiceId: "b58b6b46-1a27-46ba-8648-bc203a5d394e" },
					{ id: "julia", name: "Julia", about: "British.", provider: "cartesia", voiceId: "273f9ef7-9fc2-4def-88bb-ab108c6249ca" },
					{ id: "archie", name: "Archie", about: "British, a man's voice.", provider: "cartesia", voiceId: "ef191366-f52f-447a-a398-ed8c0f2943a1" },
					{ id: "celine", name: "Celine", about: "Soft and soothing.", provider: "cartesia", voiceId: "ca566b43-944e-4474-b494-7d9f0695f307" },
					{ id: "romeo", name: "Romeo", about: "Deep and soothing.", provider: "cartesia", voiceId: "f688c0a6-dddd-48ba-8246-c099d494a162" },
					{ id: "wade", name: "Wade", about: "Playful.", provider: "cartesia", voiceId: "fbf7d2ec-ebea-49f2-8889-a482b9b0a7ed" }
				]
			}
		},
		{
			// Greets a recognized person. Heather's greeting comes with one of
			// her favorite Pokémon, a different one each day.
			module: "MMM-Greeter",
			position: "top_bar",
			config: {
				people: {
					sam: { name: "Sam" },
					heather: { name: "Heather", favorites: ["mew", "miltank", "celesteela"] }
				}
			}
		},
		{
			module: "compliments",
			classes: "sam",
			position: "top_bar"
		},
		{
			module: "compliments",
			classes: "heather",
			position: "top_bar",
			config: {
				// Starter lines. Sam replaces these with his own.
				compliments: {
					anytime: ["You look lovely today, Heather.", "A wild Heather appeared!", "Today feels like a shiny day."],
					morning: ["Good morning, Heather. Go catch the day.", "Coffee first, then the world."],
					afternoon: ["You are doing great today.", "Super effective, as always."],
					evening: ["Welcome home, Heather.", "You made today better."]
				}
			}
		},
		{
			module: "MMM-UniFi",
			classes: "sam heather feature-unifi",
			position: "top_right",
			config: {
				controllerUrl: "https://192.168.1.1",
				site: "default",
				credentialsFile: "~/mirror-data/unifi.json",
				// The local controller uses its own self-signed certificate.
				allowSelfSigned: true,
				theme: "inherit",
				pageSize: 6,
				rotationInterval: 12000
			}
		},
		// The lights the mirror can switch by voice, and what they are doing.
		// The Home Assistant token is SECRET_HA_TOKEN in config.env.
		...(homeUrl
			? [
				{
					module: "MMM-Lights",
					classes: "sam heather feature-lights",
					header: "Lights",
					position: "top_right",
					// The Govee rooms answer through Govee's servers, six to eight
					// seconds after a command. A light that answers sooner is not kept waiting.
					config: { url: homeUrl, lights: { ...lights, ...floors }, scenes, confirmSeconds: 12 }
				},
				// Plays the holiday station on the mirror's speaker while the
				// switch in Home Assistant is on. It shows nothing.
				{
					module: "MMM-Radio",
					config: { url: homeUrl, entity: "input_boolean.christmas_music", stream: process.env.MIRROR_RADIO_STREAM || "https://ice2.somafm.com/christmas-256-mp3", volume: 0.4 }
				}
			]
			: []),
		photoFrame("sam"),
		artFrame("heather"),
		{
			module: "MMM-PokemonGOEvents",
			classes: "sam heather",
			header: "Pokémon GO",
			position: "top_left",
			config: {
				category: "current",
				maxEvents: 3,
				truncateTitle: 42
			}
		},
		{
			// A different Pokémon each day, picked from the date. Both see it.
			module: "MMM-DailyPokemon",
			classes: "sam heather",
			position: "top_left",
			config: {
				pickByDate: true,
				stats: false,
				gbaMode: false,
				grayscale: false,
				nameSize: 22
			}
		},
		{
			module: "MMM-APOD",
			classes: "heather",
			position: "top_left",
			config: {
				maxMediaWidth: 420,
				maxMediaHeight: 300
			}
		},
		{
			module: "MMM-WordOfTheDay",
			classes: "heather",
			position: "top_right"
		},
		{
			module: "MMM-History",
			classes: "heather",
			position: "top_right",
			config: {
				maxWidth: "100%",
				maxLength: 220
			}
		},
		{
			module: "newsfeed",
			classes: "sam heather",
			position: "bottom_bar",
			config: {
				feeds: [
					{
						title: "NPR",
						url: "https://feeds.npr.org/1001/rss.xml"
					}
				],
				showSourceTitle: true,
				showPublishDate: true
			}
		}
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
