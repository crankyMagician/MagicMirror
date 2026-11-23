"""Tests for the smoothing and matching logic. They need no camera.

Run on the Pi:
    ~/mirror-data/venv/bin/python -m unittest discover -s ~/MagicMirror/mirror/services -v
"""

import unittest

import numpy as np

import facelib
from presence import GUEST, UNKNOWN, Smoother


class SmootherTest(unittest.TestCase):
    def feed(self, smoother, sightings, start=0.0, step=0.4):
        result, now = None, start
        for sighting in sightings:
            result = smoother.update(sighting, now)
            now += step
        return result, now

    def test_one_frame_is_not_enough(self):
        smoother = Smoother(confirm=2, hold=8)
        self.assertIsNone(smoother.update("sam", 0.0))
        self.assertEqual(smoother.update("sam", 0.4), "sam")

    def test_person_is_held_through_a_gap(self):
        smoother = Smoother(confirm=2, hold=8)
        _, now = self.feed(smoother, ["sam", "sam"])
        result, _ = self.feed(smoother, [None] * 10, start=now)
        self.assertEqual(result, "sam")

    def test_person_clears_after_the_hold(self):
        smoother = Smoother(confirm=2, hold=8)
        _, now = self.feed(smoother, ["sam", "sam"])
        result, _ = self.feed(smoother, [None] * 30, start=now)
        self.assertIsNone(result)

    def test_stranger_does_not_replace_a_person_during_the_hold(self):
        smoother = Smoother(confirm=2, hold=8)
        _, now = self.feed(smoother, ["sam", "sam"])
        result, now = self.feed(smoother, [UNKNOWN] * 5, start=now)
        self.assertEqual(result, "sam")
        result, _ = self.feed(smoother, [UNKNOWN] * 30, start=now)
        self.assertEqual(result, UNKNOWN)

    def test_another_person_replaces_at_once(self):
        smoother = Smoother(confirm=2, hold=8)
        _, now = self.feed(smoother, ["sam", "sam"])
        result, _ = self.feed(smoother, ["heather", "heather"], start=now)
        self.assertEqual(result, "heather")

    def test_single_wrong_frame_is_ignored(self):
        smoother = Smoother(confirm=2, hold=8)
        _, now = self.feed(smoother, ["sam", "sam"])
        result, _ = self.feed(smoother, ["heather", "sam", "heather", "sam"], start=now)
        self.assertEqual(result, "sam")

    def test_guest_counts_as_present(self):
        smoother = Smoother(confirm=2, hold=8)
        result, _ = self.feed(smoother, [GUEST, GUEST])
        self.assertEqual(result, GUEST)


class MatchTest(unittest.TestCase):
    def unit(self, *values):
        vector = np.array(values, dtype=np.float32)
        return vector / np.linalg.norm(vector)

    def test_closest_person_wins(self):
        known = {
            "sam": np.stack([self.unit(1, 0, 0), self.unit(0.9, 0.1, 0)]),
            "heather": np.stack([self.unit(0, 1, 0), self.unit(0.1, 0.9, 0)]),
        }
        name, score = facelib.match(self.unit(0.95, 0.05, 0), known)
        self.assertEqual(name, "sam")
        self.assertGreater(score, 0.9)

    def test_far_face_matches_nobody(self):
        known = {"sam": np.stack([self.unit(1, 0, 0)])}
        name, _ = facelib.match(self.unit(0, 0, 1), known)
        self.assertIsNone(name)

    def test_names_are_restricted(self):
        self.assertTrue(facelib.valid_name("heather"))
        self.assertFalse(facelib.valid_name("../etc"))
        self.assertFalse(facelib.valid_name("Sam"))


if __name__ == "__main__":
    unittest.main()
