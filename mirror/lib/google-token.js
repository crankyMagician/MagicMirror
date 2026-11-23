/* Shared by our modules that read Google APIs with a per-account token file
 * written by mirror/tools/google-connect.py. */
const fs = require("node:fs");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT = 20000;

/** An error that means the account has to sign in again. */
class SignInNeeded extends Error {}

/**
 * Tells whether a stored token needs refreshing before use.
 * @param {object} token the stored token
 * @param {number} now the current time in ms
 * @returns {boolean} true when there is no access token or it expires within a minute
 */
const needsRefresh = (token, now) => !token.access_token || !token.expiry_date || token.expiry_date - now < 60 * 1000;

/**
 * Tells whether a stored token was granted a scope.
 * @param {object} token the stored token
 * @param {string} scope a full scope URL
 * @returns {boolean} true when the token's scope list includes it
 */
const hasScope = (token, scope) => String(token.scope || "").split(/\s+/).includes(scope);

/**
 * Returns a working access token for one account, refreshing it when needed.
 * @param {string} tokenFile the account's token file
 * @param {string} credentialsFile the OAuth client file
 * @param {string} [scope] a scope the token must have been granted
 * @returns {Promise<string>} an access token
 */
const accessToken = async (tokenFile, credentialsFile, scope) => {
	let token;
	let client;
	try {
		token = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
	} catch {
		throw new SignInNeeded("no sign-in yet");
	}
	if (scope && !hasScope(token, scope)) {
		throw new SignInNeeded("the sign-in does not include this kind of access");
	}
	if (!needsRefresh(token, Date.now())) {
		return token.access_token;
	}
	if (!token.refresh_token) {
		throw new SignInNeeded("the stored sign-in cannot be renewed");
	}
	try {
		client = JSON.parse(fs.readFileSync(credentialsFile, "utf8")).installed;
	} catch (error) {
		throw new Error(`cannot read the OAuth client file: ${error.message}`, { cause: error });
	}
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" }),
		signal: AbortSignal.timeout(TIMEOUT)
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		if (body.error === "invalid_grant") {
			throw new SignInNeeded("the sign-in was revoked or has expired");
		}
		throw new Error(`Google answered ${response.status} to the token refresh`);
	}
	const renewed = { access_token: body.access_token, expiry_date: Date.now() + (body.expires_in || 3600) * 1000 };
	// Re-read before writing, because another module may have renewed the same file.
	try {
		const current = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
		fs.writeFileSync(tokenFile, JSON.stringify({ ...current, ...renewed }), { mode: 0o600 });
	} catch {
		// The token still works for this call. The next call renews it again.
	}
	return renewed.access_token;
};

module.exports = { SignInNeeded, accessToken, hasScope, needsRefresh };
