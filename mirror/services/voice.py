#!/usr/bin/env python3
"""Listens for spoken commands that start with the wake word, offline.

MMM-Voice's node_helper starts this script, sends it the command list, and
reads one JSON object per line from its stdout:

    {"type": "ready", "phrases": 14}
    {"type": "listening", "on": true}          the wake word began an utterance
    {"type": "window", "open": true, "seconds": 8, "reason": "wake"}
    {"type": "command", "id": "good_night", "text": "mirror good night", "confidence": 0.97, "window": null}
    {"type": "missed", "text": "mirror turn of the kitchen", "confidence": 0.62, "why": "low", "window": "wake"}
    {"type": "level", "value": 0.4}            voice level, only while listening
    {"type": "thinking"}                       the words are being transcribed
    {"type": "transcript", "text": "Mirror, turn off the kitchen.", "confidence": 0.98, "window": null}
    {"type": "utterance", "text": "turn off the kitchen.", "confidence": 0.98, "window": null}
    {"type": "stt_failed", "message": "..."}   Deepgram did not answer, Vosk's result is used
    {"type": "error", "message": "..."}

It reads commands from stdin, also one JSON object per line:

    {"cmd": "commands", "wakes": ["mirror"], "commands": [{"id": "good_night", "phrases": ["mirror good night"], "bare": ["good night"]}],
     "keyterms": ["mirror", "nook"], "defer": ["light:on:"]}
    {"cmd": "mute", "on": true}
    {"cmd": "hold", "seconds": 0.4}            drop the audio while a tone plays
    {"cmd": "follow_up", "seconds": 5}         listen without the wake word for a while

A command can be said in one breath ("mirror, good night"), or the wake
word can come alone. Then a window opens for a few seconds in which the
command needs no wake word. Outside a window the phrases without the wake
word are not in the recognizer's grammar at all, so background talk cannot
set them off.

Vosk, with a fixed phrase list, finds the wake word on the Pi. It can only
ever answer with one of the listed phrases or "[unk]", so it turns any other
sentence into nonsense. With --transcribe deepgram, the audio of an
utterance that starts with the wake word (or that falls in a window) also
goes to Deepgram, which writes down what was really said. That text is
matched against the commands, and a sentence that is no command comes out as
an "utterance" for other modules (Home Assistant, questions). Vosk's own
result is held meanwhile and used when Deepgram does not answer, so the
mirror still works without the internet. Commands whose id starts with a
"defer" prefix (the light switches) are left to the utterance while
Deepgram answers.

Audio is read from the microphone through arecord and stays in memory.
Nothing is stored. Nothing is sent anywhere before the wake word, and only
the seconds after it go to Deepgram. While muted (the mirror itself is
speaking) audio is discarded.
"""

from __future__ import annotations

import argparse
import array
import collections
import difflib
import io
import json
import math
import os
import queue
import re
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
import wave
from pathlib import Path

DATA_DIR = Path(os.environ.get("MIRROR_DATA_DIR", Path.home() / "mirror-data"))
MODEL_DIR = DATA_DIR / "models" / "vosk-model-small-en-us-0.15"
SAMPLE_RATE = 16000
CHUNK_BYTES = 2000 * 2  # an eighth of a second of 16-bit mono audio
UNKNOWN = "[unk]"
DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"
# Deepgram takes up to about 500 tokens of key terms per request.
MAX_KEYTERMS = 80
# A second of audio from before the wake word was recognized, so its start is not cut off.
PREROLL_CHUNKS = 8
# One utterance is sent after this long at the latest.
MAX_CAPTURE_SECONDS = 12.0
# Vosk ends an utterance early at words it does not know, so a capture goes on
# until the speaker is quiet this long. After the first part of a command
# ("turn off the kitchen" could become "... lights") it waits a little longer.
QUIET_SECONDS = 0.5
QUIET_AFTER_PART_SECONDS = 1.2
# ... and never longer than this after Vosk's verdict.
MAX_TAIL_SECONDS = 3.0


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def normalize(phrase: str) -> str:
    """Lowercases a phrase and strips punctuation, the form Vosk answers in."""
    kept = "".join(char if char.isalnum() or char in " '" else " " for char in phrase.lower())
    return " ".join(kept.split())


def confidence_of(result: dict) -> float:
    """Averages the per-word confidence of a Vosk final result."""
    words = result.get("result", [])
    return sum(word.get("conf", 0.0) for word in words) / len(words) if words else 0.0


# Words people put in or leave out without changing what they ask for.
# "Turn off upstairs lights" is the same command as "turn off the upstairs lights".
FILLER = {"the", "a", "an", "please"}


class Commands:
    """Maps each phrase to its command id and builds the Vosk grammars.

    Besides the exact phrases it keeps a loose form of each, without filler
    words, and every first part of a phrase, so a command cut in two by a
    pause can be put back together.
    """

    def __init__(self, commands: list[dict], wakes: list[str] | None = None, defer: list[str] | None = None, keyterms: list[str] | None = None):
        # Command ids that start with one of these go to the utterance while
        # Deepgram answers, so Home Assistant handles them.
        self.defer: tuple[str, ...] = tuple(defer or [])
        # Words Deepgram should expect: names of rooms, shows and features.
        self.keyterms: list[str] = list(dict.fromkeys(str(term) for term in keyterms or [] if str(term).strip()))[:MAX_KEYTERMS]
        self.by_phrase: dict[str, str] = {}
        self.bare: dict[str, str] = {}
        self.wakes: set[str] = {clean for clean in (normalize(wake) for wake in wakes or []) if clean}
        # Loose phrase -> command id, or None when two commands share it.
        self.loose: dict[str, str | None] = {}
        self.loose_bare: dict[str, str | None] = {}
        # The loose first words of every bare phrase, such as "turn on" and "turn on kitchen".
        self.starts: set[str] = set()
        for command in commands:
            command_id = str(command["id"])
            for phrase in command.get("phrases", []):
                clean = normalize(phrase)
                if clean:
                    self.by_phrase[clean] = command_id
                    self._add_loose(self.loose, clean, command_id)
            for phrase in command.get("bare", []):
                clean = normalize(phrase)
                if clean:
                    self.bare[clean] = command_id
                    self._add_loose(self.loose_bare, clean, command_id)
                    words = self.loosen(clean).split()
                    self.starts.update(" ".join(words[:count]) for count in range(1, len(words)))

    def _add_loose(self, table: dict[str, str | None], clean: str, command_id: str) -> None:
        key = self.loosen(clean)
        table[key] = command_id if table.get(key, command_id) == command_id else None

    def loosen(self, text: str) -> str:
        """Drops filler words and a doubled wake word ("mirror mirror")."""
        text = " ".join(word for word in text.split() if word not in FILLER)
        for wake in self.wakes:
            while (text + " ").startswith(f"{wake} {wake} "):
                text = text[len(wake) + 1 :]
        return text

    def grammar(self, window: bool = False) -> str:
        phrases = set(self.by_phrase) | self.wakes
        if window:
            phrases |= set(self.bare)
        return json.dumps(sorted(phrases) + [UNKNOWN])

    def lookup(self, text: str, window: bool = False) -> str | None:
        """Finds the command for a normalized phrase, or None.

        An exact phrase wins. Otherwise the phrase is compared without filler
        words, and a loose form that two commands share matches neither.
        """
        found = self.by_phrase.get(text)
        if found is None and window:
            found = self.bare.get(text)
        if found is None:
            key = self.loosen(text)
            found = self.loose.get(key)
            if found is None and window:
                found = self.loose_bare.get(key)
        return found

    def starts_with_wake(self, text: str) -> bool:
        return any(text == wake or text.startswith(wake + " ") for wake in self.wakes)

    def without_wake(self, text: str) -> str:
        """Removes the wake phrase from the front of a phrase, the longest that fits."""
        for wake in sorted(self.wakes, key=len, reverse=True):
            if text == wake or text.startswith(wake + " "):
                return text[len(wake) :].strip()
        return text

    def unfinished(self, text: str) -> bool:
        """True when a phrase is the first part of a command, such as "turn on"."""
        return bool(text) and self.loosen(text) in self.starts

    def deferred(self, command_id: str) -> bool:
        return bool(self.defer) and command_id.startswith(self.defer)

    def after_wake(self, transcript: str) -> tuple[str, bool]:
        """Splits a written-down sentence into what follows the wake phrase.

        Returns the rest, as written, and whether the sentence started with the
        wake phrase. "Hey" in front and a doubled wake phrase are allowed, and
        a near miss such as "Mira" counts, since Vosk heard the wake phrase there.
        """
        words = transcript.split()
        start = 1 if words and normalize(words[0]) == "hey" else 0
        found = False
        for _ in range(2):
            for wake in sorted(self.wakes, key=len, reverse=True):
                count = len(wake.split())
                said = normalize(" ".join(words[start : start + count]))
                if said and (said == wake or difflib.SequenceMatcher(None, said, wake).ratio() >= 0.6):
                    start += count
                    found = True
                    break
            else:
                break
        rest = " ".join(words[start:]) if found else transcript
        return rest.strip(" ,.!?;:"), found

    def understand(self, text: str) -> str | None:
        """Finds the command for a sentence without the wake word, exactly, loosely or nearly.

        Nearly means a ratio of at least 0.85 against one command's loose
        form, so "christmas light" finds "christmas lights" and a sentence
        that is no command finds nothing.
        """
        clean = normalize(text)
        if not clean:
            return None
        found = self.lookup(clean, window=True)
        if found is not None:
            return found
        key = self.loosen(clean)
        table = {**self.loose_bare, **{k: v for k, v in self.loose.items() if k not in self.loose_bare}}
        close = difflib.get_close_matches(key, [k for k, v in table.items() if v is not None], n=1, cutoff=0.85)
        return table[close[0]] if close else None

    def match(self, result: dict, min_confidence: float) -> dict | None:
        """Turns a Vosk final result for a full phrase into a command message, or None."""
        text = normalize(result.get("text", "").replace(UNKNOWN, " "))
        command_id = self.lookup(text)
        if command_id is None:
            return None
        confidence = confidence_of(result)
        if confidence < min_confidence:
            return None
        return {"type": "command", "id": command_id, "text": text, "confidence": round(confidence, 3)}


class Listener:
    """Decides what the recognizer's results mean, on the audio's own clock.

    It is fed partial and final results with the time in seconds of audio
    read so far, and returns the messages to print. It keeps no wall clock,
    so a WAV file gives the same answers every time.
    """

    def __init__(self, commands: Commands, min_confidence: float, window_seconds: float = 8.0, extend_seconds: float = 5.0):
        self.commands = commands
        self.min_confidence = min_confidence
        self.window_seconds = window_seconds
        self.extend_seconds = extend_seconds
        self.window_until: float | None = None
        self.window_reason: str | None = None
        self.started: float | None = None
        self.announced = False
        # The first part of a command heard before a pause, such as "turn on".
        self.so_far: str | None = None

    def window_open(self) -> bool:
        return self.window_until is not None

    def listening(self) -> bool:
        """True while someone is talking to the mirror or it waits for them."""
        return self.window_open() or self.announced

    def in_utterance(self) -> bool:
        return self.started is not None

    def forget_utterance(self) -> None:
        self.started = None
        self.announced = False

    def open_window(self, now: float, seconds: float, reason: str) -> list[dict]:
        self.window_until = now + seconds
        self.window_reason = reason
        return [{"type": "window", "open": True, "seconds": seconds, "reason": reason}]

    def close_window(self, why: str) -> list[dict]:
        if self.window_until is None:
            return []
        self.window_until = None
        self.window_reason = None
        self.so_far = None
        return [{"type": "window", "open": False, "reason": why}]

    def partial(self, text: str, now: float) -> list[dict]:
        if not text.strip():
            return []
        if self.started is None:
            self.started = now
        clean = normalize(text.replace(UNKNOWN, " "))
        if not self.announced and self.commands.starts_with_wake(clean):
            self.announced = True
            return [{"type": "listening", "on": True}]
        return []

    def final(self, result: dict, now: float) -> list[dict]:
        raw = result.get("text", "")
        started = self.started if self.started is not None else now
        announced = self.announced
        self.forget_utterance()
        in_window = self.window_until is not None and started <= self.window_until
        reason = self.window_reason if in_window else None
        text = normalize(raw.replace(UNKNOWN, " "))
        confidence = round(confidence_of(result), 3)
        so_far = self.so_far if in_window else None
        self.so_far = None
        messages: list[dict] = []
        if text in self.commands.wakes and UNKNOWN not in raw:
            if confidence >= self.min_confidence:
                # The wake word alone: wait for the command. Saying it again starts the wait over.
                return self.open_window(now, self.window_seconds, "wake")
            # A faint "mirror" is more often the television than a person.
            return [{"type": "listening", "on": False}] if announced else []
        command_id = self.commands.lookup(text, in_window) if text else None
        if so_far and text:
            # The rest of a command whose first part came before a pause.
            joined = f"{so_far} {self.commands.without_wake(text)}"
            if self.commands.lookup(joined, window=True) is not None:
                text, command_id = joined, self.commands.lookup(joined, window=True)
        if command_id is None and confidence >= self.min_confidence and UNKNOWN not in raw:
            # "Mirror, turn on" and a pause: keep it and wait for the rest.
            start = self.commands.without_wake(f"{so_far} {text}" if so_far else text)
            if (in_window or self.commands.starts_with_wake(text)) and self.commands.unfinished(start):
                opened = self.open_window(now, self.window_seconds, "wake")
                self.so_far = start
                return [{**opened[0], "so_far": start}]
        if command_id is not None and confidence >= self.min_confidence:
            messages.append({"type": "command", "id": command_id, "text": text, "confidence": confidence, "window": reason})
            messages += self.close_window("command")
        elif command_id is not None or (text and self.commands.starts_with_wake(text)) or (in_window and raw.strip()):
            why = "low" if command_id is not None else "unknown"
            messages.append({"type": "missed", "text": text, "confidence": confidence, "why": why, "window": reason})
            messages += self.close_window("missed")
        if announced and not messages:
            messages.append({"type": "listening", "on": False})
        return messages

    def tick(self, now: float) -> list[dict]:
        """Closes a window whose time is up, unless someone is still talking."""
        if self.window_until is not None and self.started is None and now > self.window_until:
            return self.close_window("timeout")
        if self.window_until is not None and self.started is not None and now > self.window_until + self.extend_seconds:
            return self.close_window("timeout")
        return []


def wav_bytes(pcm: bytes) -> bytes:
    """Wraps raw 16 kHz mono audio in a WAV header, in memory."""
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(pcm)
    return out.getvalue()


def deepgram(key: str, keyterms: list[str], opener=urllib.request.urlopen, timeout: float = 4.0):
    """Gives a function that writes down one utterance with Deepgram's Nova-3 model.

    The function takes raw audio and returns {"text", "confidence"}, or raises.
    """

    def transcribe(pcm: bytes) -> dict:
        params = [("model", "nova-3"), ("language", "en-US"), ("smart_format", "true")]
        params += [("keyterm", term) for term in keyterms[:MAX_KEYTERMS]]
        request = urllib.request.Request(
            f"{DEEPGRAM_URL}?{urllib.parse.urlencode(params)}",
            data=wav_bytes(pcm),
            headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
            method="POST",
        )
        with opener(request, timeout=timeout) as response:
            body = json.loads(response.read())
        best = body["results"]["channels"][0]["alternatives"][0]
        return {"text": str(best.get("transcript", "")), "confidence": round(float(best.get("confidence", 0.0)), 3)}

    return transcribe


class Capture:
    """Keeps the audio of one utterance, with a second from before it began."""

    def __init__(self, preroll_chunks: int = PREROLL_CHUNKS, max_seconds: float = MAX_CAPTURE_SECONDS):
        self.preroll: collections.deque = collections.deque(maxlen=preroll_chunks)
        self.max_seconds = max_seconds
        self.chunks: list[bytes] | None = None
        self.seconds = 0.0

    @property
    def active(self) -> bool:
        return self.chunks is not None

    def feed(self, data: bytes) -> None:
        if self.chunks is None:
            self.preroll.append(data)
        else:
            self.chunks.append(data)
            self.seconds += len(data) / 2 / SAMPLE_RATE

    def start(self) -> None:
        if self.chunks is None:
            self.chunks = list(self.preroll)
            self.seconds = sum(len(chunk) for chunk in self.chunks) / 2 / SAMPLE_RATE
            self.preroll.clear()

    def full(self) -> bool:
        return self.active and self.seconds >= self.max_seconds

    def take(self) -> bytes:
        audio = b"".join(self.chunks or [])
        self.drop()
        return audio

    def drop(self) -> None:
        self.chunks = None
        self.seconds = 0.0


def in_background(work) -> None:
    threading.Thread(target=work, daemon=True).start()


class Understanding:
    """Sends the audio after the wake word to Deepgram and decides what was meant.

    A capture starts when the listener hears the wake word, or speech in a
    window. When the listener gives its verdict (a command or a miss), or the
    first part of a command, the capture goes on until the speaker is quiet,
    because Vosk ends an utterance early at words it does not know. Then the
    audio goes to Deepgram. Deepgram's text wins. When Deepgram fails, the
    held verdict goes out as it is. Other verdicts that arrive meanwhile are
    part of the same sentence, or come while one is being written down, and
    are dropped.
    """

    def __init__(self, commands: Commands, transcribe, start=in_background):
        self.commands = commands
        self.transcribe = transcribe
        self.start = start
        self.capture = Capture()
        self.results: queue.Queue = queue.Queue()
        self.busy = False
        self.listener: Listener | None = None
        # While the capture runs on to the end of the sentence:
        # {"held", "need", "quiet", "tail", "peak"}.
        self.closing: dict | None = None
        self.peak = 0.0
        # The window the capture began in, if any ("wake" or "follow_up").
        self.window: str | None = None

    def audio(self, data: bytes, listener: Listener) -> list[dict]:
        """Takes one chunk after the listener has seen it. Starts a capture when the mirror is spoken to."""
        self.listener = listener
        self.capture.feed(data)
        if not self.capture.active and not self.busy and listener.in_utterance() and (listener.announced or listener.window_open()):
            self.capture.start()
            self.peak = 0.0
            self.window = listener.window_reason if listener.window_open() else None
        if not self.capture.active or self.busy:
            return []
        level = level_of(data)
        self.peak = max(self.peak, level)
        if self.closing is not None:
            seconds = len(data) / 2 / SAMPLE_RATE
            quiet = level < max(0.12, 0.35 * self.peak)
            self.closing["quiet"] = self.closing["quiet"] + seconds if quiet else 0.0
            self.closing["tail"] += seconds
            if self.closing["quiet"] >= self.closing["need"] or self.closing["tail"] >= MAX_TAIL_SECONDS:
                return self.send(self.closing["held"])
        if self.capture.full():
            return self.send(self.closing["held"] if self.closing else None)
        return []

    def close_after(self, held: dict | None, need: float) -> None:
        if self.closing is None:
            self.closing = {"held": held, "need": need, "quiet": 0.0, "tail": 0.0}

    def messages(self, messages: list[dict]) -> list[dict]:
        """Passes the listener's messages on, holding its verdict on a captured utterance."""
        out = []
        for message in messages:
            verdict = message["type"] in ("command", "missed")
            if verdict and (self.busy or self.closing is not None):
                continue
            if verdict and self.capture.active:
                self.close_after(message, QUIET_SECONDS)
            elif message["type"] == "window" and message.get("open") and message.get("so_far") and self.capture.active and not self.busy:
                # The first part of a command. Deepgram hears how it ends.
                self.close_after(None, QUIET_AFTER_PART_SECONDS)
                out.append(message)
            elif self.capture.active and not self.busy and self.closing is None and (
                (message["type"] == "window" and not message["open"] and message.get("reason") == "timeout")
                or (message["type"] == "listening" and not message["on"])
            ):
                # Nothing came after the wake word, or the wake word was too faint to count.
                self.capture.drop()
                out.append(message)
            else:
                out.append(message)
        return out

    def mute(self) -> None:
        self.capture.drop()
        self.closing = None

    def finish(self) -> list[dict]:
        """Sends a capture that is waiting for the speaker to stop, at the end of a recording."""
        if self.capture.active and self.closing is not None and not self.busy:
            return self.send(self.closing["held"])
        return []

    def send(self, held: dict | None) -> list[dict]:
        pcm = self.capture.take()
        self.closing = None
        self.busy = True
        window = held.get("window") if held else self.window

        def work() -> None:
            try:
                self.results.put(("ok", self.transcribe(pcm), held, window))
            except Exception as error:  # noqa: BLE001 - any failure falls back to Vosk
                self.results.put(("failed", str(error) or type(error).__name__, held, window))

        # The listener's window ends here, since Deepgram decides what was said.
        out = self.listener.close_window("sent") if self.listener is not None else []
        self.start(work)
        return out + [{"type": "thinking"}]

    def poll(self) -> list[dict]:
        out = []
        while not self.results.empty():
            kind, answer, held, window = self.results.get()
            self.busy = False
            out += self.decide(kind, answer, held, window)
        return out

    def decide(self, kind: str, answer, held: dict | None, window: str | None = None) -> list[dict]:
        if kind != "ok":
            if held is None:
                return [{"type": "stt_failed", "message": answer}, {"type": "missed", "text": "", "confidence": 0.0, "why": "unknown", "window": window}]
            return [{"type": "stt_failed", "message": answer}, held]
        text = answer["text"].strip()
        confidence = answer["confidence"]
        out = [{"type": "transcript", "text": text, "confidence": confidence, "window": window}]
        rest, addressed = self.commands.after_wake(text)
        if not text or not (addressed or window):
            # Vosk thought it heard the wake word, and Deepgram did not.
            why = "empty" if not text else "no_wake"
            return out + [{"type": "missed", "text": normalize(text), "confidence": confidence, "why": why, "window": window}]
        if not rest:
            return out + [{"type": "missed", "text": "", "confidence": confidence, "why": "empty", "window": window}]
        found = self.commands.understand(rest)
        if found is not None and not self.commands.deferred(found):
            return out + [{"type": "command", "id": found, "text": normalize(rest), "confidence": confidence, "window": window, "source": "deepgram"}]
        return out + [{"type": "utterance", "text": rest, "confidence": confidence, "window": window}]


def level_of(data: bytes) -> float:
    """Gives a chunk's loudness from 0 to 1, for the light on the screen."""
    samples = array.array("h")
    samples.frombytes(data[: len(data) - len(data) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return 0.0
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    # A voice across the room is a few hundred, a voice up close a few thousand.
    return round(min(1.0, math.sqrt(rms / 6000)), 2)


def make_recognizer(model, commands: Commands, window: bool = False):
    from vosk import KaldiRecognizer

    recognizer = KaldiRecognizer(model, SAMPLE_RATE, commands.grammar(window))
    recognizer.SetWords(True)
    return recognizer


class Recognizers:
    """Holds one recognizer for normal listening and one for a window.

    The window's grammar adds the phrases without the wake word. Switching
    happens only between utterances, so no speech is cut in half.
    """

    def __init__(self, model, commands: Commands):
        self.normal = make_recognizer(model, commands)
        self.window = make_recognizer(model, commands, window=True)
        self.current = self.normal

    def follow(self, listener: Listener) -> None:
        wanted = self.window if listener.window_open() else self.normal
        if wanted is not self.current and not listener.in_utterance():
            wanted.Reset()
            self.current = wanted

    def reset(self) -> None:
        self.current.Reset()


def feed(recognizers: Recognizers, listener: Listener, data: bytes, now: float) -> list[dict]:
    """Runs one chunk of audio through the recognizer in force."""
    recognizers.follow(listener)
    recognizer = recognizers.current
    if recognizer.AcceptWaveform(data):
        messages = listener.final(json.loads(recognizer.Result()), now)
    else:
        messages = listener.partial(json.loads(recognizer.PartialResult()).get("partial", ""), now)
    messages += listener.tick(now)
    recognizers.follow(listener)
    return messages


def missing_words(model, commands: Commands) -> list[str]:
    """Returns the words in the phrases that the speech model does not know.

    Vosk drops such words from the grammar and only says so in its log, so
    this builds a recognizer once with logging on and reads what it printed.
    """
    from vosk import KaldiRecognizer, SetLogLevel

    with tempfile.TemporaryFile() as capture:
        saved = os.dup(2)
        os.dup2(capture.fileno(), 2)
        SetLogLevel(0)
        try:
            KaldiRecognizer(model, SAMPLE_RATE, commands.grammar())
        finally:
            SetLogLevel(-2)
            os.dup2(saved, 2)
            os.close(saved)
        capture.seek(0)
        log = capture.read().decode(errors="replace")
    return sorted(set(re.findall(r"missing in vocabulary:? '?([a-z' -]+?)'?\s*$", log, flags=re.MULTILINE)))


def report_missing(model, commands: Commands) -> None:
    missing = missing_words(model, commands)
    if missing:
        emit({"type": "error", "message": "The speech model does not know these words, so phrases with them never match: " + ", ".join(missing)})


def stdin_reader(messages: queue.Queue) -> None:
    mode = os.fstat(sys.stdin.fileno()).st_mode
    from_helper = stat.S_ISSOCK(mode) or stat.S_ISFIFO(mode)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            emit({"type": "error", "message": "Ignored a command that was not JSON"})
    # stdin closed. When it came from the helper, the helper is gone, so stop
    # and free the microphone.
    if from_helper:
        os._exit(0)


def recognize_wav(path: str, model, commands: Commands, listener: Listener, understanding: Understanding | None = None) -> int:
    """Runs one WAV file through the recognizer and the listener. Used for testing."""
    with wave.open(path, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != SAMPLE_RATE:
            emit({"type": "error", "message": "The WAV file must be 16 kHz, 16-bit, mono"})
            return 1
        recognizers = Recognizers(model, commands)
        now = 0.0

        def out(messages: list[dict]) -> None:
            if understanding is not None:
                messages = understanding.messages(messages) + understanding.poll()
            for message in messages:
                emit({**message, "at": round(now, 2)})

        while True:
            data = audio.readframes(CHUNK_BYTES // 2)
            if not data:
                break
            now += len(data) / 2 / SAMPLE_RATE
            messages = feed(recognizers, listener, data, now)
            if understanding is not None:
                messages = understanding.audio(data, listener) + messages
            out(messages)
        last = listener.final(json.loads(recognizers.current.FinalResult()), now)
        if understanding is not None:
            # The recording ended where a person would have gone quiet.
            last = understanding.messages(last) + understanding.finish()
        out(last + listener.tick(now + listener.extend_seconds + listener.window_seconds))
    return 0


def commands_of(message: dict) -> Commands:
    """Builds the commands from the helper's message, or from a file holding one."""
    return Commands(message.get("commands", []), message.get("wakes"), message.get("defer"), message.get("keyterms"))


def understanding_of(transcribe: str, commands: Commands, start=in_background) -> Understanding | None:
    """Sets up Deepgram when it was asked for and its key is in the environment."""
    if transcribe != "deepgram":
        return None
    key = os.environ.get("SECRET_DEEPGRAM_KEY", "").strip()
    if not key:
        emit({"type": "error", "message": "SECRET_DEEPGRAM_KEY is not set, so only the phrase list is used"})
        return None
    return Understanding(commands, deepgram(key, commands.keyterms), start)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--device", default="plughw:CARD=Webcam", help="ALSA capture device")
    parser.add_argument("--min-confidence", type=float, default=0.65, help="ignore commands recognized with less confidence than this")
    parser.add_argument("--window-seconds", type=float, default=8.0, help="how long to wait for a command after the wake word alone")
    parser.add_argument("--commands", help="JSON file with the command list, for use without the helper")
    parser.add_argument("--wav", help="recognize this 16 kHz mono WAV file, print the result and exit")
    parser.add_argument("--transcribe", choices=["none", "deepgram"], default="none", help="also write down what is said after the wake word (deepgram needs SECRET_DEEPGRAM_KEY)")
    parser.add_argument("--check-words", metavar="PHRASE", help="print the words of this phrase that the speech model does not know, and exit")
    args = parser.parse_args()

    try:
        from vosk import Model, SetLogLevel

        SetLogLevel(-2)
        if not MODEL_DIR.is_dir():
            raise FileNotFoundError(f"Missing speech model {MODEL_DIR}. Run mirror/deploy/setup-pi.sh.")
        model = Model(str(MODEL_DIR))
    except Exception as error:  # noqa: BLE001 - reported to the helper, then exit
        emit({"type": "error", "message": str(error)})
        return 1

    if args.check_words is not None:
        emit({"type": "checked", "missing": missing_words(model, Commands([{"id": "check", "phrases": [args.check_words]}]))})
        return 0

    commands = None
    if args.commands:
        listed = json.loads(Path(args.commands).read_text())
        # Either the helper's message, or a bare list of commands.
        if isinstance(listed, dict):
            commands = commands_of(listed)
        else:
            commands = Commands(listed)
    if args.wav:
        if commands is None:
            emit({"type": "error", "message": "--wav needs --commands"})
            return 1
        report_missing(model, commands)
        understanding = understanding_of(args.transcribe, commands, start=lambda work: work())
        return recognize_wav(args.wav, model, commands, Listener(commands, args.min_confidence, args.window_seconds), understanding)

    messages: queue.Queue = queue.Queue()
    threading.Thread(target=stdin_reader, args=(messages,), daemon=True).start()

    # Wait for the command list before opening the microphone.
    while commands is None:
        message = messages.get()
        if message.get("cmd") == "commands":
            commands = commands_of(message)

    recorder = subprocess.Popen(
        ["arecord", "-q", "-D", args.device, "-f", "S16_LE", "-r", str(SAMPLE_RATE), "-c", "1", "-t", "raw"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    report_missing(model, commands)
    listener = Listener(commands, args.min_confidence, args.window_seconds)
    recognizers = Recognizers(model, commands)
    understanding = understanding_of(args.transcribe, commands)
    muted = False
    now = 0.0
    hold_until = 0.0
    emit({"type": "ready", "phrases": len(commands.by_phrase)})

    while True:
        while not messages.empty():
            message = messages.get()
            if message.get("cmd") == "mute":
                muted = bool(message.get("on"))
                recognizers.reset()
                listener.forget_utterance()
                if understanding is not None:
                    understanding.mute()
            elif message.get("cmd") == "hold":
                hold_until = max(hold_until, now + min(2.0, float(message.get("seconds", 0.4))))
            elif message.get("cmd") == "follow_up":
                for out in listener.open_window(now, min(30.0, float(message.get("seconds", 5))), "follow_up"):
                    emit(out)
            elif message.get("cmd") == "commands":
                commands = commands_of(message)
                report_missing(model, commands)
                listener.commands = commands
                if understanding is not None:
                    understanding = understanding_of(args.transcribe, commands)
                listener.forget_utterance()
                recognizers = Recognizers(model, commands)
                emit({"type": "ready", "phrases": len(commands.by_phrase)})

        data = recorder.stdout.read(CHUNK_BYTES)
        if not data:
            reason = recorder.stderr.read().decode(errors="replace").strip() or "no audio"
            emit({"type": "error", "message": f"The microphone stopped: {reason}"})
            return 1
        now += len(data) / 2 / SAMPLE_RATE
        if understanding is not None:
            for out in understanding.poll():
                emit(out)
        if muted or now < hold_until:
            for out in listener.tick(now):
                emit(out)
            continue
        if listener.listening() or (understanding is not None and understanding.capture.active):
            emit({"type": "level", "value": level_of(data)})
        heard = feed(recognizers, listener, data, now)
        if understanding is not None:
            heard = understanding.audio(data, listener) + understanding.messages(heard)
        for out in heard:
            emit(out)

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
