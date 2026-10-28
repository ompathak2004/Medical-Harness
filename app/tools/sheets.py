"""Fixed tiers of the when-to-call sheet.

Only the middle tier ("Call your care team today if") is model-written, through the normal
pipeline: emergency triage, evidence, draft, safety review. The emergency tier and the routine
tier are constants here. Names, phone numbers, and a person's own thresholds are never part of
a request; the browser adds them to the printed sheet.
"""
from __future__ import annotations

# Patient wording of the red flags in the triage prompt (app/prompts.py::TRIAGE_SYSTEM).
EMERGENCY_SIGNS = (
    "Chest pain or pressure, especially with sweating, pain spreading to the arm or jaw, or shortness of breath",
    "Face drooping, weakness in an arm or leg, slurred speech, or a sudden severe headache",
    "Swelling of the throat or trouble breathing after a medicine, food, or sting",
    "Bleeding that will not stop, or a serious injury",
    "Thoughts of harming yourself or ending your life",
    "Passing out, a seizure lasting more than 5 minutes, or severe trouble breathing",
    "Fever with a stiff neck and a rash",
    "Sudden, intense eye pain with a red eye, blurred vision, or nausea",
)
EMERGENCY_LINE = "Call your local emergency number now; do not wait for an online answer."
ROUTINE_LINES = (
    "Keep your follow-up appointment.",
    "Bring your medicine list to every appointment.",
    "Use the contact named on this sheet for questions that can wait.",
)


def build_when_to_call_sheet(middle_tier_source: str = "answer") -> dict:
    """The sheet envelope: fixed tiers plus a pointer to where the cited middle tier lives.

    ``middle_tier_source`` is ``"answer"`` when the reviewed, cited tier is present and
    ``"unavailable"`` when evidence could not be retrieved; the fixed tiers are returned either way.
    """
    return {
        "kind": "when_to_call",
        "emergency_signs": list(EMERGENCY_SIGNS),
        "emergency_line": EMERGENCY_LINE,
        "routine_lines": list(ROUTINE_LINES),
        "middle_tier_source": middle_tier_source,
    }
