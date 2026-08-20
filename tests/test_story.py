"""Visual story generation tests — scripted LLM, real grounding index."""

import json

import pytest

from app.tools.story import generate_visual_story

STORY_KEY = "storyboard planner"

ARTICLES = [
    {"title": "Stents vs surgery", "year": 2023},
    {"title": "Statin therapy meta-analysis", "year": 2022},
]


class ScriptedLLM:
    def __init__(self, response):
        self.response = response if isinstance(response, str) else json.dumps(response)
        self.calls = []

    async def generate(self, user, system=None):
        self.calls.append((user, system or ""))
        assert STORY_KEY in (system or "")
        return self.response


class ExplodingLLM:
    async def generate(self, user, system=None):
        raise RuntimeError("llm down")


def story_payload(**overrides):
    payload = {
        "has_story": True,
        "title": "How a blocked coronary artery causes chest pain",
        "steps": [
            {
                "title": "Healthy blood supply",
                "text": "Coronary arteries feed the heart muscle with oxygen.",
                "anatomy_terms": ["coronary artery"],
                "overlay": "highlight",
                "citations": [1],
            },
            {
                "title": "The blockage",
                "text": "Plaque narrows the artery, restricting flow.",
                "anatomy_terms": ["coronary artery"],
                "overlay": "stenosis",
                "citations": [1, 2],
            },
        ],
    }
    payload.update(overrides)
    return payload


async def test_story_grounds_terms_and_sets_scene():
    story = await generate_visual_story(
        "my heart artery is choked", "answer text", ARTICLES, ScriptedLLM(story_payload())
    )
    assert story is not None
    assert story["scene"] == "heart"
    assert len(story["steps"]) == 2
    step = story["steps"][0]
    assert step["structure_ids"]
    assert step["matched_terms"] == ["coronary artery"]
    assert step["overlay"] == "highlight"
    assert step["citations"] == [1]


async def test_story_invalid_overlay_falls_back_to_highlight():
    payload = story_payload()
    payload["steps"][0]["overlay"] = "explosion"
    story = await generate_visual_story("q", "a", ARTICLES, ScriptedLLM(payload))
    assert story["steps"][0]["overlay"] == "highlight"


async def test_story_out_of_range_citations_dropped():
    payload = story_payload()
    payload["steps"][0]["citations"] = [0, 1, 2, 3, 99, "x"]
    story = await generate_visual_story("q", "a", ARTICLES, ScriptedLLM(payload))
    # only 2 articles -> valid citations are 1 and 2
    assert story["steps"][0]["citations"] == [1, 2]


async def test_story_ungroundable_step_keeps_text_no_overlay():
    payload = story_payload()
    payload["steps"][1]["anatomy_terms"] = ["the ineffable essence"]
    payload["steps"][1]["overlay"] = "stenosis"
    story = await generate_visual_story("q", "a", ARTICLES, ScriptedLLM(payload))
    step = story["steps"][1]
    assert step["structure_ids"] == []
    assert step["overlay"] == "none"
    assert step["text"]


async def test_story_dropped_when_no_step_grounds():
    payload = story_payload()
    for s in payload["steps"]:
        s["anatomy_terms"] = ["nothing real"]
    story = await generate_visual_story("q", "a", ARTICLES, ScriptedLLM(payload))
    assert story is None


async def test_story_has_story_false_returns_none():
    story = await generate_visual_story(
        "q", "a", ARTICLES, ScriptedLLM({"has_story": False, "steps": []})
    )
    assert story is None


async def test_story_llm_failure_returns_none():
    story = await generate_visual_story("q", "a", ARTICLES, ExplodingLLM())
    assert story is None


async def test_story_caps_steps_and_lengths():
    payload = story_payload()
    payload["title"] = "T" * 500
    payload["steps"] = [
        {
            "title": "S" * 300,
            "text": "x" * 5000,
            "anatomy_terms": ["aorta"],
            "overlay": "highlight",
            "citations": [1],
        }
    ] * 10
    story = await generate_visual_story("q", "a", ARTICLES, ScriptedLLM(payload))
    assert len(story["title"]) <= 120
    assert len(story["steps"]) <= 6
    assert len(story["steps"][0]["title"]) <= 80
    assert len(story["steps"][0]["text"]) <= 600


async def test_story_minority_scene_step_does_not_hijack_scene():
    """A single scene-tagged step (e.g. pulmonary arteries in a calf-DVT
    story) must not flip the whole story into that deep-dive scene."""
    payload = {
        "has_story": True,
        "title": "Deep vein clot in the calf",
        "steps": [
            {
                "title": "Deep calf veins",
                "text": "The posterior tibial veins run deep in the calf.",
                "anatomy_terms": ["posterior tibial vein"],
                "overlay": "highlight",
                "citations": [1],
            },
            {
                "title": "Popliteal vein",
                "text": "Calf veins drain into the popliteal vein.",
                "anatomy_terms": ["popliteal vein"],
                "overlay": "highlight",
                "citations": [1],
            },
            {
                "title": "Risk of spread",
                "text": "Rarely a clot travels to the lung arteries.",
                "anatomy_terms": ["pulmonary artery"],
                "overlay": "flow",
                "citations": [2],
            },
        ],
    }
    story = await generate_visual_story("calf clot", "a", ARTICLES, ScriptedLLM(payload))
    assert story is not None
    assert story["scene"] is None  # calf steps have no scene; heart is a minority


async def test_story_majority_scene_steps_still_set_scene():
    story = await generate_visual_story(
        "my heart artery is choked", "a", ARTICLES, ScriptedLLM(story_payload())
    )
    assert story["scene"] == "heart"
