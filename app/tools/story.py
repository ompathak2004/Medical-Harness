"""
Visual story generation — plans a guided 3D anatomy walkthrough for an
answered question, with every anatomical reference grounded deterministically.

The LLM emits free-text anatomy terms per step; ``app.tools.grounding``
resolves them to real BodyParts3D structure ids. Steps whose terms cannot be
grounded lose their 3D focus but keep their text; a story with no groundable
steps at all is dropped (the frontend simply shows no tour).
"""

from __future__ import annotations

import logging

from app.json_utils import parse_json_response
from app.prompts import VISUAL_STORY_SYSTEM, VISUAL_STORY_USER
from app.tools.grounding import ground_terms, scene_for_structures

logger = logging.getLogger(__name__)

_ALLOWED_OVERLAYS = {"none", "highlight", "stenosis", "inflammation", "flow"}
_MAX_STEPS = 6


async def generate_visual_story(
    question: str,
    answer: str,
    articles: list[dict],
    llm_client,
) -> dict | None:
    """Return a grounded visual story dict, or None."""
    citations = "\n".join(
        f"[{i + 1}] {a.get('title', 'Untitled')}"
        for i, a in enumerate(articles[:8])
    ) or "(no articles)"

    try:
        raw = await llm_client.generate(
            VISUAL_STORY_USER.format(
                question=question[:2000],
                answer=answer[:4000],
                citations=citations,
            ),
            system=VISUAL_STORY_SYSTEM,
        )
        data = parse_json_response(raw)
    except Exception:
        logger.exception("visual story generation failed")
        return None

    if not data.get("has_story") or not isinstance(data.get("steps"), list):
        return None

    max_citation = min(len(articles), 8)
    steps = []
    for step in data["steps"][:_MAX_STEPS]:
        if not isinstance(step, dict):
            continue
        text = str(step.get("text", "")).strip()
        if not text:
            continue
        terms = step.get("anatomy_terms") or []
        grounded = ground_terms([t for t in terms if isinstance(t, str)])
        overlay = step.get("overlay", "none")
        if overlay not in _ALLOWED_OVERLAYS:
            overlay = "highlight"
        cites = [
            c for c in (step.get("citations") or [])
            if isinstance(c, int) and 1 <= c <= max_citation
        ]
        structure_ids: list[str] = []
        for g in grounded:
            for fid in g["structure_ids"]:
                if fid not in structure_ids:
                    structure_ids.append(fid)
        steps.append({
            "title": str(step.get("title", "")).strip()[:80],
            "text": text[:600],
            "structure_ids": structure_ids,
            "matched_terms": [g["matched_name"] for g in grounded],
            "overlay": overlay if structure_ids else "none",
            "citations": cites[:4],
        })

    grounded_steps = [s for s in steps if s["structure_ids"]]
    if not grounded_steps:
        logger.info("visual story dropped: no step grounded to any structure")
        return None

    # Scene vote is per *step*, not per structure id: one tangential step that
    # grounds many scene-tagged meshes (e.g. pulmonary arteries in a calf-DVT
    # story) must not drag the whole walkthrough into the wrong deep-dive.
    # A scene wins only when it covers a strict majority of grounded steps.
    step_scenes = [scene_for_structures(s["structure_ids"]) for s in grounded_steps]
    scene = None
    counts: dict[str, int] = {}
    for sc in step_scenes:
        if sc:
            counts[sc] = counts.get(sc, 0) + 1
    if counts:
        best = max(counts, key=lambda s: counts[s])
        if counts[best] * 2 > len(grounded_steps):
            scene = best

    return {
        "title": str(data.get("title", "")).strip()[:120] or "How this works",
        "scene": scene,
        "steps": steps,
    }
