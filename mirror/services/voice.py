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
    {"type": "error", "message": "..."}

It reads commands from stdin, also one JSON object per line:

    {"cmd": "commands", "wakes": ["mirror"], "commands": [{"id": "good_night", "phrases": ["mirror good night"], "bare": ["good night"]}]}
    {"cmd": "mute", "on": true}
    {"cmd": "hold", "seconds": 0.4}            drop the audio while a tone plays
    {"cmd": "follow_up", "seconds": 5}         listen without the wake word for a while

A command can be said in one breath ("mirror, good night"), or the wake
word can come alone. Then a window opens for a few seconds in which the
command needs no wake word. Outside a window the phrases without the wake
word are not in the recognizer's grammar at all, so background talk cannot
set them off.

Recognition uses Vosk with a fixed phrase list, so the recognizer can only
ever answer with one of the listed phrases or "[unk]". Audio is read from
the microphone through arecord, stays in memory and is never stored or sent
anywhere. While muted (the mirror itself is speaking) audio is discarded.
"""

from __future__ import annotations

import argparse
import array
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
import wave
from pathlib import Path

DATA_DIR = Path(os.environ.get("MIRROR_DATA_DIR", Path.home() / "mirror-data"))
MODEL_DIR = DATA_DIR / "models" / "vosk-model-small-en-us-0.15"
SAMPLE_RATE = 16000
CHUNK_BYTES = 2000 * 2  # an eighth of a second of 16-bit mono audio
UNKNOWN = "[unk]"


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

    def __init__(self, commands: list[dict], wakes: list[str] | None = None):
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


def recognize_wav(path: str, model, commands: Commands, listener: Listener) -> int:
    """Runs one WAV file through the recognizer and the listener. Used for testing."""
    with wave.open(path, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != SAMPLE_RATE:
            emit({"type": "error", "message": "The WAV file must be 16 kHz, 16-bit, mono"})
            return 1
        recognizers = Recognizers(model, commands)
        now = 0.0
        while True:
            data = audio.readframes(CHUNK_BYTES // 2)
            if not data:
                break
            now += len(data) / 2 / SAMPLE_RATE
            for message in feed(recognizers, listener, data, now):
                emit({**message, "at": round(now, 2)})
        for message in listener.final(json.loads(recognizers.current.FinalResult()), now) + listener.tick(now + listener.extend_seconds + listener.window_seconds):
            emit({**message, "at": round(now, 2)})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--device", default="plughw:CARD=Webcam", help="ALSA capture device")
    parser.add_argument("--min-confidence", type=float, default=0.65, help="ignore commands recognized with less confidence than this")
    parser.add_argument("--window-seconds", type=float, default=8.0, help="how long to wait for a command after the wake word alone")
    parser.add_argument("--commands", help="JSON file with the command list, for use without the helper")
    parser.add_argument("--wav", help="recognize this 16 kHz mono WAV file, print the result and exit")
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
            commands = Commands(listed.get("commands", []), listed.get("wakes"))
        else:
            commands = Commands(listed)
    if args.wav:
        if commands is None:
            emit({"type": "error", "message": "--wav needs --commands"})
            return 1
        report_missing(model, commands)
        return recognize_wav(args.wav, model, commands, Listener(commands, args.min_confidence, args.window_seconds))

    messages: queue.Queue = queue.Queue()
    threading.Thread(target=stdin_reader, args=(messages,), daemon=True).start()

    # Wait for the command list before opening the microphone.
    while commands is None:
        message = messages.get()
        if message.get("cmd") == "commands":
            commands = Commands(message.get("commands", []), message.get("wakes"))

    recorder = subprocess.Popen(
        ["arecord", "-q", "-D", args.device, "-f", "S16_LE", "-r", str(SAMPLE_RATE), "-c", "1", "-t", "raw"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    report_missing(model, commands)
    listener = Listener(commands, args.min_confidence, args.window_seconds)
    recognizers = Recognizers(model, commands)
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
            elif message.get("cmd") == "hold":
                hold_until = max(hold_until, now + min(2.0, float(message.get("seconds", 0.4))))
            elif message.get("cmd") == "follow_up":
                for out in listener.open_window(now, min(30.0, float(message.get("seconds", 5))), "follow_up"):
                    emit(out)
            elif message.get("cmd") == "commands":
                commands = Commands(message.get("commands", []), message.get("wakes"))
                report_missing(model, commands)
                listener.commands = commands
                listener.forget_utterance()
                recognizers = Recognizers(model, commands)
                emit({"type": "ready", "phrases": len(commands.by_phrase)})

        data = recorder.stdout.read(CHUNK_BYTES)
        if not data:
            reason = recorder.stderr.read().decode(errors="replace").strip() or "no audio"
            emit({"type": "error", "message": f"The microphone stopped: {reason}"})
            return 1
        now += len(data) / 2 / SAMPLE_RATE
        if muted or now < hold_until:
            for out in listener.tick(now):
                emit(out)
            continue
        if listener.listening():
            emit({"type": "level", "value": level_of(data)})
        for out in feed(recognizers, listener, data, now):
            emit(out)

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
