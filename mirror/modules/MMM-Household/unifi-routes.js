/* Expose only MMM-UniFi's read-only UI on the household listener. Never
 * forward arbitrary paths, request headers, cookies, or controller URLs. */
const ROUTES = ["/unifi/", "/unifi/assets/view.js", "/unifi/assets/unifi.css", "/unifi/assets/dashboard.js", "/unifi/api/snapshot"];

/**
 * Adds the UniFi dashboard to the LAN settings server.
 * @param {object} app the settings Express app, after its access middleware
 * @param {object} options the local MagicMirror port and base path
 * @param {number} options.port MagicMirror's local port
 * @param {string} options.basePath MagicMirror's URL prefix
 */
const addUniFiRoutes = (app, { port = 8080, basePath = "/" } = {}) => {
	app.get(/^\/unifi$/, (req, res) => res.redirect("/unifi/"));
	for (const route of ROUTES) {
		app.get(route === "/unifi/" ? /^\/unifi\/$/ : route, async (req, res) => {
			try {
				const response = await fetch(`http://localhost:${port}${basePath.replace(/\/$/, "")}${route}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
				if (!response.ok) {
					res.status(503).json({ error: "The network devices module is not available" });
					return;
				}
				res.set("Cache-Control", "no-store");
				res.type(response.headers.get("content-type") || "application/octet-stream");
				res.send(Buffer.from(await response.arrayBuffer()));
			} catch {
				res.status(503).json({ error: "The network devices module is not answering" });
			}
		});
	}
};

module.exports = { addUniFiRoutes, ROUTES };
