"""Growth percentiles from the bundled WHO 2006 (0-24 months) and CDC 2000 (2-20 years) LMS tables.

The tables are public CDC-hosted files, bundled as one JSON file by scripts/build_growth_tables.py and
verified here against `growth_lms.manifest.json` (SHA-256, byte size, row counts) before any use. If the
file is missing, over budget, or fails a check, both tools return an error and never a number.
"""
from __future__ import annotations

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

from app.tools.clinical import calculator

DATA_DIR = Path(__file__).parent / "data"
TABLES_PATH = DATA_DIR / "growth_lms.json"
MANIFEST_PATH = DATA_DIR / "growth_lms.manifest.json"
MAX_TABLE_BYTES = 128 * 1024
UNAVAILABLE = "Growth reference tables are unavailable; no percentile was computed."

WHO_SOURCE = "https://www.cdc.gov/growthcharts/who-data-files.htm"
CDC_SOURCE = "https://www.cdc.gov/growthcharts/cdc-data-files.htm"
CDC_START_MONTHS = 24
CURVE_Z = {"p3": -1.8807936, "p15": -1.0364334, "p50": 0.0, "p85": 1.0364334, "p97": 1.8807936}
Z_5, Z_95 = -1.6448536, 1.6448536
FLAG_TEXT = "Outside the reference cut-offs; discuss with the clinician."
BMI_LINE = ("CDC describes the 5th, 85th and 95th percentiles as its reference cut-offs; what they mean "
            "for this child is a conversation with the clinician.")
MEASURES = {  # measure: (WHO indicator, CDC indicator, units, low, high, noun, verb phrase)
    "weight": ("weight_for_age", "weight_for_age", "kg", 0.5, 150, "Weight", "weigh less"),
    "length_or_height": ("length_for_age", "stature_for_age", "cm", 30, 220, "Length or height", "are shorter"),
    "head_circumference": ("head_circumference_for_age", None, "cm", 20, 65, "Head circumference", "have a smaller head"),
}


class GrowthTablesError(RuntimeError):
    """The bundled growth tables are missing or failed an integrity check."""


@lru_cache(maxsize=1)
def load_tables() -> dict:
    """Load the LMS tables once, after verifying size, SHA-256, and row counts against the manifest."""
    try:
        manifest = json.loads(MANIFEST_PATH.read_text())
        raw = TABLES_PATH.read_bytes()
        if len(raw) > MAX_TABLE_BYTES or len(raw) != manifest["bytes"]:
            raise GrowthTablesError("size")
        if hashlib.sha256(raw).hexdigest() != manifest["sha256"]:
            raise GrowthTablesError("hash")
        tables = json.loads(raw)
        counts = {system: {indicator: {sex: len(rows) for sex, rows in by_sex.items()}
                           for indicator, by_sex in tables[system].items()} for system in ("who", "cdc")}
        if counts != manifest["row_counts"]:
            raise GrowthTablesError("row counts")
    except GrowthTablesError:
        raise
    except Exception as exc:
        raise GrowthTablesError("unreadable") from exc
    return tables


def lms_at(rows, age):
    """Linearly interpolate (L, M, S) between the two table rows that bracket `age` months."""
    if not rows[0][0] <= age <= rows[-1][0]:
        raise ValueError("Age is outside the bundled growth tables.")
    upper = next(index for index, row in enumerate(rows) if row[0] >= age)
    if rows[upper][0] == age:
        return tuple(rows[upper][1:])
    (a0, *lms0), (a1, *lms1) = rows[upper - 1], rows[upper]
    weight = (age - a0) / (a1 - a0)
    return tuple(v0 + weight * (v1 - v0) for v0, v1 in zip(lms0, lms1))


def z_from_lms(x, lms):
    lam, m, s = lms
    return math.log(x / m) / s if lam == 0 else ((x / m) ** lam - 1) / (lam * s)


def x_from_z(z, lms):
    lam, m, s = lms
    return m * math.exp(s * z) if lam == 0 else m * (1 + lam * s * z) ** (1 / lam)


def percentile_from_z(z):
    return 100 * 0.5 * (1 + math.erf(z / math.sqrt(2)))


def who_modified_z(x, lms):
    """WHO z-score and its method: the adjustment for values beyond +/-3 SD, else the plain LMS z."""
    z = z_from_lms(x, lms)
    if z > 3:
        sd2, sd3 = x_from_z(2, lms), x_from_z(3, lms)
        return 3 + (x - sd3) / (sd3 - sd2), "who_modified"
    if z < -3:
        sd2, sd3 = x_from_z(-2, lms), x_from_z(-3, lms)
        return -3 + (x - sd3) / (sd2 - sd3), "who_modified"
    return z, "who_lms"


def curve_points(rows, ages):
    points = []
    for age in ages:
        lms = lms_at(rows, age)
        points.append({"age_months": age, **{name: round(x_from_z(z, lms), 2) for name, z in CURVE_Z.items()}})
    return points


def percentile_text(percentile, verb):
    if percentile < 0.1:
        return f"fewer than 1 of 1,000 children of the same age and sex {verb}"
    if percentile > 99.9:
        return f"more than 999 of 1,000 children of the same age and sex {verb}"
    shown = f"{percentile:.0f}" if 1 <= percentile <= 99 else f"{percentile:.1f}"
    return f"about {shown} of 100 children of the same age and sex {verb}"


def _result(table, sex, age, x, *, who, units, noun, verb, digits):
    rows = table[sex]
    lms = lms_at(rows, age)
    z, method = who_modified_z(x, lms) if who else (z_from_lms(x, lms), "cdc_lms")
    percentile = percentile_from_z(z)
    flag = (abs(z) > 2) if who else (z < Z_5 or z > Z_95)
    ages = range(0, 25) if who else range(CDC_START_MONTHS, 241)
    result = {
        "value": round(x, digits), "units": units,
        "z": round(z, 2) + 0.0, "percentile": round(percentile, 1),
        "percentile_text": percentile_text(percentile, verb),
        "reference": "WHO 2006" if who else "CDC 2000", "z_method": method,
        "flag": flag, "flag_text": FLAG_TEXT if flag else "",
        "curve": curve_points(rows, ages), "point": {"age_months": age, "value": round(x, digits)},
        "source": WHO_SOURCE if who else CDC_SOURCE,
    }
    result["summary"] = f"{noun} {result['value']:g} {units} at {age:g} months: {percentile_text(percentile, verb)} (percentile {result['percentile']:g}, {result['reference']})"
    return result, lms


@calculator(
    "growth_percentile", "Growth percentile",
    "Percentile for age and sex of one child measurement. Needs sex, age_months (0-240), measure (weight, length_or_height, head_circumference) and value in kg or cm. Not a diagnosis.",
    {"sex": {"female", "male"}, "age_months": (0, 240),
     "measure": {"weight", "length_or_height", "head_circumference"}, "value": (0.5, 220)},
    CDC_SOURCE,
    "Children 0-20 years. WHO 2006 standards under 24 months and CDC 2000 charts from 24 months (length lying down before 24 months, height standing after). A percentile shows position among reference children, not health or a diagnosis.",
)
def compute_growth_percentile(data):
    who_indicator, cdc_indicator, units, low, high, noun, verb = MEASURES[data["measure"]]
    age, value = round(data["age_months"], 2), data["value"]
    if not low <= value <= high:
        raise ValueError("Invalid or out-of-range input: value.")
    who = age < CDC_START_MONTHS
    if not who and cdc_indicator is None:
        raise ValueError("Head-circumference percentiles are bundled for 0–24 months only.")
    try:
        tables = load_tables()
    except GrowthTablesError:
        raise ValueError(UNAVAILABLE) from None
    table = tables["who" if who else "cdc"][who_indicator if who else cdc_indicator]
    result, _ = _result(table, data["sex"], age, value, who=who, units=units, noun=noun, verb=verb, digits=2)
    result["measure"] = data["measure"]
    return result


@calculator(
    "child_bmi_percentile", "Child BMI percentile",
    "BMI-for-age percentile for a child or teen aged 2-20 years. Needs sex, age_months (24-240), weight_kg and height_cm. Not a weight category or diagnosis.",
    {"sex": {"female", "male"}, "age_months": (24, 240), "weight_kg": (5, 200), "height_cm": (60, 220)},
    CDC_SOURCE,
    "Children 2-20 years, CDC 2000 BMI-for-age. A percentile shows position among reference children; it is not a weight category or a diagnosis.",
)
def compute_child_bmi_percentile(data):
    bmi = data["weight_kg"] / (data["height_cm"] / 100) ** 2
    if not 6 <= bmi <= 80:
        raise ValueError("The weight and height give an implausible BMI; check the numbers and units.")
    try:
        tables = load_tables()
    except GrowthTablesError:
        raise ValueError(UNAVAILABLE) from None
    table = tables["cdc"]["bmi_for_age"]
    age = round(data["age_months"], 2)
    result, lms = _result(table, data["sex"], age, bmi, who=False, units="kg/m²", noun="BMI", verb="have a lower BMI", digits=1)
    result["reference_lines"] = {"p5": round(x_from_z(Z_5, lms), 2), "p85": round(x_from_z(CURVE_Z["p85"], lms), 2),
                                 "p95": round(x_from_z(Z_95, lms), 2)}
    result["recommendation"] = BMI_LINE
    return result
