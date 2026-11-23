/* MMM-AirQuality
 *
 * Shows the current US air quality index for one place. The data comes from
 * Open-Meteo's air quality API, which needs no account or key.
 *
 *   {
 *     module: "MMM-AirQuality",
 *     position: "top_right",
 *     config: { lat: 37.77, lon: -122.42 }
 *   }
 */
Module.register("MMM-AirQuality", {
	defaults: {
		lat: 0,
		lon: 0,
		// Minutes between updates. Open-Meteo publishes a new value each hour.
		updateMinutes: 30,
		// Show the fine-particle reading under the index.
		showParticles: false,
		apiBase: "https://air-quality-api.open-meteo.com/v1/air-quality"
	},

	// Upper bound of each US AQI band, its name and its standard color.
	bands: [
		{ max: 50, label: "Good", color: "#5fc66b" },
		{ max: 100, label: "Moderate", color: "#e8d44d" },
		{ max: 150, label: "Unhealthy for sensitive groups", color: "#f0943a" },
		{ max: 200, label: "Unhealthy", color: "#e5534b" },
		{ max: 300, label: "Very unhealthy", color: "#a868c9" },
		{ max: Infinity, label: "Hazardous", color: "#a0495b" }
	],

	start () {
		this.reading = null;
		this.failed = false;
		this.load();
		setInterval(() => this.load(), this.config.updateMinutes * 60 * 1000);
	},

	getStyles () {
		return [this.file("MMM-AirQuality.css")];
	},

	bandFor (index) {
		return this.bands.find((band) => index <= band.max);
	},

	async load () {
		const query = new URLSearchParams({
			latitude: this.config.lat,
			longitude: this.config.lon,
			current: "us_aqi,pm2_5",
			timezone: "auto"
		});
		try {
			const response = await fetch(`${this.config.apiBase}?${query}`, { signal: AbortSignal.timeout(20000) });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json();
			const index = data.current && data.current.us_aqi;
			if (typeof index !== "number") {
				throw new Error("The response has no us_aqi value");
			}
			this.reading = { index: Math.round(index), particles: data.current.pm2_5 };
			this.failed = false;
		} catch (error) {
			Log.warn(`[MMM-AirQuality] Could not load air quality: ${error.message}`);
			this.failed = true;
			// Keep showing the last reading, and try again sooner than the normal interval.
			setTimeout(() => this.load(), 5 * 60 * 1000);
		}
		this.updateDom(500);
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "air-quality";
		if (!this.reading) {
			wrapper.classList.add("dimmed", "small");
			wrapper.textContent = this.failed ? "Air quality is not available" : "Loading air quality";
			return wrapper;
		}

		const band = this.bandFor(this.reading.index);
		const line = document.createElement("div");
		line.className = "air-quality-line small";

		const dot = document.createElement("span");
		dot.className = "air-quality-dot";
		dot.style.backgroundColor = band.color;

		const value = document.createElement("span");
		value.className = "bright";
		value.textContent = `Air ${this.reading.index}`;

		const label = document.createElement("span");
		label.className = "air-quality-label";
		label.textContent = band.label;

		line.append(dot, value, label);
		wrapper.append(line);

		if (this.config.showParticles && typeof this.reading.particles === "number") {
			const particles = document.createElement("div");
			particles.className = "xsmall dimmed";
			particles.textContent = `PM2.5 ${this.reading.particles.toFixed(1)} µg/m³`;
			wrapper.append(particles);
		}
		return wrapper;
	}
});
