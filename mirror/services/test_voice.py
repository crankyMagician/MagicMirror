"""Tests for the command matching in voice.py. They need no microphone or model.

Run on the Pi:
    ~/mirror-data/venv/bin/python -m unittest discover -s ~/MagicMirror/mirror/services -v
"""

import json
import unittest

from voice import SAMPLE_RATE, Capture, Commands, Listener, Understanding, deepgram, level_of, normalize

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


HOUSE = Commands(
    [
        {"id": "light:off:upstairs", "phrases": ["mirror turn off the upstairs lights"], "bare": ["turn off the upstairs lights"]},
        {"id": "light:on:kitchen", "phrases": ["mirror turn on the kitchen lights"], "bare": ["turn on the kitchen lights"]},
        {"id": "light:scene:christmas", "phrases": ["mirror christmas lights"], "bare": ["christmas lights"]},
        {"id": "light:scene:christmas_music", "phrases": ["mirror christmas music"], "bare": ["christmas music"]},
        {"id": "show:calendar", "phrases": ["mirror show the calendar"], "bare": ["show the calendar"]},
        {"id": "show:work-calendar", "phrases": ["mirror show the work calendar"], "bare": ["show the work calendar"]},
    ],
    ["mirror"],
)


def house():
    return Listener(HOUSE, 0.65, window_seconds=8, extend_seconds=5)


class LooseMatchTest(unittest.TestCase):
    """Phrases from the mirror's log on 2026-11-26 that used to be missed."""

    def test_a_left_out_the_still_matches(self):
        out = house().final(result("mirror turn off upstairs lights"), 1.0)
        self.assertEqual(out[0]["id"], "light:off:upstairs")

    def test_a_doubled_wake_word_still_matches(self):
        out = house().final(result("mirror mirror turn on the kitchen lights"), 1.0)
        self.assertEqual(out[0]["id"], "light:on:kitchen")

    def test_other_words_still_do_not_match(self):
        out = house().final(result("mirror turn off the kitchen upstairs lights"), 1.0)
        self.assertEqual(out[0]["type"], "missed")

    def test_a_loose_form_two_commands_share_matches_neither(self):
        commands = Commands([{"id": "one", "phrases": ["mirror the lamp"]}, {"id": "two", "phrases": ["mirror a lamp"]}], ["mirror"])
        self.assertEqual(commands.lookup("mirror the lamp"), "one")
        self.assertIsNone(commands.lookup("mirror lamp"))


class UnfinishedTest(unittest.TestCase):
    def test_a_pause_inside_a_command_waits_for_the_rest(self):
        heard = house()
        out = heard.final(result("mirror turn on"), 1.0)
        self.assertEqual(out, [{"type": "window", "open": True, "seconds": 8, "reason": "wake", "so_far": "turn on"}])
        out = heard.final(result("the kitchen lights"), 2.5)
        self.assertEqual(out[0]["id"], "light:on:kitchen")
        self.assertEqual(out[0]["text"], "turn on the kitchen lights")
        self.assertFalse(heard.window_open())

    def test_a_name_alone_waits_for_lights_or_music(self):
        heard = house()
        self.assertEqual(heard.final(result("mirror christmas"), 1.0)[0]["so_far"], "christmas")
        self.assertEqual(heard.final(result("music"), 2.0)[0]["id"], "light:scene:christmas_music")

    def test_a_pause_can_come_twice(self):
        heard = house()
        heard.final(result("mirror show"), 1.0)
        self.assertEqual(heard.final(result("the work"), 2.0)[0]["so_far"], "show the work")
        self.assertEqual(heard.final(result("calendar"), 3.0)[0]["id"], "show:work-calendar")

    def test_a_full_command_after_the_pause_still_works(self):
        heard = house()
        heard.final(result("mirror show"), 1.0)
        self.assertEqual(heard.final(result("christmas lights"), 2.0)[0]["id"], "light:scene:christmas")

    def test_the_first_part_is_forgotten_when_the_window_closes(self):
        heard = house()
        heard.final(result("mirror turn on"), 1.0)
        heard.tick(9.5)
        self.assertIsNone(heard.so_far)
        self.assertEqual(heard.final(result("the kitchen lights"), 12.0), [])

    def test_a_first_part_without_the_wake_word_outside_a_window_is_ignored(self):
        self.assertEqual(house().final(result("turn on"), 1.0), [])

    def test_a_faint_first_part_is_a_miss(self):
        out = house().final(result("mirror turn on", 0.5), 1.0)
        self.assertEqual(out[0]["type"], "missed")

    def test_words_that_start_no_command_are_a_miss(self):
        out = house().final(result("mirror on"), 1.0)
        self.assertEqual(out[0]["type"], "missed")


class LevelTest(unittest.TestCase):
    def test_silence_is_zero_and_loud_is_capped(self):
        import array

        self.assertEqual(level_of(bytes(4000)), 0.0)
        loud = array.array("h", [20000, -20000] * 1000).tobytes()
        self.assertEqual(level_of(loud), 1.0)


def spoken():
    """A household's commands as the helper sends them, with the light switches deferred."""
    bare = {
        "good_night": ["good night"],
        "what_is_next": ["what is next"],
        "only:calendar": ["show only the calendar", "just the calendar"],
        "light:scene:christmas": ["christmas lights"],
        "light:off:kitchen": ["turn off the kitchen lights"],
    }
    return Commands(
        [{"id": key, "phrases": [f"mirror {p}" for p in phrases], "bare": phrases} for key, phrases in bare.items()],
        ["mirror"],
        defer=["light:on:", "light:off:", "light:level:"],
        keyterms=["mirror", "nook", "mirror"],
    )


class AfterWakeTest(unittest.TestCase):
    def test_the_wake_word_and_punctuation_go(self):
        self.assertEqual(spoken().after_wake("Mirror, turn off the kitchen."), ("turn off the kitchen", True))

    def test_hey_and_a_doubled_wake_word_go(self):
        self.assertEqual(spoken().after_wake("Hey mirror mirror what is next?"), ("what is next", True))

    def test_a_near_miss_of_the_wake_word_counts(self):
        self.assertEqual(spoken().after_wake("Mira, good night."), ("good night", True))

    def test_a_sentence_without_it_is_kept_whole(self):
        self.assertEqual(spoken().after_wake("And then the kids left."), ("And then the kids left", False))

    def test_keyterms_are_unique(self):
        self.assertEqual(spoken().keyterms, ["mirror", "nook"])


class UnderstandTest(unittest.TestCase):
    def test_exact_loose_and_near(self):
        commands = spoken()
        self.assertEqual(commands.understand("Good night."), "good_night")
        self.assertEqual(commands.understand("just calendar"), "only:calendar")
        self.assertEqual(commands.understand("Christmas light"), "light:scene:christmas")

    def test_other_sentences_find_nothing(self):
        commands = spoken()
        self.assertIsNone(commands.understand("what is the capital of France"))
        self.assertIsNone(commands.understand("dim the kitchen to 30%"))
        self.assertIsNone(commands.understand(""))


class FakeListener:
    def __init__(self, talking=True, announced=True, window=False):
        self.talking, self.announced, self.window = talking, announced, window
        self.window_reason = "follow_up" if window else None

    def in_utterance(self):
        return self.talking

    def window_open(self):
        return self.window

    def close_window(self, why):
        return []


CHUNK = b"\x00\x10" * 2000  # an eighth of a second of speech
QUIET = b"\x00\x00" * 2000  # and of silence


def understanding(answer=None, error=None):
    sent = []

    def transcribe(pcm):
        sent.append(pcm)
        if error:
            raise error
        return answer

    return Understanding(spoken(), transcribe, start=lambda work: work()), sent


def say(understanding, verdict, listener=None):
    """One utterance: a chunk before it, two while it is said, the listener's verdict, then half a second of quiet."""
    listener = listener or FakeListener()
    out = understanding.audio(CHUNK, FakeListener(talking=False))
    out += understanding.audio(CHUNK, listener)
    out += understanding.audio(CHUNK, listener)
    out += understanding.messages([verdict])
    for _ in range(4):
        out += understanding.audio(QUIET, listener)
    return out + understanding.poll()


VOSK_MISS = {"type": "missed", "text": "mirror lights show days is", "confidence": 0.9, "why": "unknown", "window": None}


class UnderstandingTest(unittest.TestCase):
    def test_a_command_comes_from_deepgram(self):
        heard, sent = understanding({"text": "Mirror, show only the calendar.", "confidence": 0.97})
        out = say(heard, VOSK_MISS)
        self.assertEqual([m["type"] for m in out], ["thinking", "transcript", "command"])
        self.assertEqual(out[2]["id"], "only:calendar")
        self.assertEqual(out[2]["source"], "deepgram")
        # The second from before the wake word went along, and the quiet after the verdict.
        self.assertEqual(len(sent[0]), 3 * len(CHUNK) + 4 * len(QUIET))

    def test_speech_after_vosk_ends_the_utterance_still_goes_along(self):
        heard, sent = understanding({"text": "Mirror, how tall is Mount Everest?", "confidence": 0.99})
        listener = FakeListener()
        heard.audio(CHUNK, listener)
        self.assertEqual(heard.messages([VOSK_MISS]), [])
        # "Everest" comes after Vosk's verdict, and Vosk's verdict on it is part of the same sentence.
        for _ in range(3):
            self.assertEqual(heard.audio(CHUNK, listener), [])
        self.assertEqual(heard.messages([{**VOSK_MISS, "text": "everest"}]), [])
        out = []
        for _ in range(4):
            out += heard.audio(QUIET, listener)
        self.assertEqual(out, [{"type": "thinking"}])
        self.assertEqual(len(sent[0]), 4 * len(CHUNK) + 4 * len(QUIET))

    def test_the_first_part_of_a_command_is_sent_when_the_speaker_stops(self):
        heard, sent = understanding({"text": "Mirror, turn off the kitchen.", "confidence": 0.99})
        listener = FakeListener()
        heard.audio(CHUNK, listener)
        window = {"type": "window", "open": True, "seconds": 8, "reason": "wake", "so_far": "turn off the kitchen"}
        self.assertEqual(heard.messages([window]), [window])
        out = []
        for _ in range(9):
            out += heard.audio(QUIET, listener)
        self.assertEqual(out, [])
        out += heard.audio(QUIET, listener) + heard.poll()
        self.assertEqual(out[-1], {"type": "utterance", "text": "turn off the kitchen", "confidence": 0.99, "window": None})

    def test_a_light_switch_goes_to_the_house(self):
        heard, _ = understanding({"text": "Mirror, turn off the kitchen lights.", "confidence": 0.95})
        out = say(heard, VOSK_MISS)
        self.assertEqual(out[-1], {"type": "utterance", "text": "turn off the kitchen lights", "confidence": 0.95, "window": None})

    def test_a_show_stays_on_the_mirror(self):
        heard, _ = understanding({"text": "Mirror, Christmas lights.", "confidence": 0.9})
        self.assertEqual(say(heard, VOSK_MISS)[-1]["id"], "light:scene:christmas")

    def test_a_question_is_an_utterance(self):
        heard, _ = understanding({"text": "Mirror, how tall is Mount Everest?", "confidence": 0.99})
        self.assertEqual(say(heard, VOSK_MISS)[-1]["text"], "how tall is Mount Everest")

    def test_without_the_internet_vosk_decides(self):
        held = {"type": "command", "id": "good_night", "text": "mirror good night", "confidence": 1.0, "window": None}
        heard, _ = understanding(error=OSError("Network is unreachable"))
        out = say(heard, held)
        self.assertEqual(out[-2], {"type": "stt_failed", "message": "Network is unreachable"})
        self.assertEqual(out[-1], held)

    def test_a_false_wake_is_dropped(self):
        heard, _ = understanding({"text": "And then the kids left.", "confidence": 0.9})
        self.assertEqual(say(heard, VOSK_MISS)[-1]["why"], "no_wake")

    def test_in_a_window_no_wake_word_is_needed(self):
        heard, _ = understanding({"text": "And the nook too.", "confidence": 0.9})
        out = say(heard, {**VOSK_MISS, "window": "follow_up"}, FakeListener(announced=False, window=True))
        self.assertEqual(out[-1], {"type": "utterance", "text": "And the nook too", "confidence": 0.9, "window": "follow_up"})

    def test_nothing_after_the_wake_word_sends_nothing(self):
        heard, sent = understanding({"text": "", "confidence": 0})
        heard.audio(CHUNK, FakeListener())
        out = heard.messages([{"type": "window", "open": False, "reason": "timeout"}])
        self.assertEqual(out, [{"type": "window", "open": False, "reason": "timeout"}])
        self.assertEqual(sent, [])
        self.assertFalse(heard.capture.active)

    def test_talk_without_the_wake_word_is_not_captured(self):
        heard, _ = understanding()
        heard.audio(CHUNK, FakeListener(announced=False))
        self.assertFalse(heard.capture.active)

    def test_verdicts_wait_while_one_is_written_down(self):
        heard, _ = understanding()
        heard.start = lambda work: None
        say(heard, VOSK_MISS)
        self.assertTrue(heard.busy)
        self.assertEqual(heard.messages([{**VOSK_MISS, "text": "mirror again"}]), [])


class CaptureTest(unittest.TestCase):
    def test_a_long_utterance_is_cut_off(self):
        capture = Capture(preroll_chunks=2, max_seconds=0.25)
        capture.start()
        capture.feed(CHUNK)
        self.assertFalse(capture.full())
        capture.feed(CHUNK)
        self.assertTrue(capture.full())
        self.assertEqual(len(capture.take()), 2 * len(CHUNK))
        self.assertFalse(capture.active)


class DeepgramTest(unittest.TestCase):
    def test_the_request_and_the_answer(self):
        seen = {}

        class Answer:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return json.dumps({"results": {"channels": [{"alternatives": [{"transcript": "Mirror, good night.", "confidence": 0.98765}]}]}}).encode()

        def opener(request, timeout):
            seen.update(url=request.full_url, auth=request.get_header("Authorization"), body=request.data, timeout=timeout)
            return Answer()

        transcribe = deepgram("KEY", ["nook", "Hanukkah"], opener=opener)
        self.assertEqual(transcribe(b"\x00\x00" * SAMPLE_RATE), {"text": "Mirror, good night.", "confidence": 0.988})
        self.assertIn("model=nova-3", seen["url"])
        self.assertIn("keyterm=nook&keyterm=Hanukkah", seen["url"])
        self.assertEqual(seen["auth"], "Token KEY")
        self.assertTrue(seen["body"].startswith(b"RIFF"))
        self.assertEqual(seen["timeout"], 4.0)


if __name__ == "__main__":
    unittest.main()
