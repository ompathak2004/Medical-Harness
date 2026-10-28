"""Form-only tools: inputs are lists (readings, medicines) that a model cannot extract reliably from prose.

They return the same result shape as the calculators in clinical.py (`tool`, `key`, `source`, `scope`,
`inputs`, values; or `error` / `missing_inputs`, never a value next to an error) and run with no model
call. Danger-threshold `alerts` are fixed strings from the cited source, computed before anything else.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timedelta
from statistics import mean
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.tools.clinical import adag_line, valid_text

LOOKUP_TIMEOUT_SECONDS = 8
LOOKUP_CONCURRENCY = 4
FORM_TOOLS: dict[str, dict] = {}


def _iso_string(value):
    if not isinstance(value, str):
        raise ValueError("must be an ISO string")
    return value


IsoDate = Annotated[date, BeforeValidator(_iso_string)]


def _local_time(value: time):
    if value.tzinfo is not None:
        raise ValueError("must be a local clock time without a timezone")
    return value


IsoTime = Annotated[time, BeforeValidator(_iso_string), AfterValidator(_local_time)]
StrictInt = Annotated[int, Field(strict=True)]
StrictFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]


def _clean_text(value, max_len, allow_empty=False):
    text = valid_text(value, max_len, allow_empty)
    if text is None:
        raise ValueError("invalid text")
    return text


class FormModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- blood pressure

BP_ALERT = ("A reading above 180/120 mmHg: AHA says that if you also have chest pain, shortness of breath, back pain, "
            "numbness or weakness, a change in vision, or difficulty speaking, call emergency services. Otherwise wait five "
            "minutes, check again, and contact your clinician if it is still above 180/120.")
BP_BAND_NOTE = "2017 ACC/AHA band for discussion; home thresholds are set by your clinician."
BP_PARTIAL_NOTE = "Fewer readings than the guideline asks for; the average is less reliable."
BP_ORTHOSTATIC_NOTE = "A drop this size on standing is something to ask about."
BP_BANDS = [
    {"label": "Normal", "sbp_low": 0, "sbp_high": 119, "dbp_low": 0, "dbp_high": 79},
    {"label": "Elevated", "sbp_low": 120, "sbp_high": 129, "dbp_low": 0, "dbp_high": 79},
    {"label": "Stage 1", "sbp_low": 130, "sbp_high": 139, "dbp_low": 80, "dbp_high": 89},
    {"label": "Stage 2", "sbp_low": 140, "sbp_high": 300, "dbp_low": 90, "dbp_high": 200},
]
BP_MIN_READINGS, BP_MIN_DAYS, BP_WINDOW_DAYS = 12, 3, 7
ORTHOSTATIC_MINUTES, ORTHOSTATIC_SBP, ORTHOSTATIC_DBP = 5, 20, 10


class BpReading(FormModel):
    date: IsoDate
    time: IsoTime
    systolic: Annotated[StrictInt, Field(ge=50, le=300)]
    diastolic: Annotated[StrictInt, Field(ge=30, le=200)]
    pulse: Annotated[StrictInt, Field(ge=20, le=250)] | None = None
    position: Literal["sitting", "standing", "lying"]

    @model_validator(mode="after")
    def systolic_above_diastolic(self):
        if self.systolic <= self.diastolic:
            raise ValueError("systolic must be above diastolic")
        return self


class BpLogInputs(FormModel):
    readings: Annotated[list[BpReading], Field(min_length=1, max_length=120)]
    window_end: IsoDate | None = None


def _session(moment: time) -> str:
    minutes = moment.hour * 60 + moment.minute
    return "morning" if 4 * 60 <= minutes < 12 * 60 else "evening" if 16 * 60 <= minutes < 24 * 60 else "other"


def _average(readings):
    if not readings:
        return None
    return {"systolic": round(mean(r.systolic for r in readings), 1), "diastolic": round(mean(r.diastolic for r in readings), 1),
            "count": len(readings)}


def _bp_band(systolic, diastolic):
    if systolic >= 140 or diastolic >= 90:
        index = 3
    elif systolic >= 130 or diastolic >= 80:
        index = 2
    elif systolic >= 120:
        index = 1
    else:
        index = 0
    return {"label": BP_BANDS[index]["label"], "note": BP_BAND_NOTE}


def _orthostatic(readings):
    drops = []
    for stand in (r for r in readings if r.position == "standing"):
        stand_at = datetime.combine(stand.date, stand.time)
        earlier = [r for r in readings if r.position != "standing"
                   and timedelta(0) <= stand_at - datetime.combine(r.date, r.time) <= timedelta(minutes=ORTHOSTATIC_MINUTES)]
        if not earlier:
            continue
        ref = max(earlier, key=lambda r: datetime.combine(r.date, r.time))
        sbp_drop, dbp_drop = ref.systolic - stand.systolic, ref.diastolic - stand.diastolic
        if sbp_drop >= ORTHOSTATIC_SBP or dbp_drop >= ORTHOSTATIC_DBP:
            drops.append({"date": stand.date.isoformat(), "time": stand.time.isoformat(timespec="minutes"),
                          "sbp_drop": sbp_drop, "dbp_drop": dbp_drop})
    return drops


def run_bp_log_summary(model: BpLogInputs):
    readings = sorted(model.readings, key=lambda r: (r.date, r.time))
    alerts = [{"level": "emergency", "text": BP_ALERT}] if any(r.systolic > 180 or r.diastolic > 120 for r in readings) else []
    end = model.window_end or readings[-1].date
    start = end - timedelta(days=BP_WINDOW_DAYS - 1)
    window = [r for r in readings if start <= r.date <= end]
    seated = [r for r in window if r.position == "sitting"]
    if not seated:
        return {"error": f"Add at least one seated reading from {start.isoformat()} to {end.isoformat()}; no average was computed.",
                **({"alerts": alerts} if alerts else {})}
    morning = [r for r in seated if _session(r.time) == "morning"]
    evening = [r for r in seated if _session(r.time) == "evening"]
    overall = _average(seated)
    days = len({r.date for r in seated})
    partial = len(seated) < BP_MIN_READINGS or days < BP_MIN_DAYS
    result = {
        "alerts": alerts,
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "averages": {"morning": _average(morning), "evening": _average(evening), "all": overall},
        "reading_count": len(seated), "days_covered": days,
        "excluded_non_seated": len(window) - len(seated), "outside_window": len(readings) - len(window),
        "coverage": "partial" if partial else "complete", "coverage_note": BP_PARTIAL_NOTE if partial else "",
        "band": _bp_band(overall["systolic"], overall["diastolic"]), "bands": BP_BANDS,
        "orthostatic_drops": _orthostatic(window), "orthostatic_note": "",
        "series": [{"date": r.date.isoformat(), "time": r.time.isoformat(timespec="minutes"), "systolic": r.systolic,
                    "diastolic": r.diastolic, "pulse": r.pulse, "position": r.position, "session": _session(r.time)}
                   for r in window],
        "summary": f"{BP_WINDOW_DAYS}-day average {overall['systolic']:.0f}/{overall['diastolic']:.0f} from {len(seated)} readings",
    }
    if result["orthostatic_drops"]:
        result["orthostatic_note"] = BP_ORTHOSTATIC_NOTE
    return result


# ---------------------------------------------------------------- glucose

MG_DL_PER_MMOL_L = 18.016
GLUCOSE_SLOTS = ("fasting", "before_meal", "after_meal", "bedtime", "other")
GLUCOSE_ALERT_LEVEL_2 = "A reading below 54 mg/dL (3.0 mmol/L) is level 2 hypoglycaemia in the ADA Standards of Care; treat it now according to your own plan and tell your care team."
GLUCOSE_ALERT_LEVEL_1 = "A reading below 70 mg/dL (3.9 mmol/L) is level 1 hypoglycaemia in the ADA Standards of Care; treat it according to your own plan and tell your care team."
GLUCOSE_ALERT_HIGH = "A reading above 250 mg/dL (13.9 mmol/L) is high; follow your own plan and contact your care team if it persists or you feel unwell."
GLUCOSE_TARGET_NOTE = "ADA general goals; your own targets may differ."
GLUCOSE_PATTERN_NOTE = "Patterns across days matter more than one reading."
GLUCOSE_ADAG_NOTE = "A finger-stick average and eAG measure different things; readings cannot predict A1c."
GLUCOSE_RANGE = {"mg/dL": (10, 1000), "mmol/L": (0.6, 55.5)}
GLUCOSE_TARGETS = {"fasting": (80, 130), "before_meal": (80, 130), "after_meal": (None, 180)}


class GlucoseReading(FormModel):
    date: IsoDate
    time: IsoTime
    value: StrictFloat | StrictInt
    units: Literal["mg/dL", "mmol/L"]
    tag: Literal[GLUCOSE_SLOTS]

    @model_validator(mode="after")
    def value_matches_units(self):
        low, high = GLUCOSE_RANGE[self.units]
        if isinstance(self.value, bool) or not low <= self.value <= high:
            raise ValueError("value is outside the range for its units")
        return self


class GlucoseLogInputs(FormModel):
    readings: Annotated[list[GlucoseReading], Field(min_length=1, max_length=200)]
    a1c_percent: Annotated[StrictFloat | StrictInt, Field(ge=4, le=12)] | None = None


def _mg_dl(reading):
    return reading.value * MG_DL_PER_MMOL_L if reading.units == "mmol/L" else float(reading.value)


def _in_target(slot, value):
    if slot not in GLUCOSE_TARGETS:
        return None
    low, high = GLUCOSE_TARGETS[slot]
    return (low is None or value >= low) and (value <= high if slot != "after_meal" else value < high)


def glucose_alerts(mg_dl_values):
    """Fixed glucose alerts for a set of readings in mg/dL; shared by the normal and the raw path."""
    alerts = []
    if any(v < 54 for v in mg_dl_values):
        alerts.append({"level": "emergency", "text": GLUCOSE_ALERT_LEVEL_2})
    if any(54 <= v < 70 for v in mg_dl_values):
        alerts.append({"level": "call_today", "text": GLUCOSE_ALERT_LEVEL_1})
    if any(v > 250 for v in mg_dl_values):
        alerts.append({"level": "call_today", "text": GLUCOSE_ALERT_HIGH})
    return alerts


def run_glucose_log_pattern(model: GlucoseLogInputs):
    readings = sorted(model.readings, key=lambda r: (r.date, r.time))
    values = [(r, _mg_dl(r)) for r in readings]
    alerts = glucose_alerts([v for _, v in values])
    grid = []
    for slot in GLUCOSE_SLOTS:
        slot_values = [v for r, v in values if r.tag == slot]
        checks = [_in_target(slot, v) for v in slot_values]
        grid.append({
            "slot": slot, "count": len(slot_values),
            "mean": round(mean(slot_values), 1) if slot_values else None,
            "min": round(min(slot_values), 1) if slot_values else None,
            "max": round(max(slot_values), 1) if slot_values else None,
            "in_target_fraction": round(sum(checks) / len(checks), 2) if slot_values and checks[0] is not None else None,
        })
    overall = mean(v for _, v in values)
    result = {
        "alerts": alerts, "grid": grid,
        "target_bands": [
            {"slot": slot, "low_mg_dl": low, "high_mg_dl": high,
             "low_mmol_l": None if low is None else round(low / MG_DL_PER_MMOL_L, 1), "high_mmol_l": round(high / MG_DL_PER_MMOL_L, 1)}
            for slot, (low, high) in GLUCOSE_TARGETS.items()],
        "target_note": GLUCOSE_TARGET_NOTE,
        "points": [{"date": r.date.isoformat(), "time": r.time.isoformat(timespec="minutes"), "value_mg_dl": round(v, 1),
                    "value_mmol_l": round(v / MG_DL_PER_MMOL_L, 1), "tag": r.tag} for r, v in values],
        "pattern_note": GLUCOSE_PATTERN_NOTE,
        "reading_count": len(values),
        "summary": f"{len(values)} readings; mean {overall:.0f} mg/dL ({overall / MG_DL_PER_MMOL_L:.1f} mmol/L)",
    }
    if model.a1c_percent is not None:
        a1c = model.a1c_percent
        result["adag"] = {"eag_mg_dl": round(28.7 * a1c - 46.7, 1), "eag_mmol_l": round(1.59 * a1c - 2.59, 1),
                          "line": adag_line(), "mean_of_readings_mg_dl": round(overall, 1), "note": GLUCOSE_ADAG_NOTE}
    return result


# ---------------------------------------------------------------- medication schedule

SLOT_NAMES = ("morning", "noon", "evening", "bedtime")
DIRECTION_SLOTS = {
    "once_daily_morning": ("morning",), "once_daily_evening": ("evening",), "once_daily_bedtime": ("bedtime",),
    "twice_daily": ("morning", "evening"), "three_times_daily": ("morning", "noon", "evening"),
    "four_times_daily": ("morning", "noon", "evening", "bedtime"),
    "every_morning_and_bedtime": ("morning", "bedtime"), "with_meals": ("morning", "noon", "evening"),
    "weekly": (), "as_needed": (), "other": (),
}
SLOT_WORDS = {"morning": "in the morning", "noon": "at noon", "evening": "in the evening", "bedtime": "at bedtime"}
UMS_NOTE = ("The schedule is a wording aid using the AHRQ Universal Medication Schedule time periods (morning, noon, evening, bedtime). "
            "Confirm the times with the pharmacist, and keep the label's spacing for medicines that need exact intervals.")
DUPLICATES_NOTE = ("These entries contain the same active ingredient. Ask the pharmacist whether both are meant to be taken. "
                   "This is not an interaction check.")
NOT_INTERACTION_CHECK = "This sheet does not check interactions between medicines or doses."
OTHER_WORDING = "{text} (ask the pharmacist to place this on the grid)"
LIMITATION_NOT_NORMALISED = "{name}: not matched to an active ingredient, so only the typed name was compared."


class MedicineEntry(FormModel):
    name: str
    strength: str = ""
    directions: Literal[tuple(DIRECTION_SLOTS)]
    directions_text: str = ""

    @field_validator("name")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, 60)

    @field_validator("strength")
    @classmethod
    def _strength(cls, value):
        return _clean_text(value, 30, allow_empty=True)

    @field_validator("directions_text")
    @classmethod
    def _directions_text(cls, value):
        return _clean_text(value, 80, allow_empty=True)

    @model_validator(mode="after")
    def other_needs_text(self):
        if self.directions == "other" and not self.directions_text:
            raise ValueError("directions_text is required for other")
        return self


class ScheduleInputs(FormModel):
    medicines: Annotated[list[MedicineEntry], Field(min_length=1, max_length=12)]


def _wording(entry: MedicineEntry, slots) -> str:
    label = f"{entry.name} {entry.strength}".strip()
    if entry.directions == "weekly":
        return f"Take {label} once a week, on the day shown on the label."
    if entry.directions == "as_needed":
        return f"Take {label} only when needed, as the label directs."
    if entry.directions == "other":
        return OTHER_WORDING.format(text=entry.directions_text)
    times = [SLOT_WORDS[slot] for slot in slots]
    joined = times[0] if len(times) == 1 else ", ".join(times[:-1]) + (", and " if len(times) > 2 else " and ") + times[-1]
    prefix = "with meals: " if entry.directions == "with_meals" else ""
    return f"Take {label} {prefix}{joined}."


def _normalisation(response) -> dict:
    """Map an rxnorm_ingredients result to the per-medicine normalisation; anything odd is `unavailable`."""
    unavailable = {"status": "unavailable", "matched_name": None, "rxcui": None, "ingredients": []}
    if not isinstance(response, dict) or response.get("status") not in ("available", "empty"):
        return unavailable
    items = response.get("items")
    ingredients = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and item.get("tty") == "IN" and isinstance(item.get("title"), str) and item.get("rxcui"):
            ingredients.append({"name": item["title"], "rxcui": str(item["rxcui"])})
    if response["status"] == "empty" or not ingredients:
        return {"status": "unmatched", "matched_name": None, "rxcui": None, "ingredients": []}
    rxcui = response.get("rxcui")
    return {"status": "matched", "matched_name": " / ".join(i["name"] for i in ingredients),
            "rxcui": str(rxcui) if rxcui else None, "ingredients": ingredients}


async def _lookup_all(names, references):
    results: list[dict | None] = [None] * len(names)
    semaphore = asyncio.Semaphore(LOOKUP_CONCURRENCY)

    async def one(index, name):
        async with semaphore:
            try:
                results[index] = _normalisation(await references.run("rxnorm_ingredients", {"query": name}))
            except Exception:  # unknown key, transport failure, anything else: that medicine is un-normalised
                results[index] = _normalisation(None)

    tasks = [asyncio.create_task(one(index, name)) for index, name in enumerate(names)]
    try:
        await asyncio.wait(tasks, timeout=LOOKUP_TIMEOUT_SECONDS)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return [result or _normalisation(None) for result in results]


def _duplicates(entries, normalisations):
    groups: dict[tuple, dict] = {}
    for index, (entry, norm) in enumerate(zip(entries, normalisations)):
        for ingredient in norm["ingredients"]:
            groups.setdefault(("rxcui", ingredient["rxcui"]), {"ingredient": ingredient["name"], "members": set()})["members"].add(index)
        groups.setdefault(("name", entry.name.casefold()), {"ingredient": entry.name, "members": set()})["members"].add(index)
    found, seen = [], []
    for key in sorted(groups, key=lambda k: k[0] != "rxcui"):  # ingredient groups first, then typed-name groups
        members = groups[key]["members"]
        if len(members) < 2 or any(members <= other for other in seen):
            continue
        seen.append(members)
        found.append({"ingredient": groups[key]["ingredient"], "medicines": [entries[i].name for i in sorted(members)]})
    return found


async def run_medication_schedule(model: ScheduleInputs, references):
    entries = model.medicines
    normalisations = await _lookup_all([e.name for e in entries], references)
    grid = []
    for entry, norm in zip(entries, normalisations):
        slots = DIRECTION_SLOTS[entry.directions]
        grid.append({
            "name": entry.name, "strength": entry.strength,
            "ingredients": [i["name"] for i in norm["ingredients"]],
            "slots": {slot: slot in slots for slot in SLOT_NAMES},
            "wording": _wording(entry, slots), "placed": bool(slots), "normalisation": norm,
        })
    failed = sum(n["status"] == "unavailable" for n in normalisations)
    status = "available" if not failed else "unavailable" if failed == len(normalisations) else "partial"
    duplicates = _duplicates(entries, normalisations)
    limitations = [NOT_INTERACTION_CHECK] + [
        LIMITATION_NOT_NORMALISED.format(name=e.name) for e, n in zip(entries, normalisations) if n["status"] != "matched"]
    placed = sum(row["placed"] for row in grid)
    return {
        "status": status, "grid": grid, "ums_note": UMS_NOTE,
        "duplicates": duplicates, "duplicates_note": DUPLICATES_NOTE if duplicates else "",
        "limitations": limitations,
        "summary": f"{len(grid)} medicines; {placed} placed on the grid; {len(duplicates)} shared active ingredient(s) flagged",
    }


# ---------------------------------------------------------------- registry and runner

def _valid_rows(inputs, model):
    """Rows of `inputs["readings"]` that validate on their own; used when the whole form does not."""
    rows = inputs.get("readings") if isinstance(inputs, dict) else None
    if not isinstance(rows, list):
        return []
    valid = []
    for row in rows[:200]:
        try:
            valid.append(model.model_validate(row))
        except ValidationError:
            continue
    return valid


def bp_raw_alerts(inputs):
    readings = _valid_rows(inputs, BpReading)
    return [{"level": "emergency", "text": BP_ALERT}] if any(r.systolic > 180 or r.diastolic > 120 for r in readings) else []


def glucose_raw_alerts(inputs):
    return glucose_alerts([_mg_dl(r) for r in _valid_rows(inputs, GlucoseReading)])


def _register(key, name, description, model, source, scope, runner, needs_references=False, raw_alerts=None):
    """`raw_alerts(inputs)` extracts fixed alerts from independently valid readings so an invalid
    companion row or an unrelated field never hides an emergency line; no averages are computed."""
    FORM_TOOLS[key] = {"name": name, "description": description, "model": model, "variables": list(model.model_fields),
                       "source": source, "scope": scope, "runner": runner, "needs_references": needs_references,
                       "raw_alerts": raw_alerts}


_register(
    "bp_log_summary", "Home blood-pressure log",
    "Seven-day morning and evening averages from home blood-pressure readings, with the 2017 ACC/AHA bands drawn for discussion and a standing-drop flag.",
    BpLogInputs, "https://doi.org/10.1161/HYP.0000000000000065",
    "Adults. Averages use seated readings in the 7 days ending on window_end. The 2017 ACC/AHA band is shown for discussion; it is not a diagnosis or a target.",
    run_bp_log_summary, raw_alerts=bp_raw_alerts)
_register(
    "glucose_log_pattern", "Glucose log pattern",
    "Time-of-day pattern of blood-glucose readings against the ADA general goals, with an optional A1c on the ADAG line.",
    GlucoseLogInputs, "https://doi.org/10.2337/dc26-S006",
    "Non-pregnant adults. ADA general goals are drawn for discussion; your own targets may differ. Not insulin or dose advice.",
    run_glucose_log_pattern, raw_alerts=glucose_raw_alerts)
_register(
    "medication_schedule", "Medication schedule sheet",
    "Printable morning, noon, evening, and bedtime grid for a medicine list, flagging entries that share an active ingredient.",
    ScheduleInputs, "https://www.ahrq.gov/health-literacy/improve/precautions/tool16.html",
    "A wording aid using the AHRQ Universal Medication Schedule periods. Not an interaction check, not dosing advice; confirm with the pharmacist.",
    run_medication_schedule, needs_references=True)


def _error(info, key, message, **extra):
    return {"tool": info["name"], "key": key, "source": info["source"], "scope": info["scope"], "error": message, **extra}


def _first_field(path):
    parts = []
    for part in path:
        parts.append(f"[{part}]" if isinstance(part, int) else (f".{part}" if parts else str(part)))
    return "".join(parts) or "inputs"


async def run_form_tool(key: str, inputs: Any, references=None) -> dict:
    """Validate `inputs` against the tool's model and run it. Never raises for bad input."""
    info = FORM_TOOLS[key]
    if not isinstance(inputs, dict):
        return _error(info, key, "Inputs must be an object.")
    try:
        model = info["model"].model_validate(inputs)
    except ValidationError as exc:
        errors = exc.errors(include_url=False)
        alerts = info["raw_alerts"](inputs) if info["raw_alerts"] else []
        extra = {"alerts": alerts} if alerts else {}
        missing = [e["loc"][0] for e in errors if e["type"] == "missing" and len(e["loc"]) == 1]
        if missing:
            return _error(info, key, "Required inputs were not supplied.", missing_inputs=sorted(set(missing), key=missing.index), **extra)
        return _error(info, key, f"Invalid or out-of-range input: {_first_field(errors[0]['loc'])}.", **extra)
    output = await info["runner"](model, references) if info["needs_references"] else info["runner"](model)
    if "error" in output:
        return _error(info, key, output["error"], **{k: v for k, v in output.items() if k != "error"})
    return {"tool": info["name"], "key": key, "source": info["source"], "scope": info["scope"],
            "inputs": model.model_dump(mode="json", exclude_none=True),
            **output}

