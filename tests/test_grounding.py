"""Deterministic anatomy grounding tests (real index, no LLM)."""

import pytest

from app.tools.grounding import (
    ground_term,
    ground_terms,
    scene_for_structures,
    validate_structure_ids,
)


# ── ground_term resolution ───────────────────────────────────────────────


def test_lay_synonym_heart_artery():
    r = ground_term("heart artery")
    assert r is not None
    assert r["matched_name"] == "coronary artery"
    assert r["scene"] == "heart"
    assert r["structure_ids"]


def test_synonym_inside_longer_query():
    r = ground_term("my heart artery is choked")
    assert r is not None
    assert r["matched_name"] == "coronary artery"
    assert r["scene"] == "heart"


def test_lad_synonym_resolves_to_anterior_interventricular():
    r = ground_term("LAD")
    assert r is not None
    assert "anterior interventricular" in r["matched_name"]
    assert r["scene"] == "heart"


def test_exact_name():
    r = ground_term("aorta")
    assert r is not None
    assert r["matched_name"] == "aorta"


def test_laterality_stripped():
    # "left aorta" is not an index name; laterality stripping recovers "aorta".
    r = ground_term("left aorta")
    assert r is not None
    assert r["matched_name"] == "aorta"


def test_retina_prefers_whole_word_over_retinaculum():
    r = ground_term("retina")
    assert r is not None
    assert "retinacul" not in r["matched_name"]
    assert "retina" in r["matched_name"]
    assert r["scene"] == "eyes"


def test_eye_synonym():
    r = ground_term("eye")
    assert r is not None
    assert r["scene"] == "eyes"


def test_wisdom_tooth_synonym():
    r = ground_term("wisdom tooth")
    assert r is not None
    assert r["matched_name"] == "molar tooth"
    assert r["scene"] == "teeth"


def test_nonsense_returns_none():
    assert ground_term("flux capacitor overload") is None


def test_empty_and_whitespace_return_none():
    assert ground_term("") is None
    assert ground_term("   ") is None


def test_structure_ids_capped():
    r = ground_term("heart")
    assert r is not None
    assert len(r["structure_ids"]) <= 96


# ── ground_terms batching ────────────────────────────────────────────────


def test_ground_terms_dedupes_by_matched_name():
    out = ground_terms(["heart artery", "coronary artery"])
    assert len(out) == 1
    assert out[0]["matched_name"] == "coronary artery"


def test_ground_terms_skips_ungroundable():
    out = ground_terms(["coronary artery", "zzz not anatomy"])
    assert [g["matched_name"] for g in out] == ["coronary artery"]


def test_ground_terms_caps_input():
    out = ground_terms(["aorta"] * 50)
    assert len(out) == 1


# ── whitelist validation & scene voting ──────────────────────────────────


def test_validate_structure_ids_filters_unknown():
    r = ground_term("aorta")
    ids = r["structure_ids"]
    kept = validate_structure_ids(ids + ["FJ99999_fake", "not-an-id"])
    assert kept == ids


def test_scene_for_structures_majority_vote():
    heart = ground_term("coronary artery")["structure_ids"]
    assert scene_for_structures(heart) == "heart"
    assert scene_for_structures(["nope"]) is None
    assert scene_for_structures([]) is None
