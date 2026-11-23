"""Tests for the command matching in voice.py. They need no microphone or model.

Run on the Pi:
    ~/mirror-data/venv/bin/python -m unittest discover -s ~/MagicMirror/mirror/services -v
"""

import json
import unittest

from voice import Commands, normalize

COMMANDS = Commands([
    {"id": "good_night", "phrases": ["Mirror, good night."]},
    {"id": "show:calendar", "phrases": ["mirror show calendar", "mirror show the calendar"]},
])


def result(text, confidence=1.0):
    return {"text": text, "result": [{"word": word, "conf": confidence} for word in text.split()]}


class NormalizeTest(unittest.TestCase):
    def test_lowercases_and_drops_punctuation(self):
        self.assertEqual(normalize("Mirror, good  night."), "mirror good night")

    def test_keeps_apostrophes(self):
        self.assertEqual(normalize("What's up"), "what's up")


class CommandsTest(unittest.TestCase):
    def test_grammar_lists_every_phrase_and_unknown(self):
        grammar = json.loads(COMMANDS.grammar())
        self.assertIn("mirror good night", grammar)
        self.assertIn("mirror show the calendar", grammar)
        self.assertEqual(grammar[-1], "[unk]")

    def test_full_phrase_matches(self):
        message = COMMANDS.match(result("mirror show the calendar"), 0.8)
        self.assertEqual(message["id"], "show:calendar")
        self.assertEqual(message["type"], "command")

    def test_part_of_a_phrase_does_not_match(self):
        self.assertIsNone(COMMANDS.match(result("good night"), 0.8))
        self.assertIsNone(COMMANDS.match(result("mirror"), 0.8))

    def test_extra_known_words_do_not_match(self):
        self.assertIsNone(COMMANDS.match(result("mirror good night show calendar"), 0.8))

    def test_unknown_marks_around_a_phrase_are_ignored(self):
        self.assertEqual(COMMANDS.match(result("[unk] mirror good night"), 0.0)["id"], "good_night")

    def test_low_confidence_is_dropped(self):
        self.assertIsNone(COMMANDS.match(result("mirror good night", 0.5), 0.8))
        self.assertIsNotNone(COMMANDS.match(result("mirror good night", 0.9), 0.8))

    def test_result_without_word_scores_is_dropped(self):
        self.assertIsNone(COMMANDS.match({"text": "mirror good night"}, 0.8))

class CheckWordsTest(unittest.TestCase):
    """The words-only check builds its command list the way the helper's does."""

    def test_a_phrase_to_check_becomes_one_command(self):
        commands = Commands([{"id": "check", "phrases": ["Hey, Mirror!"]}])
        self.assertEqual(json.loads(commands.grammar()), ["hey mirror", "[unk]"])


if __name__ == "__main__":
    unittest.main()
