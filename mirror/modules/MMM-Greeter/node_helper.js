const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const NodeHelper = require("node_helper");
const Log = require("logger");

const DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(os.homedir(), "mirror-data");
const SPRITE_DIR = path.join(DATA_DIR, "sprites");
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TIMEOUT = 20000;

/* Keeps one picture per favorite Pokémon on the Pi. Each picture is downloaded
 * once from the PokéAPI sprite collection and then served from disk, so the
 * greeting works without the network. The pictures are not part of this
 * repository. */
module.exports = NodeHelper.create({
	start () {
		fs.mkdirSync(SPRITE_DIR, { recursive: true });
		this.expressApp.use("/greeter/sprites", express.static(SPRITE_DIR, { maxAge: "7d" }));
	},

	async socketNotificationReceived (notification, payload) {
		if (notification !== "SPRITES" || !Array.isArray(payload)) {
			return;
		}
		const ready = {};
		for (const name of payload) {
			if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
				Log.warn(`Ignored the Pokémon name ${JSON.stringify(name)}. Use PokéAPI spelling, for example "mr-mime".`);
				continue;
			}
			try {
				await this.ensureSprite(name);
				ready[name] = `/greeter/sprites/${name}.png`;
			} catch (error) {
				Log.warn(`No picture for ${name}: ${error.message}`);
			}
		}
		this.sendSocketNotification("SPRITES_READY", ready);
	},

	async ensureSprite (name) {
		const file = path.join(SPRITE_DIR, `${name}.png`);
		if (fs.existsSync(file) && fs.statSync(file).size > 0) {
			return;
		}
		const lookup = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`, { signal: AbortSignal.timeout(TIMEOUT) });
		if (!lookup.ok) {
			throw new Error(`PokéAPI answered ${lookup.status}`);
		}
		const pokemon = await lookup.json();
		const artwork = pokemon.sprites && pokemon.sprites.other && pokemon.sprites.other["official-artwork"];
		const url = (artwork && artwork.front_default) || (pokemon.sprites && pokemon.sprites.front_default);
		// Only download from the sprite collection PokéAPI points to.
		if (typeof url !== "string" || !url.startsWith("https://raw.githubusercontent.com/PokeAPI/sprites/")) {
			throw new Error("PokéAPI gave no picture");
		}
		const image = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
		if (!image.ok) {
			throw new Error(`The picture download answered ${image.status}`);
		}
		const temporary = `${file}.tmp`;
		fs.writeFileSync(temporary, Buffer.from(await image.arrayBuffer()));
		fs.renameSync(temporary, file);
		Log.log(`Saved a picture of ${name}`);
	}
});
