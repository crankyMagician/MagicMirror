/* MagicMirror config for the household mirror.
 *
 * setup-pi.sh links this file to config/config.js on the Pi.
 *
 * Values written as ${NAME} come from config/config.env on the Pi, which is
 * not committed (see config.env.sample). MagicMirror hides any name that
 * starts with SECRET_ from the copy of this config it sends to the browser.
 */
let config = {
	// MagicMirror answers only on the Pi itself. The settings page that phones
	// open is served separately by MMM-Household (see settingsPort below).
	address: "localhost",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::1"],

	language: "en",
	locale: "en-US",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 12,
	units: "imperial",

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
				settingsAllow: ["127.0.0.1", "::1", "192.168.1.0/24", "192.168.10.0/24"],
				// Names on the settings page for the third-party modules below.
				labels: {
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
				// Spoken name -> feature, for "show NAME" and "hide NAME".
				features: {
					calendar: "calendar",
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
					"space picture": "MMM-APOD"
				}
			}
		},
		{
			module: "clock",
			position: "top_left"
		},
		{
			module: "calendar",
			classes: "sam",
			header: "Sam's calendar",
			position: "top_left",
			config: {
				calendars: [
					{
						symbol: "calendar-check",
						url: "${SECRET_CALENDAR_URL_SAM}"
					}
				]
			}
		},
		{
			module: "calendar",
			classes: "heather",
			header: "Heather's calendar",
			position: "top_left",
			config: {
				calendars: [
					{
						symbol: "calendar-check",
						url: "${SECRET_CALENDAR_URL_HEATHER}"
					}
				]
			}
		},
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
				// A title cannot contain a single quote.
				events: JSON.parse('${MIRROR_EVENTS}')
			}
		},
		{
			// Greets a recognized person. Heather's greeting comes with one of
			// her favorite Pokémon, a different one each day.
			module: "MMM-Greeter",
			position: "upper_third",
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
			position: "middle_center"
		},
		{
			module: "compliments",
			classes: "heather",
			position: "middle_center",
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
			module: "MMM-PokemonGOEvents",
			classes: "sam heather",
			header: "Pokémon GO",
			position: "bottom_left",
			config: {
				category: "current",
				maxEvents: 3,
				truncateTitle: 42
			}
		},
		{
			module: "MMM-APOD",
			classes: "heather",
			position: "bottom_left",
			config: {
				maxMediaWidth: 420,
				maxMediaHeight: 300
			}
		},
		{
			// A different Pokémon each day, picked from the date.
			module: "MMM-DailyPokemon",
			classes: "heather",
			position: "bottom_right",
			config: {
				pickByDate: true,
				stats: false,
				gbaMode: false,
				grayscale: false,
				nameSize: 22
			}
		},
		{
			module: "MMM-WordOfTheDay",
			classes: "heather",
			position: "bottom_right"
		},
		{
			module: "MMM-History",
			classes: "heather",
			position: "bottom_right",
			config: {
				maxWidth: "420px",
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
