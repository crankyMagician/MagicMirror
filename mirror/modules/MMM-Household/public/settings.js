/* The settings page for the mirror. It talks to MMM-Household's node_helper
 * through /api on the same port and saves every change as it is made. */
(function () {
	const API = "/api";
	const PERSON_KEY = "household.person";

	let data = null;
	let person = null;
	// The page shows one person's settings or the mirror's own.
	let showMirror = false;
	let mirrorTimer = null;
	let mirrorRevision = 0;
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

	// What the mirror says about login: whether it is on and who is signed in.
	let session = { login: false, signedIn: true };
	let signedOut = false;

	// Calls the household's login server from the browser, with its cookies.
	const authCall = (path, options = {}) => fetch(session.authUrl + path, { credentials: "include", ...options });

	const SIGN_IN_ERRORS = {
		OAUTH_ACCOUNT_NOT_FOUND: "That Google account is not one of the mirror's people.",
		OAUTH_LOCAL_ACCOUNT_UNCONFIRMED: "That account is not ready for Google sign-in yet. Use the password."
	};

	// Replaces the settings with the sign-in form.
	const showSignIn = (note) => {
		signedOut = true;
		["people", "person-view", "mirror-view", "account"].forEach((id) => { $(id).hidden = true; });
		$("signin").hidden = false;
		$("signin-note").textContent = note || "";
		// The login cookie belongs to the mirror's own name. At any other
		// address the browser would not send it, so point there first.
		const elsewhere = session.home && new URL(session.home).origin !== window.location.origin;
		$("signin-ways").hidden = Boolean(elsewhere) || session.refused === true;
		$("signin-home").hidden = !elsewhere;
		if (elsewhere) {
			$("signin-home").href = session.home;
			$("signin-home").textContent = `Sign in at ${new URL(session.home).host}`;
		}
		$("signin-google").href = `${session.authUrl}/api/v1/auth/google`;
	};

	const signOut = async () => {
		await authCall("/api/v1/auth/logout", { method: "POST" }).catch(() => null);
		window.location.replace("/");
	};

	const bindSignIn = () => {
		$("signin-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			$("signin-note").textContent = "Signing in";
			try {
				const response = await authCall("/api/v1/auth/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ identifier: $("signin-email").value.trim().toLowerCase(), password: $("signin-password").value })
				});
				const body = await response.json().catch(() => ({}));
				if (response.ok && body.data && body.data.user) {
					window.location.replace("/");
					return;
				}
				$("signin-note").textContent = response.ok
					? "This account needs a second step that this page does not offer."
					: (body.error && body.error.message) || "That did not work. Check the address and the password.";
			} catch {
				$("signin-note").textContent = "The login server is not answering.";
			}
		});
	};

	const renderAccount = () => {
		const out = el("button", { type: "button", className: "link", textContent: "Sign out" });
		out.addEventListener("click", signOut);
		$("account").replaceChildren(`Signed in as ${session.email || "this mirror"} · `, out);
		$("account").hidden = false;
	};

	const request = async (path, options = {}, retried = false) => {
		const response = await fetch(API + path, options);
		const body = await response.json().catch(() => ({}));
		if (response.status === 401 && session.login && !signedOut) {
			// A sign-in lasts an hour. Ask the login server for a fresh one, once.
			const fresh = retried ? null : await authCall("/api/v1/auth/refresh", { method: "POST" }).catch(() => null);
			if (fresh && fresh.ok) {
				return request(path, options, true);
			}
			showSignIn("Your sign-in has run out.");
		}
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

	// Settings that belong to the mirror are saved together, a moment after
	// the last change.
	const saveMirror = () => {
		clearTimeout(mirrorTimer);
		const mirror = structuredClone(data.mirror);
		mirrorRevision += 1;
		const revision = mirrorRevision;
		mirrorTimer = setTimeout(async () => {
			try {
				const saved = await send("PUT", "/mirror", mirror);
				if (mirrorRevision === revision) {
					data.mirror = saved.mirror;
					data.blocks = saved.mirror.blocks;
				}
				showSaved("Saved");
			} catch (error) {
				showSaved(`Not saved: ${error.message}`, true);
			}
		}, 400);
	};

	const renderPeople = () => {
		const nav = $("people");
		nav.replaceChildren();
		data.people.forEach((name) => {
			const button = el("button", { type: "button", textContent: capitalize(name) });
			button.setAttribute("aria-pressed", String(!showMirror && name === person));
			button.addEventListener("click", () => {
				showMirror = false;
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
		const mirror = el("button", { type: "button", textContent: "Mirror" });
		mirror.setAttribute("aria-pressed", String(showMirror));
		mirror.addEventListener("click", () => {
			showMirror = true;
			render();
		});
		nav.append(mirror);
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
		const quiet = data.mirror.quietHours;
		$("quiet-enabled").checked = quiet.enabled;
		$("quiet-from").value = quiet.from;
		$("quiet-to").value = quiet.to;
		$("quiet-from").disabled = !quiet.enabled;
		$("quiet-to").disabled = !quiet.enabled;
	};

	// The direction the picture faces. Until someone chooses one here, the
	// menu shows the direction the kiosk started with.
	const renderRotation = () => {
		const menu = $("rotation");
		const offered = data.rotations || [];
		const current = data.mirror.rotation || data.rotationNow || "";
		const options = offered.map((rotation) => el("option", { value: rotation.value, textContent: rotation.label }));
		if (!offered.some((rotation) => rotation.value === current)) {
			options.unshift(el("option", { value: "", textContent: "As the mirror started" }));
		}
		menu.replaceChildren(...options);
		menu.value = offered.some((rotation) => rotation.value === current) ? current : "";
		menu.closest("section").hidden = offered.length === 0;
	};

	const bindRotation = () => {
		$("rotation").addEventListener("change", (event) => {
			if (event.target.value) {
				data.mirror.rotation = event.target.value;
				saveMirror();
			}
		});
	};

	// One time field per part of the day.
	const renderParts = () => {
		const rows = data.mirror.blocks.map((block) => {
			const input = el("input", { type: "time", value: block.from });
			input.addEventListener("change", () => {
				if (input.value) {
					block.from = input.value;
					saveMirror();
				}
			});
			return el("label", { className: "row" }, [el("span", { textContent: `${block.label} starts at` }), input]);
		});
		$("parts").replaceChildren(...rows);
	};

	// Fills a voice menu. The first entry stands for "no choice of my own".
	const fillVoices = (select, firstLabel, chosen) => {
		const options = [el("option", { value: "", textContent: firstLabel })];
		(data.voices || []).forEach((voice) => options.push(el("option", { value: voice.id, textContent: voice.name })));
		select.replaceChildren(...options);
		select.value = options.some((option) => option.value === chosen) ? chosen : "";
	};

	const aboutVoice = (id) => {
		const voice = (data.voices || []).find((entry) => entry.id === id);
		return voice ? voice.about : "";
	};

	const renderVoice = () => {
		const offered = (data.voices || []).length > 0;
		$("voice-section").hidden = !offered;
		$("mirror-voice-section").hidden = !offered;
		if (!offered) {
			return;
		}
		const speech = data.profiles[person].speech || { voice: "", volume: 100, speak: true };
		fillVoices($("voice"), "The mirror's voice", speech.voice);
		$("voice-about").textContent = aboutVoice(speech.voice);
		$("voice-volume").value = String(speech.volume);
		$("voice-speak").checked = speech.speak !== false;
		fillVoices($("mirror-voice"), "The built-in voice", data.mirror.voice || "");
	};

	// Plays a sample in the browser. The mirror itself stays silent.
	const hear = async (id, note) => {
		note.textContent = "Fetching the sample";
		try {
			const response = await fetch(`${API}/voices/${encodeURIComponent(id || "default")}/preview`);
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.error || "The sample is not available");
			}
			const sound = new Audio(URL.createObjectURL(await response.blob()));
			await sound.play();
			note.textContent = "";
		} catch (error) {
			note.textContent = error.message;
		}
	};

	const bindVoice = () => {
		const mine = () => {
			data.profiles[person].speech = data.profiles[person].speech || { voice: "", volume: 100, speak: true };
			return data.profiles[person].speech;
		};
		$("voice").addEventListener("change", (event) => {
			mine().voice = event.target.value;
			$("voice-about").textContent = aboutVoice(event.target.value);
			save();
		});
		$("voice-volume").addEventListener("change", (event) => {
			mine().volume = Number(event.target.value);
			save();
		});
		$("voice-speak").addEventListener("change", (event) => {
			mine().speak = event.target.checked;
			save();
		});
		$("voice-hear").addEventListener("click", () => hear($("voice").value || data.mirror.voice, $("voice-note")));
		$("mirror-voice").addEventListener("change", (event) => {
			data.mirror.voice = event.target.value;
			saveMirror();
		});
		$("mirror-voice-hear").addEventListener("click", () => hear($("mirror-voice").value, $("mirror-voice-note")));
	};

	// The mirror's name, and the words said before every command.
	const renderWake = () => {
		const mirror = data.mirror;
		$("mirror-title").textContent = mirror.name || "Mirror";
		if (document.activeElement !== $("mirror-name")) {
			$("mirror-name").value = mirror.name || "Mirror";
		}
		const phrase = mirror.wakePhrase || "mirror";
		$("wake-current").textContent = `You say "${phrase}" before every command, as in "${phrase}, good morning".`;
		$("wake-screen").checked = mirror.wakeScreen !== false;
		const trying = Boolean(mirror.wakeCandidate);
		$("wake-cancel").hidden = !trying;
		if (trying) {
			$("wake-note").textContent = `The mirror is also listening for "${mirror.wakeCandidate}". Say "${mirror.wakeCandidate}, wake up" at the mirror. The new phrase takes over once the mirror has heard it, and "${phrase}" keeps working until then.`;
		}
	};

	// What people can say, from the summary MMM-Voice keeps.
	const renderSay = () => {
		const summary = data.voiceCommands;
		$("say-section").hidden = !summary || !Array.isArray(summary.groups) || summary.groups.length === 0;
		if ($("say-section").hidden) {
			return;
		}
		const wake = (data.mirror.wakePhrase || summary.wake || "mirror");
		$("say-how").textContent = `Say "${wake}" first, in the same breath or alone. After "${wake}" alone, a blue light shows along the bottom of the screen and the mirror waits about 8 seconds for the command. After it answers, it listens a few seconds more for another one.`;
		$("say-list").replaceChildren(...summary.groups.map((group) => el("div", { className: "say-group" }, [
			el("h3", { textContent: group.title }),
			el("ul", {}, group.say.map((phrase) => el("li", { textContent: `${wake} ${phrase}` }))),
			...group.names.length > 0 ? [el("p", { className: "hint", textContent: `NAME is one of: ${group.names.join(", ")}` })] : []
		])));
	};

	const bindWake = () => {
		$("wake-screen").addEventListener("change", (event) => {
			data.mirror.wakeScreen = event.target.checked;
			saveMirror();
		});
		$("mirror-name").addEventListener("change", (event) => {
			const name = event.target.value.trim();
			if (name) {
				data.mirror.name = name;
				$("mirror-title").textContent = name;
				saveMirror();
			}
		});
		// The mirror checks a new phrase against its speech model, which takes
		// a few seconds, so this is sent at once and the answer shown.
		const propose = async (candidate) => {
			$("wake-note").textContent = candidate ? "Checking that the mirror knows those words" : "";
			try {
				const saved = await send("PUT", "/mirror", { ...structuredClone(data.mirror), wakeCandidate: candidate });
				data.mirror = saved.mirror;
				data.blocks = saved.mirror.blocks;
				if (!saved.mirror.wakeCandidate) {
					$("wake-note").textContent = candidate ? "That is the phrase the mirror already uses." : "";
				}
				$("wake-new").value = "";
			} catch (error) {
				$("wake-note").textContent = error.message;
			}
			renderWake();
		};
		$("wake-try").addEventListener("click", () => {
			const candidate = $("wake-new").value.trim();
			if (candidate) {
				propose(candidate);
			}
		});
		$("wake-cancel").addEventListener("click", () => propose(""));
	};

	const renderFace = () => {
		const known = data.enrolled.includes(person);
		$("face-state").textContent = known
			? `The mirror knows ${capitalize(person)}'s face. Teach it again if it stops recognizing you, for example after new glasses.`
			: `The mirror does not know ${capitalize(person)}'s face yet.`;
		$("enroll").disabled = !data.now.camera;
	};

	// Tells whether the chosen person has a feature on their view, for
	// example a photo frame or an art frame.
	const has = (key) => data.features.some((feature) => feature.key === key && (feature.owners.length === 0 || feature.owners.includes(person)));

	const setDate = (stamp) => {
		const date = new Date(stamp);
		return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "long", day: "numeric" });
	};

	// Paintings arrive from a feed on their own, so there is nothing to press.
	const loadArt = async () => {
		const name = person;
		$("art-section").hidden = !has("art");
		if (!has("art")) {
			return;
		}
		try {
			const art = await request(`/art/${encodeURIComponent(name)}`);
			if (name !== person) {
				return;
			}
			const since = setDate(art.updated);
			const count = art.count === 1 ? "1 painting" : `${art.count} paintings`;
			$("art-state").textContent = art.note
			  || (art.count === 0 ? "Your frame has no paintings yet." : `Your frame shows ${count}${since ? ` from the set of ${since}` : ""}. A new set arrives every week.`);
		} catch {
			$("art-state").textContent = "";
		}
	};

	// What the mirror last said about the chosen person's photos.
	let photos = { count: 0, picking: false, note: "" };

	const renderPhotos = () => {
		const count = photos.count;
		$("photos-state").textContent = count === 0
			? "Your slideshow has no photos yet. Choose some from your Google Photos and the mirror keeps a copy."
			: `Your slideshow has ${count} photo${count === 1 ? "" : "s"}. Choose more at any time.`;
		$("photos-pick").textContent = photos.picking ? "Open the Google Photos page again" : "Choose photos from Google Photos";
		$("photos-clear").hidden = count === 0;
		$("photos-note").textContent = photos.note || "";
	};

	const loadPhotos = async () => {
		const name = person;
		$("photos-section").hidden = !has("photos");
		if (!has("photos")) {
			return;
		}
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
		$("person-view").hidden = showMirror;
		$("mirror-view").hidden = !showMirror;
		renderGrid();
		renderQuiet();
		renderParts();
		renderRotation();
		renderVoice();
		renderWake();
		renderSay();
		renderFace();
		photos = { count: 0, picking: false, note: "" };
		renderPhotos();
		loadPhotos();
		$("art-state").textContent = "";
		loadArt();
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
			data.mirror.quietHours.enabled = event.target.checked;
			renderQuiet();
			saveMirror();
		});
		["from", "to"].forEach((end) => {
			$(`quiet-${end}`).addEventListener("change", (event) => {
				if (event.target.value) {
					data.mirror.quietHours[end] = event.target.value;
					saveMirror();
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
		if (signedOut) {
			return;
		}
		loadPhotos();
		loadArt();
		try {
			const fresh = await request("/state");
			data.now = fresh.now;
			data.enrolled = fresh.enrolled;
			// A wake phrase on trial takes over when the mirror hears it. Show that
			// without touching anything the person may be changing.
			if (fresh.mirror && data.mirror && (fresh.mirror.wakePhrase !== data.mirror.wakePhrase || fresh.mirror.wakeCandidate !== data.mirror.wakeCandidate)) {
				const tookOver = Boolean(data.mirror.wakeCandidate) && fresh.mirror.wakePhrase === data.mirror.wakeCandidate;
				data.mirror.wakePhrase = fresh.mirror.wakePhrase;
				data.mirror.wakeCandidate = fresh.mirror.wakeCandidate;
				$("wake-note").textContent = tookOver ? `The mirror heard you. "${fresh.mirror.wakePhrase}" is the wake phrase now.` : "";
				renderWake();
			}
			$("live").textContent = describeLive(data.now);
			renderFace();
		} catch {
			$("live").textContent = "The mirror is not answering";
		}
	};

	const start = async () => {
		try {
			session = await (await fetch(`${API}/session`)).json();
		} catch {
			session = { login: false, signedIn: true };
		}
		if (session.login === true) {
			bindSignIn();
			if (!session.signedIn) {
				const code = new URLSearchParams(window.location.search).get("error");
				if (session.refused) {
					const out = el("button", { type: "button", className: "link", textContent: "Sign out and use another account" });
					out.addEventListener("click", signOut);
					showSignIn(session.problem);
					$("signin-note").append(" ", out);
				} else {
					showSignIn(SIGN_IN_ERRORS[code] || (code ? "Signing in with Google did not work." : session.problem && session.problem.startsWith("The login server") ? session.problem : ""));
				}
				return;
			}
			renderAccount();
			if (window.location.pathname === "/login") {
				window.history.replaceState(null, "", "/");
			}
		}
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
		// A signed-in person starts on their own settings.
		if (data.people.includes(session.person)) {
			person = session.person;
		}
		$("theme").addEventListener("change", (event) => {
			data.profiles[person].theme = event.target.value;
			renderAppearance();
			save();
		});
		bindQuiet();
		bindRotation();
		bindVoice();
		bindWake();
		bindEnroll();
		bindPhotos();
		render();
		setInterval(poll, 5000);
	};

	start();
}());
