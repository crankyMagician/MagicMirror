/* The settings page for the mirror. It talks to MMM-Household's node_helper
 * through /api on the same port and saves every change as it is made. */
(function () {
	const API = "/api";
	const PERSON_KEY = "household.person";

	let data = null;
	let person = null;
	const saveTimers = new Map();
	const revisions = new Map();

	const $ = (id) => document.getElementById(id);
	const capitalize = (name) => name.charAt(0).toUpperCase() + name.slice(1);

	const el = (tag, props = {}, children = []) => {
		const node = Object.assign(document.createElement(tag), props);
		children.forEach((child) => node.append(child));
		return node;
	};

	const hour = (time) => {
		const [hours, minutes] = time.split(":").map(Number);
		const suffix = hours < 12 ? "am" : "pm";
		const shown = hours % 12 === 0 ? 12 : hours % 12;
		return minutes === 0 ? `${shown} ${suffix}` : `${shown}:${String(minutes).padStart(2, "0")} ${suffix}`;
	};

	const showSaved = (text, isError = false) => {
		const saved = $("saved");
		saved.textContent = text;
		saved.classList.toggle("error", isError);
		if (!isError) {
			setTimeout(() => {
				if (saved.textContent === text) {
					saved.textContent = "";
				}
			}, 2000);
		}
	};

	const request = async (path, options = {}) => {
		const response = await fetch(API + path, options);
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(body.error || `The mirror answered ${response.status}`);
		}
		return body;
	};

	const send = (method, path, payload) => request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

	const describeLive = (now) => {
		if (!now.camera) {
			return "The camera is not running";
		}
		let seen = "The mirror sees nobody";
		if (now.person === "guest") {
			seen = "The mirror sees a guest";
		} else if (now.person) {
			seen = `The mirror sees ${capitalize(now.person)}`;
		} else if (now.unknown) {
			seen = "The mirror sees someone it does not know";
		}
		if (now.quiet) {
			return `${seen}, in quiet hours`;
		}
		return now.screenOn ? seen : `${seen}. The screen is off`;
	};

	const save = () => {
		const name = person;
		clearTimeout(saveTimers.get(name));
		const profile = structuredClone(data.profiles[name]);
		const revision = (revisions.get(name) || 0) + 1;
		revisions.set(name, revision);
		saveTimers.set(name, setTimeout(async () => {
			try {
				const saved = await send("PUT", `/profiles/${encodeURIComponent(name)}`, profile);
				if (revisions.get(name) === revision) {
					data.profiles[name] = saved.profile;
				}
				showSaved("Saved");
			} catch (error) {
				showSaved(`Not saved: ${error.message}`, true);
			}
		}, 400));
	};

	const renderPeople = () => {
		const nav = $("people");
		nav.replaceChildren();
		data.people.forEach((name) => {
			const button = el("button", { type: "button", textContent: capitalize(name) });
			button.setAttribute("aria-pressed", String(name === person));
			button.addEventListener("click", () => {
				person = name;
				try {
					localStorage.setItem(PERSON_KEY, name);
				} catch {
					// Private browsing can refuse storage. The choice then lasts for this visit.
				}
				render();
			});
			nav.append(button);
		});
	};

	const renderGrid = () => {
		const profile = data.profiles[person];
		const features = data.features.filter((feature) => feature.owners.length === 0 || feature.owners.includes(person));
		const blocks = data.blocks;

		const headRow = el("tr", {}, [el("td")]);
		blocks.forEach((block, index) => {
			const next = blocks[(index + 1) % blocks.length];
			const cell = el("th", { scope: "col" }, [block.label, el("small", { textContent: `${hour(block.from)} to ${hour(next.from)}` })]);
			cell.classList.toggle("now", block.key === data.now.block);
			headRow.append(cell);
		});

		const body = el("tbody");
		features.forEach((feature) => {
			const row = el("tr", {}, [el("th", { scope: "row", textContent: feature.label })]);
			blocks.forEach((block) => {
				const box = el("input", { type: "checkbox", checked: profile.blocks[block.key][feature.key] !== false });
				box.setAttribute("aria-label", `${feature.label}, ${block.label.toLowerCase()}`);
				box.addEventListener("change", () => {
					profile.blocks[block.key][feature.key] = box.checked;
					save();
				});
				row.append(el("td", {}, [box]));
			});
			body.append(row);
		});

		$("grid").replaceChildren(el("thead", {}, [headRow]), body);
	};

	const renderQuiet = () => {
		const quiet = data.profiles[person].quietHours;
		$("quiet-enabled").checked = quiet.enabled;
		$("quiet-from").value = quiet.from;
		$("quiet-to").value = quiet.to;
		$("quiet-from").disabled = !quiet.enabled;
		$("quiet-to").disabled = !quiet.enabled;
	};

	const renderFace = () => {
		const known = data.enrolled.includes(person);
		$("face-state").textContent = known
			? `The mirror knows ${capitalize(person)}'s face. Teach it again if it stops recognizing you, for example after new glasses.`
			: `The mirror does not know ${capitalize(person)}'s face yet.`;
		$("enroll").disabled = !data.now.camera;
	};

	// What the mirror last said about the chosen person's photos.
	let photos = { count: 0, picking: false, note: "" };

	const renderPhotos = () => {
		const count = photos.count;
		$("photos-state").textContent = count === 0
			? "Your slideshow has no photos yet. Choose some from your Google Photos and the mirror keeps a copy."
			: `Your slideshow has ${count} photo${count === 1 ? "" : "s"}. Choose more at any time.`;
		$("photos-pick").disabled = photos.picking;
		$("photos-clear").hidden = count === 0;
		$("photos-note").textContent = photos.note || "";
	};

	const loadPhotos = async () => {
		const name = person;
		try {
			const fresh = await request(`/photos/${encodeURIComponent(name)}`);
			if (name === person) {
				photos = fresh;
				renderPhotos();
			}
		} catch {
			// The live line already says when the mirror is not answering.
		}
	};

	const render = () => {
		$("live").textContent = describeLive(data.now);
		renderAppearance();
		renderPeople();
		renderGrid();
		renderQuiet();
		renderFace();
		photos = { count: 0, picking: false, note: "" };
		renderPhotos();
		loadPhotos();
	};

	const renderAppearance = () => {
		const theme = data.profiles[person].theme === "light" ? "light" : "dark";
		document.documentElement.dataset.theme = theme;
		$("theme").value = theme;
		$("network-link").href = `/unifi/?from=household&theme=${theme}`;
		$("network-section").hidden = !data.features.some((feature) => feature.key === "unifi");
	};

	const bindQuiet = () => {
		$("quiet-enabled").addEventListener("change", (event) => {
			data.profiles[person].quietHours.enabled = event.target.checked;
			renderQuiet();
			save();
		});
		["from", "to"].forEach((end) => {
			$(`quiet-${end}`).addEventListener("change", (event) => {
				if (event.target.value) {
					data.profiles[person].quietHours[end] = event.target.value;
					save();
				}
			});
		});
	};

	const bindEnroll = () => {
		$("enroll").addEventListener("click", async () => {
			const note = $("enroll-note");
			try {
				await send("POST", "/enroll", { name: person });
				note.textContent = "Stand in front of the mirror now and turn your head slowly. It takes about ten seconds, and the mirror says when it is done.";
			} catch (error) {
				note.textContent = `That did not start: ${error.message}`;
			}
		});
	};

	// Keeps the line at the top and the face status current without touching
	// switches the person may be in the middle of changing.
	const bindPhotos = () => {
		$("photos-pick").addEventListener("click", async () => {
			// Open the tab during the click, or the browser blocks it as a pop-up.
			const tab = window.open("about:blank", "_blank");
			try {
				const opened = await send("POST", `/photos/${encodeURIComponent(person)}/pick`, {});
				if (tab) {
					tab.location = opened.pickerUri;
					photos = { ...photos, picking: true, note: "Choose your photos on the Google page. They appear on the mirror a minute after you finish." };
				} else {
					photos = { ...photos, picking: true, note: "Your browser blocked the new tab. Allow pop-ups for this page and try again in a few minutes." };
				}
			} catch (error) {
				if (tab) {
					tab.close();
				}
				photos = { ...photos, note: error.message };
			}
			renderPhotos();
		});

		// Removing photos takes two taps, so one slip does not empty the slideshow.
		let armed = null;
		$("photos-clear").addEventListener("click", async (event) => {
			const button = event.target;
			if (!armed) {
				button.textContent = "Tap again to remove them all";
				armed = setTimeout(() => {
					armed = null;
					button.textContent = "Remove all my photos";
				}, 4000);
				return;
			}
			clearTimeout(armed);
			armed = null;
			button.textContent = "Remove all my photos";
			try {
				await send("POST", `/photos/${encodeURIComponent(person)}/clear`, {});
				photos = { count: 0, picking: photos.picking, note: "Removed." };
			} catch (error) {
				photos = { ...photos, note: error.message };
			}
			renderPhotos();
		});
	};

	const poll = async () => {
		loadPhotos();
		try {
			const fresh = await request("/state");
			data.now = fresh.now;
			data.enrolled = fresh.enrolled;
			$("live").textContent = describeLive(data.now);
			renderFace();
		} catch {
			$("live").textContent = "The mirror is not answering";
		}
	};

	const start = async () => {
		try {
			data = await request("/state");
		} catch (error) {
			$("live").textContent = `The mirror is not answering: ${error.message}`;
			setTimeout(start, 3000);
			return;
		}
		let remembered;
		try {
			remembered = localStorage.getItem(PERSON_KEY);
		} catch {
			remembered = null;
		}
		person = data.people.includes(remembered) ? remembered : data.people[0];
		$("theme").addEventListener("change", (event) => {
			data.profiles[person].theme = event.target.value;
			renderAppearance();
			save();
		});
		bindQuiet();
		bindEnroll();
		bindPhotos();
		render();
		setInterval(poll, 5000);
	};

	start();
}());
