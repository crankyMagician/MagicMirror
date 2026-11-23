"""Face detection and recognition shared by presence.py and enroll.py.

Detection uses OpenCV's YuNet model and recognition uses SFace. Both run on
the CPU through the opencv-python-headless wheel. setup-pi.sh downloads the
two model files to ~/mirror-data/models.

Each enrolled person is one file, ~/mirror-data/faces/<name>.npy, holding an
array of unit-length face embeddings with one row per sample.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import cv2
import numpy as np

DATA_DIR = Path(os.environ.get("MIRROR_DATA_DIR", Path.home() / "mirror-data"))
MODEL_DIR = DATA_DIR / "models"
FACE_DIR = DATA_DIR / "faces"
DETECTOR_MODEL = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = MODEL_DIR / "face_recognition_sface_2021dec.onnx"

# Cosine similarity at or above this counts as the same person. 0.363 is the
# threshold OpenCV publishes for SFace.
MATCH_THRESHOLD = 0.363

NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


def valid_name(name: str) -> bool:
    return bool(NAME_PATTERN.match(name))


class FaceEngine:
    def __init__(self, score_threshold: float = 0.8):
        for model in (DETECTOR_MODEL, RECOGNIZER_MODEL):
            if not model.is_file():
                raise FileNotFoundError(f"Missing model file {model}. Run mirror/deploy/setup-pi.sh.")
        self.detector = cv2.FaceDetectorYN.create(str(DETECTOR_MODEL), "", (320, 320), score_threshold, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create(str(RECOGNIZER_MODEL), "")

    def detect(self, image: np.ndarray, min_width: int = 0, scale: float = 1.0) -> list[np.ndarray]:
        """Returns the faces in the image, largest first. Each face is a YuNet row.

        With scale below 1 the detector runs on a shrunken copy, which costs
        much less CPU. The returned boxes and landmarks are in the coordinates
        of the full image, so embed() still works on the full image.
        """
        target = image if scale == 1.0 else cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        height, width = target.shape[:2]
        self.detector.setInputSize((width, height))
        _, faces = self.detector.detect(target)
        if faces is None:
            return []
        if scale != 1.0:
            # Columns 0 to 13 are the box and the five landmarks. Column 14 is the score.
            faces[:, :14] /= scale
        faces = [face for face in faces if face[2] >= min_width]
        return sorted(faces, key=lambda face: face[2] * face[3], reverse=True)

    def embed(self, image: np.ndarray, face: np.ndarray) -> np.ndarray:
        """Returns a unit-length embedding for one detected face."""
        aligned = self.recognizer.alignCrop(image, face)
        feature = self.recognizer.feature(aligned).flatten().astype(np.float32)
        norm = float(np.linalg.norm(feature))
        return feature / norm if norm > 0 else feature


def load_known() -> dict[str, np.ndarray]:
    """Loads every enrolled person as name -> array of embeddings."""
    known: dict[str, np.ndarray] = {}
    if not FACE_DIR.is_dir():
        return known
    for path in sorted(FACE_DIR.glob("*.npy")):
        if not valid_name(path.stem):
            continue
        samples = np.load(path)
        if samples.ndim == 2 and len(samples) > 0:
            known[path.stem] = samples.astype(np.float32)
    return known


def known_stamp() -> tuple:
    """Changes whenever an enrollment file is added, removed or rewritten."""
    if not FACE_DIR.is_dir():
        return ()
    return tuple(sorted((path.name, path.stat().st_mtime_ns) for path in FACE_DIR.glob("*.npy")))


def save_person(name: str, samples: list[np.ndarray]) -> Path:
    if not valid_name(name):
        raise ValueError(f"Invalid name {name!r}. Use lowercase letters, digits, - and _.")
    FACE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(FACE_DIR, 0o700)
    path = FACE_DIR / f"{name}.npy"
    temporary = FACE_DIR / f".{name}.tmp.npy"
    np.save(temporary, np.stack(samples).astype(np.float32))
    os.replace(temporary, path)
    os.chmod(path, 0o600)
    return path


def match(embedding: np.ndarray, known: dict[str, np.ndarray], threshold: float = MATCH_THRESHOLD) -> tuple[str | None, float]:
    """Returns (name, score) for the closest enrolled person, or (None, score)."""
    best_name, best_score = None, -1.0
    for name, samples in known.items():
        scores = samples @ embedding
        # The mean of the closest few samples is steadier than the single best.
        top = np.sort(scores)[-3:]
        score = float(top.mean())
        if score > best_score:
            best_name, best_score = name, score
    if best_name is not None and best_score >= threshold:
        return best_name, best_score
    return None, best_score
