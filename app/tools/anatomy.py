"""
Anatomy tool — detects anatomical body regions from conversation context
and returns structured data for the interactive body map visualization.

The LLM analyzes the conversation to identify which body region is being
discussed, then returns the region ID and relevant sub-parts so the
frontend can highlight the correct area on the body map.
"""

import logging

from app.json_utils import parse_json_response

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Body region definitions
# Each region maps to:
#   - label: human-readable name
#   - sub_parts: list of specific anatomical structures in that region
#   - svg_id: the ID used in the SVG body map element
# ---------------------------------------------------------------------------

ANATOMY_REGIONS = {
    "head": {
        "label": "Head",
        "sub_parts": [
            "forehead", "temple", "crown", "occiput (back of head)",
            "jaw", "ear", "eye area", "sinus area", "scalp",
        ],
        "svg_id": "region-head",
    },
    "neck": {
        "label": "Neck",
        "sub_parts": [
            "front of neck (anterior)", "back of neck (posterior)",
            "side of neck (lateral)", "base of skull", "throat",
        ],
        "svg_id": "region-neck",
    },
    "left_shoulder": {
        "label": "Left Shoulder",
        "sub_parts": [
            "deltoid", "rotator cuff area", "trapezius",
            "acromioclavicular joint", "shoulder blade (scapula)",
        ],
        "svg_id": "region-left-shoulder",
    },
    "right_shoulder": {
        "label": "Right Shoulder",
        "sub_parts": [
            "deltoid", "rotator cuff area", "trapezius",
            "acromioclavicular joint", "shoulder blade (scapula)",
        ],
        "svg_id": "region-right-shoulder",
    },
    "chest": {
        "label": "Chest",
        "sub_parts": [
            "upper chest (pectorals)", "sternum (breastbone)",
            "ribcage", "left chest", "right chest", "center chest",
        ],
        "svg_id": "region-chest",
    },
    "abdomen": {
        "label": "Abdomen",
        "sub_parts": [
            "upper abdomen (epigastric)", "lower abdomen (hypogastric)",
            "right upper quadrant", "left upper quadrant",
            "right lower quadrant", "left lower quadrant",
            "navel area (umbilical)", "flanks",
        ],
        "svg_id": "region-abdomen",
    },
    "upper_back": {
        "label": "Upper Back",
        "sub_parts": [
            "between shoulder blades (interscapular)",
            "thoracic spine", "trapezius", "rhomboids", "latissimus dorsi",
        ],
        "svg_id": "region-upper-back",
    },
    "lower_back": {
        "label": "Lower Back",
        "sub_parts": [
            "lumbar spine", "sacrum", "SI joint area",
            "paraspinal muscles", "kidney area",
        ],
        "svg_id": "region-lower-back",
    },
    "left_upper_arm": {
        "label": "Left Upper Arm",
        "sub_parts": [
            "biceps", "triceps", "inner arm", "outer arm",
        ],
        "svg_id": "region-left-upper-arm",
    },
    "right_upper_arm": {
        "label": "Right Upper Arm",
        "sub_parts": [
            "biceps", "triceps", "inner arm", "outer arm",
        ],
        "svg_id": "region-right-upper-arm",
    },
    "left_elbow": {
        "label": "Left Elbow",
        "sub_parts": [
            "inner elbow", "outer elbow (lateral epicondyle)",
            "olecranon (bony tip)", "elbow crease",
        ],
        "svg_id": "region-left-elbow",
    },
    "right_elbow": {
        "label": "Right Elbow",
        "sub_parts": [
            "inner elbow", "outer elbow (lateral epicondyle)",
            "olecranon (bony tip)", "elbow crease",
        ],
        "svg_id": "region-right-elbow",
    },
    "left_forearm": {
        "label": "Left Forearm",
        "sub_parts": [
            "inner forearm", "outer forearm", "wrist", "near elbow",
        ],
        "svg_id": "region-left-forearm",
    },
    "right_forearm": {
        "label": "Right Forearm",
        "sub_parts": [
            "inner forearm", "outer forearm", "wrist", "near elbow",
        ],
        "svg_id": "region-right-forearm",
    },
    "left_hand": {
        "label": "Left Hand",
        "sub_parts": [
            "palm", "back of hand", "fingers", "thumb",
            "wrist", "knuckles",
        ],
        "svg_id": "region-left-hand",
    },
    "right_hand": {
        "label": "Right Hand",
        "sub_parts": [
            "palm", "back of hand", "fingers", "thumb",
            "wrist", "knuckles",
        ],
        "svg_id": "region-right-hand",
    },
    "hip": {
        "label": "Hip / Pelvis",
        "sub_parts": [
            "hip joint", "groin", "outer hip",
            "buttock (gluteal)", "pelvic floor",
        ],
        "svg_id": "region-hip",
    },
    "left_thigh": {
        "label": "Left Thigh",
        "sub_parts": [
            "quadriceps (front)", "hamstrings (back)",
            "inner thigh (adductors)", "outer thigh (IT band)",
        ],
        "svg_id": "region-left-thigh",
    },
    "right_thigh": {
        "label": "Right Thigh",
        "sub_parts": [
            "quadriceps (front)", "hamstrings (back)",
            "inner thigh (adductors)", "outer thigh (IT band)",
        ],
        "svg_id": "region-right-thigh",
    },
    "left_knee": {
        "label": "Left Knee",
        "sub_parts": [
            "kneecap (patella)", "inner knee (medial)",
            "outer knee (lateral)", "back of knee (popliteal)",
        ],
        "svg_id": "region-left-knee",
    },
    "right_knee": {
        "label": "Right Knee",
        "sub_parts": [
            "kneecap (patella)", "inner knee (medial)",
            "outer knee (lateral)", "back of knee (popliteal)",
        ],
        "svg_id": "region-right-knee",
    },
    "left_lower_leg": {
        "label": "Left Lower Leg (Calf)",
        "sub_parts": [
            "calf muscle (gastrocnemius)", "soleus",
            "shin (tibialis anterior)", "Achilles tendon",
            "peroneal muscles (outer)", "inner calf",
        ],
        "svg_id": "region-left-lower-leg",
    },
    "right_lower_leg": {
        "label": "Right Lower Leg (Calf)",
        "sub_parts": [
            "calf muscle (gastrocnemius)", "soleus",
            "shin (tibialis anterior)", "Achilles tendon",
            "peroneal muscles (outer)", "inner calf",
        ],
        "svg_id": "region-right-lower-leg",
    },
    "left_ankle": {
        "label": "Left Ankle",
        "sub_parts": [
            "inner ankle (medial malleolus)", "outer ankle (lateral malleolus)",
            "front of ankle", "Achilles tendon area",
        ],
        "svg_id": "region-left-ankle",
    },
    "right_ankle": {
        "label": "Right Ankle",
        "sub_parts": [
            "inner ankle (medial malleolus)", "outer ankle (lateral malleolus)",
            "front of ankle", "Achilles tendon area",
        ],
        "svg_id": "region-right-ankle",
    },
    "left_foot": {
        "label": "Left Foot",
        "sub_parts": [
            "sole (plantar)", "top of foot (dorsal)", "heel",
            "arch", "ball of foot", "toes",
        ],
        "svg_id": "region-left-foot",
    },
    "right_foot": {
        "label": "Right Foot",
        "sub_parts": [
            "sole (plantar)", "top of foot (dorsal)", "heel",
            "arch", "ball of foot", "toes",
        ],
        "svg_id": "region-right-foot",
    },
}


# ---------------------------------------------------------------------------
# Prompt for anatomy detection
# ---------------------------------------------------------------------------

ANATOMY_DETECT_PROMPT = """You are an anatomy detection assistant. Analyze the patient conversation below and determine if a specific body region is being discussed.

Available body regions (use these exact keys):
{region_list}

Conversation:
{conversation}

Respond with EXACTLY one JSON object (no markdown fences, no extra text):
{{
  "has_anatomy": true or false,
  "regions": ["region_key1", "region_key2"] or [],
  "primary_region": "the most relevant region_key" or null,
  "reasoning": "brief explanation",
  "location_question": "a specific question about the exact location within the identified body region, helping narrow down the problem" or null
}}

Rules:
- Set has_anatomy to true ONLY if the patient mentions a specific body part, pain location, or physical symptom tied to an anatomical area.
- Select 1-3 relevant regions maximum.
- The primary_region should be the single most relevant region.
- If the patient says "calf" without specifying left or right, prefer the right side but include both.
- For general questions (like "what is diabetes?"), set has_anatomy to false.
- The location_question should help pinpoint the EXACT spot within the body region (e.g., "Is the pain in the inner or outer part of your calf?")."""


async def detect_anatomy_context(conv_text: str, llm_client) -> dict | None:
    """
    Analyze conversation to detect if an anatomical body region is being discussed.

    Args:
        conv_text: Formatted conversation text.
        llm_client: LLM client with an async ``generate(prompt) -> str`` method.

    Returns:
        dict with anatomy context, or None if no anatomy detected.
        {
            "has_anatomy": True,
            "regions": [{"id": "...", "label": "...", "sub_parts": [...], "svg_id": "..."}],
            "primary_region": {"id": "...", "label": "...", "sub_parts": [...], "svg_id": "..."},
            "location_question": "..."
        }
    """
    # Build the region list for the prompt
    region_lines = []
    for key, info in ANATOMY_REGIONS.items():
        region_lines.append(f"  - {key}: {info['label']}")
    region_list_text = "\n".join(region_lines)

    prompt = ANATOMY_DETECT_PROMPT.format(
        region_list=region_list_text,
        conversation=conv_text,
    )

    try:
        raw = await llm_client.generate(prompt)
        result = parse_json_response(raw)

        if not result.get("has_anatomy"):
            logger.info("No anatomy context detected")
            return None

        # Build rich region objects
        regions = []
        for region_key in result.get("regions", []):
            if region_key in ANATOMY_REGIONS:
                region_info = ANATOMY_REGIONS[region_key]
                regions.append({
                    "id": region_key,
                    "label": region_info["label"],
                    "sub_parts": region_info["sub_parts"],
                    "svg_id": region_info["svg_id"],
                })

        primary = None
        primary_key = result.get("primary_region")
        if primary_key and primary_key in ANATOMY_REGIONS:
            pinfo = ANATOMY_REGIONS[primary_key]
            primary = {
                "id": primary_key,
                "label": pinfo["label"],
                "sub_parts": pinfo["sub_parts"],
                "svg_id": pinfo["svg_id"],
            }

        anatomy_context = {
            "has_anatomy": True,
            "regions": regions,
            "primary_region": primary,
            "location_question": result.get("location_question"),
        }
        logger.info(
            "Anatomy context detected: primary=%s regions=%d",
            result.get("primary_region"),
            len(regions),
        )
        return anatomy_context

    except Exception:
        logger.exception("Anatomy detection failed")
        return None
