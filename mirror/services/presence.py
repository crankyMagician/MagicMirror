#!/usr/bin/env python3
"""Watches the webcam and reports who is standing at the mirror.

MMM-Household's node_helper starts this script and reads one JSON object per
line from its stdout:

    {"type": "ready", "people": ["heather", "sam"]}
    {"type": "presence", "person": "sam"}
    {"type": "presence", "person": null, "unknown": true}
    {"type": "enroll", "name": "sam", "captured": 5, "wanted": 20}
    {"type": "enrolled", "name": "sam", "samples": 20}
    {"type": "error", "message": "..."}

"person" is an enrolled name, "guest" when nobody is enrolled yet and any
face is present, or null. "unknown" is true when a face is present that
matches nobody.

It reads commands from stdin, also one JSON object per line:

    {"cmd": "enroll", "name": "sam", "samples": 20}

Frames stay in memory. Nothing from the camera is written to disk except
the face embeddings that an enrollment produces.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import stat
import sys
import threading
import time

import cv2

import facelib

GUEST = "guest"
UNKNOWN = "unknown"

# The detector runs on a half-size copy of each frame. Recognition still uses
# the full frame.
DETECT_SCALE = 0.5

# The Pi has four cores and the mirror needs most of them for other things.
cv2.setNumThreads(2)


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


class Smoother:
    """Turns noisy per-frame sightings into a steady answer.

    A new sighting has to repeat on `confirm` frames in a row before it
    replaces the current one. Once someone is current they stay current for
    `hold` seconds after the camera last saw them, so a turned head or one
    missed frame does not blank the mirror.
    """

    def __init__(self, confirm: int = 2, hold: float = 8.0):
        self.confirm = confirm
        self.hold = hold
        self.current: str | None = None
        self.last_seen = 0.0
        self.candidate: str | None = None
        self.candidate_count = 0

    def update(self, sighting: str | None, now: float) -> str | None:
        if sighting is not None and sighting == self.current:
            self.last_seen = now
            self.candidate, self.candidate_count = None, 0
            return self.current

        if sighting == self.candidate:
            self.candidate_count += 1
        else:
            self.candidate, self.candidate_count = sighting, 1

        holding = self.current is not None and now - self.last_seen < self.hold
        # A recognized person replaces anyone at once. Nobody, or a stranger,
        # only replaces the current person after the hold runs out.
        replaces_now = sighting not in (None, UNKNOWN) or not holding
        if self.candidate_count >= self.confirm and replaces_now:
            self.current = sighting
            self.last_seen = now
            self.candidate, self.candidate_count = None, 0
        return self.current


class Enrollment:
    def __init__(self, name: str, wanted: int):
        self.name = name
        self.wanted = wanted
        self.samples: list = []
        self.deadline = time.monotonic() + 60


class Camera:
    """The webcam, or a video file that stands in for it.

    Pass a video file as --camera to test the mirror without a person in
    front of it. The file plays in a loop.
    """

    def __init__(self, device: str, width: int, height: int):
        self.is_file = not (device.isdigit() or device.startswith("/dev/"))
        if self.is_file:
            self.capture = cv2.VideoCapture(device)
        else:
            self.capture = cv2.VideoCapture(int(device) if device.isdigit() else device, cv2.CAP_V4L2)
            self.capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            self.capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not self.capture.isOpened():
            raise RuntimeError(f"Cannot open camera {device}")
        if not self.is_file:
            # The first frames are close to black until auto-exposure settles.
            for _ in range(45):
                self.capture.read()

    def read(self):
        """Returns the newest frame, or None when the camera gave nothing."""
        if self.is_file:
            ok, frame = self.capture.read()
            if not ok:
                self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self.capture.read()
            return frame if ok else None
        # Drop the buffered frame so the one we analyse is current.
        self.capture.grab()
        ok, frame = self.capture.read()
        return frame if ok else None


def sight(engine: facelib.FaceEngine, frame, known: dict, min_face: int, scale: float = DETECT_SCALE) -> tuple[str | None, list]:
    """Returns (sighting, faces) for one frame."""
    faces = engine.detect(frame, min_width=min_face, scale=scale)
    if not faces:
        return None, faces
    if not known:
        return GUEST, faces
    for face in faces[:3]:
        name, _ = facelib.match(engine.embed(frame, face), known)
        if name is not None:
            return name, faces
    return UNKNOWN, faces


def stdin_reader(commands: queue.Queue) -> None:
    # Node connects a child's stdin through a socket. A shell pipe is a FIFO.
    mode = os.fstat(sys.stdin.fileno()).st_mode
    from_helper = stat.S_ISSOCK(mode) or stat.S_ISFIFO(mode)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except json.JSONDecodeError:
            emit({"type": "error", "message": "Ignored a command that was not JSON"})
    # stdin closed. When it came from the helper, the helper is gone, for
    # example after MagicMirror crashed. Exit so the camera is free for the
    # next start.
    if from_helper:
        os._exit(0)


def report(person: str | None) -> dict:
    if person == UNKNOWN:
        return {"type": "presence", "person": None, "unknown": True}
    return {"type": "presence", "person": person, "unknown": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--camera", default="/dev/video0", help="V4L2 device path or index, or a video file for testing")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=360)
    parser.add_argument("--interval", type=float, default=0.4, help="seconds between analysed frames while a face is in view")
    parser.add_argument("--idle-interval", type=float, default=1.0, help="seconds between analysed frames while nobody is in view")
    parser.add_argument("--hold", type=float, default=8.0, help="seconds a person stays current after the last sighting")
    parser.add_argument("--min-face", type=int, default=50, help="ignore faces narrower than this many pixels")
    parser.add_argument("--image", help="analyse this image file instead of the camera, print the sighting and exit")
    args = parser.parse_args()

    try:
        engine = facelib.FaceEngine()
    except Exception as error:  # noqa: BLE001 - reported to the helper, then exit
        emit({"type": "error", "message": str(error)})
        return 1

    known = facelib.load_known()
    stamp = facelib.known_stamp()

    if args.image:
        frame = cv2.imread(args.image)
        if frame is None:
            emit({"type": "error", "message": f"Cannot read image {args.image}"})
            return 1
        # A photo can be any size, so detect at full resolution here.
        sighting, faces = sight(engine, frame, known, args.min_face, scale=1.0)
        emit({"type": "sighting", "sighting": sighting, "faces": len(faces), "people": sorted(known)})
        return 0

    try:
        camera = Camera(args.camera, args.width, args.height)
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "message": str(error)})
        return 1

    commands: queue.Queue = queue.Queue()
    threading.Thread(target=stdin_reader, args=(commands,), daemon=True).start()

    smoother = Smoother(hold=args.hold)
    enrollment: Enrollment | None = None
    reported: str | None = None
    failures = 0
    emit({"type": "ready", "people": sorted(known)})
    emit(report(None))

    while True:
        started = time.monotonic()

        while not commands.empty():
            command = commands.get()
            if command.get("cmd") == "enroll":
                name = str(command.get("name", "")).lower()
                if not facelib.valid_name(name):
                    emit({"type": "error", "message": f"Cannot enroll the name {name!r}"})
                else:
                    wanted = max(5, min(int(command.get("samples", 20)), 60))
                    enrollment = Enrollment(name, wanted)
                    emit({"type": "enroll", "name": name, "captured": 0, "wanted": wanted})

        frame = camera.read()
        if frame is None:
            failures += 1
            if failures >= 25:
                emit({"type": "error", "message": "The camera stopped delivering frames"})
                return 1
            time.sleep(args.interval)
            continue
        failures = 0

        if facelib.known_stamp() != stamp:
            known = facelib.load_known()
            stamp = facelib.known_stamp()
            emit({"type": "ready", "people": sorted(known)})

        sighting, faces = sight(engine, frame, known, args.min_face)

        if enrollment is not None:
            # Take a sample only when exactly one face is in view, so a second
            # person in the frame cannot end up in the profile.
            if len(faces) == 1:
                enrollment.samples.append(engine.embed(frame, faces[0]))
                emit({"type": "enroll", "name": enrollment.name, "captured": len(enrollment.samples), "wanted": enrollment.wanted})
            if len(enrollment.samples) >= enrollment.wanted:
                facelib.save_person(enrollment.name, enrollment.samples)
                emit({"type": "enrolled", "name": enrollment.name, "samples": len(enrollment.samples)})
                enrollment = None
            elif time.monotonic() > enrollment.deadline:
                emit({"type": "error", "message": f"Enrollment of {enrollment.name} timed out with {len(enrollment.samples)} of {enrollment.wanted} samples"})
                enrollment = None

        person = smoother.update(sighting, time.monotonic())
        if person != reported:
            reported = person
            emit(report(person))

        busy = bool(faces) or person is not None or enrollment is not None
        interval = args.interval if busy else args.idle_interval
        elapsed = time.monotonic() - started
        time.sleep(max(0.0, interval - elapsed))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
