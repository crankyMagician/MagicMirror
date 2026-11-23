#!/usr/bin/env python3
"""Enrolls a person from photo files, or lists and removes enrolled people.

    enroll.py --name heather --from-photos ~/heather-photos
    enroll.py --list
    enroll.py --remove heather

Use photos where the face is clear and close to the camera. Each photo
should show only that person. Photos with no face or with more than one
face are skipped and listed.

To enroll at the mirror with the webcam, use the running mirror instead:

    curl -X POST 'http://localhost:8080/household/api/enroll?name=sam'

The photos are read and never copied. Only the face embeddings are stored,
in ~/mirror-data/faces/<name>.npy.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

import facelib

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MAX_SIDE = 1600


def load_image(path: Path):
    image = cv2.imread(str(path))
    if image is None:
        return None
    height, width = image.shape[:2]
    scale = MAX_SIDE / max(height, width)
    if scale < 1:
        image = cv2.resize(image, (int(width * scale), int(height * scale)))
    return image


def enroll_from_photos(name: str, folder: Path) -> int:
    if not facelib.valid_name(name):
        print(f"Invalid name {name!r}. Use lowercase letters, digits, - and _.", file=sys.stderr)
        return 2
    photos = sorted(path for path in folder.iterdir() if path.suffix.lower() in IMAGE_SUFFIXES)
    if not photos:
        print(f"No image files in {folder}", file=sys.stderr)
        return 2

    engine = facelib.FaceEngine()
    samples, skipped = [], []
    for photo in photos:
        image = load_image(photo)
        if image is None:
            skipped.append((photo.name, "could not be read"))
            continue
        faces = engine.detect(image, min_width=40)
        if len(faces) != 1:
            skipped.append((photo.name, f"{len(faces)} faces found"))
            continue
        samples.append(engine.embed(image, faces[0]))

    for filename, reason in skipped:
        print(f"skipped {filename}: {reason}")
    if len(samples) < 3:
        print(f"Only {len(samples)} usable photos. At least 3 are needed.", file=sys.stderr)
        return 1

    path = facelib.save_person(name, samples)
    print(f"Enrolled {name} from {len(samples)} photos: {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--name", help="lowercase name for the person, for example heather")
    parser.add_argument("--from-photos", type=Path, help="folder of photos of that person")
    parser.add_argument("--list", action="store_true", help="list enrolled people")
    parser.add_argument("--remove", help="remove an enrolled person")
    args = parser.parse_args()

    if args.list:
        for name, samples in facelib.load_known().items():
            print(f"{name}: {len(samples)} samples")
        return 0
    if args.remove:
        path = facelib.FACE_DIR / f"{args.remove}.npy"
        if not facelib.valid_name(args.remove) or not path.is_file():
            print(f"Nobody is enrolled as {args.remove!r}", file=sys.stderr)
            return 1
        path.unlink()
        print(f"Removed {args.remove}")
        return 0
    if args.name and args.from_photos:
        return enroll_from_photos(args.name.lower(), args.from_photos.expanduser())

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
