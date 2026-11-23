/* MagicMirror config for the household mirror.
 *
 * setup-pi.sh links this file to config/config.js on the Pi.
 *
 * Values written as ${NAME} come from config/config.env on the Pi, which is
 * not committed (see config.env.sample). MagicMirror hides any name that
 * starts with SECRET_ from the copy of this config it sends to the browser.
 */
let config = {
	// The mirror listens on the home network so phones can open the settings
	// page at http://mirror.local:8080/household. The whitelist limits that to
	// the two home subnets.
	address: "0.0.0.0",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::1", "192.168.1.0/24", "192.168.10.0/24"],

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
				absentDelay: 60
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
			module: "compliments",
			classes: "sam heather",
			position: "lower_third"
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
