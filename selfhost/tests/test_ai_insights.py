"""Unit tests for the grounded AI traffic review. No production events used."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import ai_insights  # noqa: E402

SNAPSHOT = {
    "project": "demo-site",
    "projects": [{"id": "demo-site", "name": "Demo Site", "url": "https://demo.test",
                  "pageviews": 120, "sessions": 90, "visitors": 80,
                  "human_visitors": 70, "bot_visitors": 10, "human_pageviews": 100,
                  "bot_pageviews": 20, "conversions": 2, "revenue": 0.0}],
    "features": [
        {"feature": "Pageviews", "value": 120},
        {"feature": "Unique visitors", "value": 80},
        {"feature": "Humans · likely", "value": 70},
        {"feature": "Bots", "value": 10},
        {"feature": "Engaged sessions", "value": 3},
        {"feature": "Returning visitors", "value": 12},
        {"feature": "Average scroll depth, %", "value": 41},
        {"feature": "Active time on page, s", "value": 18},
        {"feature": "Goal 1", "value": 1},
        {"feature": "Goal 2", "value": 1},
    ],
    "daily": [{"date": "2026-11-20", "pageviews": 10, "human_pageviews": 8},
              {"date": "2026-11-21", "pageviews": 110, "human_pageviews": 92}],
    "previous": [{"date": "2026-11-18", "pageviews": 50, "human_pageviews": 40},
                 {"date": "2026-11-19", "pageviews": 50, "human_pageviews": 40}],
    "hourly": [{"hour": h, "visitors": 1} for h in range(24)],
    "attribution": [{"channel": "Direct", "conversions": 2, "linked": 0, "revenue": 0.0}],
    "traffic": [{"traffic_type": "human", "visitors": 70, "pageviews": 100},
                {"traffic_type": "bot", "visitors": 10, "pageviews": 20}],
    "devices": [{"device_type": "mobile", "visitors": 60, "pageviews": 90}],
    "countries": [{"country": "US", "visitors": 30}],
    "pages": [{"path": "/", "pageviews": 100}],
    "goal_events": [{"event_name": "Goal1", "events": 1, "sessions": 1}],
    "top_events": [{"event_name": "page_view", "events": 120}],
}

FEATURES = ai_insights.build_features(SNAPSHOT, "demo-site", 2)


class TestFeatures(unittest.TestCase):
    def test_totals_and_trend(self):
        self.assertEqual(FEATURES["totals"]["pageviews"], 120)
        self.assertEqual(FEATURES["totals"]["visitors"], 80)
        self.assertEqual(FEATURES["trend"]["pageviews_current"], 120)
        self.assertEqual(FEATURES["trend"]["pageviews_previous"], 100)
        self.assertEqual(FEATURES["trend"]["change_percent"], 20.0)
        self.assertEqual(FEATURES["totals"]["goal1"], 1)
        self.assertEqual(FEATURES["totals"]["goal2"], 1)


class TestValidation(unittest.TestCase):
    def test_validate_sanitizes_and_clamps(self):
        result = ai_insights._validate({
            "summary": " 120  views\n ",
            "chain": [{"step": "1. Обзор", "observation": "120 просмотров",
                       "hypothesis": "?", "check": "?", "verdict": "?"}],
            "anomalies": [{"signal": "x", "evidence": "10", "severity": "CRITICAL",
                           "interpretation": "y"}],
            "actions": [{"priority": "URGENT", "title": "t", "detail": "d",
                         "metric_to_watch": "m"}],
            "confidence": 9,
        }, FEATURES)
        self.assertEqual(result["summary"], "120 views")
        self.assertEqual(result["anomalies"][0]["severity"], "low")
        self.assertEqual(result["actions"][0]["priority"], "low")
        self.assertEqual(result["confidence"], 1.0)


class TestGrounding(unittest.TestCase):
    def test_accepts_only_numbers_present_in_features(self):
        review = ai_insights._validate({
            "summary": "120 просмотров, 80 посетителей",
            "chain": [{"step": "1. Обзор", "observation": "10 ботов из 80 посетителей",
                       "hypothesis": "x", "check": "y", "verdict": "z"}],
            "anomalies": [], "actions": [], "confidence": 0.8,
        }, FEATURES)
        checked = ai_insights.grounding_guard(FEATURES, review)
        self.assertTrue(checked["grounding"]["ok"], checked["grounding"]["unsupported"])
        self.assertEqual(checked["source"], "llm")

    def test_rejects_invented_number_and_falls_back_to_rules(self):
        review = ai_insights._validate({
            "summary": "Трафик вырос на 999 процентов",
            "chain": [{"step": "1. Обзор", "observation": "999 просмотров",
                       "hypothesis": "x", "check": "y", "verdict": "z"}],
            "anomalies": [], "actions": [], "confidence": 0.9,
        }, FEATURES)
        checked = ai_insights.grounding_guard(FEATURES, review)
        self.assertFalse(checked["grounding"]["ok"])
        self.assertIn("999", str(checked["grounding"]["unsupported"]))
        self.assertEqual(checked["source"], "rules")

    def test_local_review_never_invents_numbers(self):
        local = ai_insights._local_review(FEATURES, "test")
        checked = ai_insights.grounding_guard(FEATURES, local)
        self.assertTrue(checked["grounding"]["ok"], checked["grounding"]["unsupported"])


if __name__ == "__main__":
    unittest.main()
