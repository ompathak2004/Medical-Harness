from typing import Literal, get_args

VisualId = Literal[
    "eye_pressure", "asthma", "reflux", "kidney_stones", "gallstones",
    "osteoarthritis", "disc_nerve", "atherosclerosis", "radiology_report",
]
VISUAL_IDS = frozenset(get_args(VisualId))


def select_visual(value) -> VisualId | None:
    return value if isinstance(value, str) and value in VISUAL_IDS else None
