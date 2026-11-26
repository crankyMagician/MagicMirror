"""Tests for the command matching in voice.py. They need no microphone or model.

Run on the Pi:
    ~/mirror-data/venv/bin/python -m unittest discover -s ~/MagicMirror/mirror/services -v
"""

import json
import unittest

from voice import Commands, Listener, level_of, normalize

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


LIGHTS = Commands(
    [
        {"id": "light:on:kitchen", "phrases": ["mirror turn on the kitchen lights"], "bare": ["turn on the kitchen lights"]},
        {"id": "good_night", "phrases": ["mirror good night"], "bare": ["good night"]},
    ],
    ["mirror"],
)


def listener():
    return Listener(LIGHTS, 0.8, window_seconds=8, extend_seconds=5)


class TwoGrammarsTest(unittest.TestCase):
    def test_bare_phrases_are_only_in_the_window_grammar(self):
        normal = json.loads(LIGHTS.grammar())
        window = json.loads(LIGHTS.grammar(window=True))
        self.assertIn("mirror", normal)
        self.assertIn("mirror good night", normal)
        self.assertNotIn("good night", normal)
        self.assertIn("good night", window)
        self.assertIn("mirror good night", window)

    def test_bare_lookup_needs_the_window(self):
        self.assertIsNone(LIGHTS.lookup("good night"))
        self.assertEqual(LIGHTS.lookup("good night", window=True), "good_night")


class ListenerTest(unittest.TestCase):
    def test_one_breath_lights_up_then_matches(self):
        heard = listener()
        self.assertEqual(heard.partial("mirror", 1.0), [{"type": "listening", "on": True}])
        self.assertEqual(heard.partial("mirror good", 1.2), [])
        out = heard.final(result("mirror good night", 0.9), 1.6)
        self.assertEqual(out[0]["type"], "command")
        self.assertEqual(out[0]["id"], "good_night")
        self.assertIsNone(out[0]["window"])

    def test_the_wake_word_alone_opens_a_window_for_a_bare_command(self):
        heard = listener()
        heard.partial("mirror", 1.0)
        self.assertEqual(heard.final(result("mirror"), 1.3), [{"type": "window", "open": True, "seconds": 8, "reason": "wake"}])
        heard.partial("turn on", 3.0)
        out = heard.final(result("turn on the kitchen lights"), 4.0)
        self.assertEqual(out[0]["id"], "light:on:kitchen")
        self.assertEqual(out[0]["window"], "wake")
        self.assertEqual(out[1], {"type": "window", "open": False, "reason": "command"})
        self.assertFalse(heard.window_open())

    def test_a_bare_command_outside_a_window_does_nothing(self):
        heard = listener()
        heard.partial("good night", 1.0)
        self.assertEqual(heard.final(result("good night"), 1.5), [])

    def test_the_window_closes_when_nobody_speaks(self):
        heard = listener()
        heard.final(result("mirror"), 1.0)
        self.assertEqual(heard.tick(8.9), [])
        self.assertEqual(heard.tick(9.1), [{"type": "window", "open": False, "reason": "timeout"}])

    def test_speech_that_starts_in_time_is_waited_for(self):
        heard = listener()
        heard.final(result("mirror"), 1.0)
        heard.partial("good", 8.8)
        self.assertEqual(heard.tick(10.0), [])
        out = heard.final(result("good night"), 10.5)
        self.assertEqual(out[0]["id"], "good_night")

    def test_a_mumble_in_the_window_is_a_miss(self):
        heard = listener()
        heard.final(result("mirror"), 1.0)
        heard.partial("[unk]", 2.0)
        out = heard.final(result("[unk]"), 2.5)
        self.assertEqual(out[0]["type"], "missed")
        self.assertEqual(out[0]["why"], "unknown")
        self.assertEqual(out[0]["window"], "wake")
        self.assertFalse(heard.window_open())

    def test_a_known_phrase_said_unclearly_is_a_low_miss(self):
        heard = listener()
        heard.partial("mirror", 1.0)
        out = heard.final(result("mirror good night", 0.6), 1.5)
        self.assertEqual(out[0]["type"], "missed")
        self.assertEqual(out[0]["why"], "low")
        self.assertEqual(out[0]["text"], "mirror good night")

    def test_the_wake_word_with_unknown_words_is_a_miss_and_opens_nothing(self):
        heard = listener()
        heard.partial("mirror", 1.0)
        out = heard.final(result("mirror [unk] [unk]"), 1.5)
        self.assertEqual(out[0]["type"], "missed")
        self.assertFalse(heard.window_open())

    def test_talk_without_the_wake_word_is_ignored(self):
        heard = listener()
        heard.partial("[unk]", 1.0)
        self.assertEqual(heard.final(result("[unk] [unk]"), 1.5), [])

    def test_a_listening_light_that_came_to_nothing_goes_out(self):
        heard = listener()
        heard.partial("mirror", 1.0)
        self.assertEqual(heard.final({"text": ""}, 1.5), [{"type": "listening", "on": False}])

    def test_a_quiet_wake_word_opens_no_window(self):
        heard = listener()
        self.assertEqual(heard.final(result("mirror", 0.5), 1.0), [])

    def test_follow_up_window_takes_bare_commands(self):
        heard = listener()
        self.assertEqual(heard.open_window(20.0, 5, "follow_up")[0]["reason"], "follow_up")
        out = heard.final(result("good night"), 22.0)
        self.assertEqual(out[0]["window"], "follow_up")


class LevelTest(unittest.TestCase):
    def test_silence_is_zero_and_loud_is_capped(self):
        import array

        self.assertEqual(level_of(bytes(4000)), 0.0)
        loud = array.array("h", [20000, -20000] * 1000).tobytes()
        self.assertEqual(level_of(loud), 1.0)


if __name__ == "__main__":
    unittest.main()
