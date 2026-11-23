/* MagicMirror config for the household mirror.
 *
 * setup-pi.sh links this file to config/config.js on the Pi.
 *
 * Values written as ${NAME} come from config/config.env on the Pi, which is
 * not committed (see config.env.sample). MagicMirror hides any name that
 * starts with SECRET_ from the copy of this config it sends to the browser.
 */
let config = {
	address: "localhost",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],

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
			module: "clock",
			position: "top_left"
		},
		{
			module: "calendar",
			header: "Calendar",
			position: "top_left",
			config: {
				calendars: [
					{
						symbol: "calendar-check",
						url: "${SECRET_CALENDAR_URL}"
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
			position: "lower_third"
		},
		{
			module: "newsfeed",
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
