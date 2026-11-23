#!/usr/bin/env python3
"""Listens for spoken commands that start with the wake word, offline.

MMM-Voice's node_helper starts this script, sends it the command list, and
reads one JSON object per line from its stdout:

    {"type": "ready", "phrases": 14}
    {"type": "command", "id": "good_night", "text": "mirror good night", "confidence": 0.97}
    {"type": "error", "message": "..."}

It reads commands from stdin, also one JSON object per line:

    {"cmd": "commands", "commands": [{"id": "good_night", "phrases": ["mirror good night"]}]}
    {"cmd": "mute", "on": true}

Recognition uses Vosk with a fixed phrase list, so the recognizer can only
ever answer with one of the listed phrases or "[unk]". Audio is read from
the microphone through arecord, stays in memory and is never stored or sent
anywhere. While muted (the mirror itself is speaking) audio is discarded.
"""

from __future__ import annotations

import argparse
import json
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
CHUNK_BYTES = 4000 * 2  # a quarter of a second of 16-bit mono audio
UNKNOWN = "[unk]"


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def normalize(phrase: str) -> str:
    """Lowercases a phrase and strips punctuation, the form Vosk answers in."""
    kept = "".join(char if char.isalnum() or char in " '" else " " for char in phrase.lower())
    return " ".join(kept.split())


class Commands:
    """Maps each phrase to its command id and builds the Vosk grammar."""

    def __init__(self, commands: list[dict]):
        self.by_phrase: dict[str, str] = {}
        for command in commands:
            for phrase in command.get("phrases", []):
                clean = normalize(phrase)
                if clean:
                    self.by_phrase[clean] = str(command["id"])

    def grammar(self) -> str:
        return json.dumps(sorted(self.by_phrase) + [UNKNOWN])

    def match(self, result: dict, min_confidence: float) -> dict | None:
        """Turns a Vosk final result into a command message, or None."""
        text = normalize(result.get("text", "").replace(UNKNOWN, " "))
        command_id = self.by_phrase.get(text)
        if command_id is None:
            return None
        words = result.get("result", [])
        confidence = sum(word.get("conf", 0.0) for word in words) / len(words) if words else 0.0
        if confidence < min_confidence:
            return None
        return {"type": "command", "id": command_id, "text": text, "confidence": round(confidence, 3)}


def make_recognizer(model, commands: Commands):
    from vosk import KaldiRecognizer

    recognizer = KaldiRecognizer(model, SAMPLE_RATE, commands.grammar())
    recognizer.SetWords(True)
    return recognizer


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


def recognize_wav(path: str, model, commands: Commands, min_confidence: float) -> int:
    """Runs one WAV file through the recognizer. Used for testing."""
    with wave.open(path, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != SAMPLE_RATE:
            emit({"type": "error", "message": "The WAV file must be 16 kHz, 16-bit, mono"})
            return 1
        recognizer = make_recognizer(model, commands)
        found = []
        while True:
            data = audio.readframes(4000)
            if not data:
                break
            if recognizer.AcceptWaveform(data):
                found.append(json.loads(recognizer.Result()))
        found.append(json.loads(recognizer.FinalResult()))
    for result in found:
        if not result.get("text"):
            continue
        message = commands.match(result, min_confidence)
        emit(message or {"type": "ignored", "text": result["text"]})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--device", default="plughw:CARD=Webcam", help="ALSA capture device")
    parser.add_argument("--min-confidence", type=float, default=0.8, help="ignore commands recognized with less confidence than this")
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
        commands = Commands(json.loads(Path(args.commands).read_text()))
    if args.wav:
        if commands is None:
            emit({"type": "error", "message": "--wav needs --commands"})
            return 1
        report_missing(model, commands)
        return recognize_wav(args.wav, model, commands, args.min_confidence)

    messages: queue.Queue = queue.Queue()
    threading.Thread(target=stdin_reader, args=(messages,), daemon=True).start()

    # Wait for the command list before opening the microphone.
    while commands is None:
        message = messages.get()
        if message.get("cmd") == "commands":
            commands = Commands(message.get("commands", []))

    recorder = subprocess.Popen(
        ["arecord", "-q", "-D", args.device, "-f", "S16_LE", "-r", str(SAMPLE_RATE), "-c", "1", "-t", "raw"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    report_missing(model, commands)
    recognizer = make_recognizer(model, commands)
    muted = False
    emit({"type": "ready", "phrases": len(commands.by_phrase)})

    while True:
        while not messages.empty():
            message = messages.get()
            if message.get("cmd") == "mute":
                muted = bool(message.get("on"))
                recognizer.Reset()
            elif message.get("cmd") == "commands":
                commands = Commands(message.get("commands", []))
                report_missing(model, commands)
                recognizer = make_recognizer(model, commands)
                emit({"type": "ready", "phrases": len(commands.by_phrase)})

        data = recorder.stdout.read(CHUNK_BYTES)
        if not data:
            reason = recorder.stderr.read().decode(errors="replace").strip() or "no audio"
            emit({"type": "error", "message": f"The microphone stopped: {reason}"})
            return 1
        if muted:
            continue
        if recognizer.AcceptWaveform(data):
            command = commands.match(json.loads(recognizer.Result()), args.min_confidence)
            if command:
                emit(command)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
