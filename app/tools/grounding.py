"""
Anatomy grounding — deterministic term -> 3D structure resolution.

The "coding harness" insight applied to medicine: the LLM never invents
structure references. It emits free-text anatomical terms; this module
resolves them against a pre-built index derived from BodyParts3D / FMA
concept names (app/data/anatomy_grounding.json). Unresolvable terms are
dropped, so the frontend only ever receives mesh ids that exist.

Resolution strategy (cheap to expensive, all deterministic):
  1. exact lowercased name match
  2. exact match after stripping laterality ("left"/"right")
  3. whole-word containment: index names that contain every query word
     (shortest name wins — most specific concept covering the term)
  4. reverse containment: query contains an index name (e.g. query
     "blocked coronary artery" -> "coronary artery")
"""

from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "anatomy_grounding.json"

# Words that carry no anatomical meaning in a grounding query.
_STOPWORDS = {
    "the", "a", "an", "my", "of", "in", "on", "and", "or", "area", "region",
    "part", "parts", "issue", "problem", "pain",
}

# Lay/clinical synonyms -> FMA concept names present in the index. Checked
# before fuzzy matching so everyday language grounds predictably.
_SYNONYMS = {
    "heart artery": "coronary artery",
    "heart arteries": "coronary artery",
    "lad": "anterior interventricular branch of left coronary artery",
    "left anterior descending": "anterior interventricular branch of left coronary artery",
    "left anterior descending artery": "anterior interventricular branch of left coronary artery",
    "widowmaker": "anterior interventricular branch of left coronary artery",
    "heart valve": "mitral valve",
    "heart muscle": "wall of heart",
    "myocardium": "wall of heart",
    "front teeth": "incisor tooth",
    "wisdom tooth": "molar tooth",
    "wisdom teeth": "molar tooth",
    # index has no bare "eyeball" concept, only sided ones
    "eye": "right eyeball",
    "eyes": "right eyeball",
    "eyeball": "right eyeball",
    "kneecap": "patella",
    "collarbone": "clavicle",
    "shoulder blade": "scapula",
    "thigh bone": "femur",
    "shin bone": "tibia",
    "calf muscle": "head of gastrocnemius",
    "achilles": "calcaneal tendon",
    "windpipe": "trachea",
    "voice box": "larynx",
    "tailbone": "coccyx",
    "breastbone": "sternum",
}

_MAX_STRUCTURES_PER_TERM = 96


def _normalize(term: str) -> str:
    term = re.sub(r"[^a-z0-9\s-]", " ", term.lower())
    return re.sub(r"\s+", " ", term).strip()


@lru_cache(maxsize=1)
def _index() -> tuple[dict[str, list[str]], dict[str, dict]]:
    data = json.loads(_DATA_PATH.read_text())
    return data["names"], data["structures"]


def _score_scene(fids: list[str], structures: dict[str, dict]) -> str | None:
    """Most common deep-dive scene among the resolved meshes, if any."""
    counts: dict[str, int] = {}
    for fid in fids:
        for scene in structures.get(fid, {}).get("scenes", ()):
            counts[scene] = counts.get(scene, 0) + 1
    if not counts:
        return None
    return max(counts, key=lambda s: counts[s])


def ground_term(term: str) -> dict | None:
    """Resolve one anatomical term to displayable structure ids.

    Returns ``{"term", "matched_name", "structure_ids", "scene", "layer"}``
    or ``None`` when nothing in the index matches.
    """
    names, structures = _index()
    q = _normalize(term)
    if not q:
        return None

    matched: str | None = None
    # 0. lay-term synonyms (also as substring of longer queries)
    if q in _SYNONYMS and _SYNONYMS[q] in names:
        matched = _SYNONYMS[q]
    if matched is None:
        for lay, fma in _SYNONYMS.items():
            if re.search(rf"\b{re.escape(lay)}\b", q) and fma in names:
                matched = fma
                break
    # 1. exact
    if matched is None and q in names:
        matched = q
    # 2. exact minus laterality
    if matched is None:
        stripped = re.sub(r"\b(left|right)\b", "", q).strip()
        stripped = re.sub(r"\s+", " ", stripped)
        if stripped and stripped in names:
            matched = stripped
    # 3. index name contains every query word (whole words first, then
    #    prefix — so "retina" prefers "optic part of retina" over
    #    "retinaculum")
    if matched is None:
        words = [w for w in q.split() if w not in _STOPWORDS]
        if words:
            for pat in (r"\b{}\b", r"\b{}"):
                candidates = [
                    nm for nm in names
                    if all(re.search(pat.format(re.escape(w)), nm) for w in words)
                ]
                if candidates:
                    matched = min(candidates, key=len)
                    break
    # 4. query contains an index name (longest such name wins)
    if matched is None:
        containing = [
            nm for nm in names
            if len(nm) >= 4 and re.search(rf"\b{re.escape(nm)}\b", q)
        ]
        if containing:
            matched = max(containing, key=len)

    if matched is None:
        return None

    fids = names[matched][:_MAX_STRUCTURES_PER_TERM]
    layers = {structures[f].get("layer") for f in fids if f in structures}
    layers.discard(None)
    return {
        "term": term,
        "matched_name": matched,
        "structure_ids": fids,
        "scene": _score_scene(fids, structures),
        "layer": sorted(layers)[0] if len(layers) == 1 else None,
    }


def ground_terms(terms: list[str]) -> list[dict]:
    """Ground a list of terms; drops what cannot be resolved, dedupes."""
    out: list[dict] = []
    seen: set[str] = set()
    for term in terms[:12]:
        if not isinstance(term, str):
            continue
        res = ground_term(term)
        if res and res["matched_name"] not in seen:
            seen.add(res["matched_name"])
            out.append(res)
    return out


def validate_structure_ids(ids: list[str]) -> list[str]:
    """Whitelist filter: keep only ids that exist in the index."""
    _, structures = _index()
    return [i for i in ids if i in structures]


def scene_for_structures(ids: list[str]) -> str | None:
    _, structures = _index()
    return _score_scene(ids, structures)
