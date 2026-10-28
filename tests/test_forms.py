import asyncio

import pytest

from app.tools import forms
from app.tools.forms import FORM_TOOLS, run_form_tool


def run(key, inputs, references=None):
    return asyncio.run(run_form_tool(key, inputs, references))


def bp(day, time, sbp, dbp, position="sitting", pulse=None):
    return {"date": f"2026-10-{day:02d}", "time": time, "systolic": sbp, "diastolic": dbp, "position": position,
            **({"pulse": pulse} if pulse else {})}


def fourteen():
    # seven mornings at 130/80 + 2 * day offset and seven evenings at 126/78
    readings = []
    for day in range(1, 8):
        readings.append(bp(day, "07:30", 130 + day, 80))
        readings.append(bp(day, "19:30", 126, 78))
    return readings


def test_registry_describes_three_form_tools():
    assert set(FORM_TOOLS) == {"bp_log_summary", "glucose_log_pattern", "medication_schedule"}
    for info in FORM_TOOLS.values():
        assert info["name"] and info["description"] and info["variables"] and info["scope"] and info["source"].startswith("https://")


def test_bp_arithmetic_is_hand_checkable():
    result = run("bp_log_summary", {"readings": fourteen()})
    assert result["key"] == "bp_log_summary" and result["inputs"]["readings"]
    assert result["averages"]["morning"] == {"systolic": 134.0, "diastolic": 80.0, "count": 7}
    assert result["averages"]["evening"] == {"systolic": 126.0, "diastolic": 78.0, "count": 7}
    assert result["averages"]["all"] == {"systolic": 130.0, "diastolic": 79.0, "count": 14}
    assert (result["reading_count"], result["days_covered"], result["coverage"]) == (14, 7, "complete")
    assert result["band"]["label"] == "Stage 1" and result["summary"] == "7-day average 130/79 from 14 readings"
    assert result["alerts"] == [] and result["orthostatic_drops"] == [] and len(result["series"]) == 14
    assert result["series"][0]["session"] == "morning" and result["series"][1]["session"] == "evening"
    assert [b["label"] for b in result["bands"]] == ["Normal", "Elevated", "Stage 1", "Stage 2"]


def test_bp_twelve_reading_boundary():
    readings = fourteen()
    assert run("bp_log_summary", {"readings": readings[:12]})["coverage"] == "complete"
    partial = run("bp_log_summary", {"readings": readings[:11]})
    assert partial["coverage"] == "partial" and "fewer readings" in partial["coverage_note"].lower()
    assert run("bp_log_summary", {"readings": [bp(1, "07:00", 120, 70)] * 12})["coverage"] == "partial"  # one day only


def test_bp_window_ends_on_window_end_and_other_session():
    readings = fourteen() + [bp(20, "13:00", 118, 74)]
    result = run("bp_log_summary", {"readings": readings, "window_end": "2026-10-07"})
    assert result["reading_count"] == 14 and result["outside_window"] == 1
    assert run("bp_log_summary", {"readings": readings})["series"][-1]["session"] == "other"


def test_bp_emergency_reading_is_first_alert_and_listed_before_averages():
    result = run("bp_log_summary", {"readings": fourteen() + [bp(7, "21:00", 185, 95)]})
    assert result["alerts"][0]["level"] == "emergency" and "chest pain" in result["alerts"][0]["text"]
    assert list(result).index("alerts") < list(result).index("averages")
    assert run("bp_log_summary", {"readings": [bp(1, "08:00", 150, 121)]})["alerts"]
    assert not run("bp_log_summary", {"readings": [bp(1, "08:00", 180, 120)]})["alerts"]


def test_bp_standing_drop_and_five_minute_pairing():
    base = [bp(3, "08:00", 130, 80, "sitting")]
    hit = run("bp_log_summary", {"readings": base + [bp(3, "08:05", 105, 68, "standing")]})
    assert hit["orthostatic_drops"] == [{"date": "2026-10-03", "time": "08:05", "sbp_drop": 25, "dbp_drop": 12}]
    assert hit["orthostatic_note"]
    miss = run("bp_log_summary", {"readings": base + [bp(3, "08:06", 105, 68, "standing")]})
    assert miss["orthostatic_drops"] == []
    assert run("bp_log_summary", {"readings": base + [bp(3, "08:02", 111, 71, "standing")]})["orthostatic_drops"] == []
    assert run("bp_log_summary", {"readings": base + [bp(3, "08:02", 111, 70, "standing")]})["orthostatic_drops"]  # dbp drop is 10
    assert run("bp_log_summary", {"readings": base + [bp(3, "07:59", 100, 60, "standing")]})["orthostatic_drops"] == []  # standing before


@pytest.mark.parametrize("reading", [
    {"systolic": 80, "diastolic": 80}, {"systolic": 49, "diastolic": 30}, {"systolic": 301, "diastolic": 80},
    {"systolic": 120.5, "diastolic": 80}, {"systolic": True, "diastolic": 80}, {"date": "tomorrow"}, {"position": "running"},
    {"time": 730}, {"pulse": 10}])
def test_bp_invalid_reading_fails_closed(reading):
    result = run("bp_log_summary", {"readings": [{**bp(1, "07:00", 120, 80), **reading}]})
    assert result["error"].startswith("Invalid or out-of-range input: readings[0]")
    assert not {"averages", "summary", "band"}.intersection(result)


def test_bp_empty_unknown_and_non_seated_inputs():
    assert "error" in run("bp_log_summary", {"readings": []})
    assert run("bp_log_summary", {})["missing_inputs"] == ["readings"]
    assert "error" in run("bp_log_summary", {"readings": [bp(1, "07:00", 120, 80)], "extra": 1})
    assert "error" in run("bp_log_summary", "readings")
    only_standing = run("bp_log_summary", {"readings": [bp(1, "07:00", 120, 80, "standing")]})
    assert only_standing["error"] and "averages" not in only_standing


def glucose(value, tag="fasting", units="mg/dL", day=1, time="07:00"):
    return {"date": f"2026-10-{day:02d}", "time": time, "value": value, "units": units, "tag": tag}


def test_glucose_grid_alerts_and_conversion():
    readings = [glucose(100), glucose(130, day=2), glucose(131, day=3), glucose(7.0, "before_meal", "mmol/L", time="12:00"),
                glucose(179, "after_meal", time="14:00"), glucose(180, "after_meal", day=2, time="14:00")]
    result = run("glucose_log_pattern", {"readings": readings})
    grid = {row["slot"]: row for row in result["grid"]}
    assert grid["fasting"] == {"slot": "fasting", "count": 3, "mean": 120.3, "min": 100.0, "max": 131.0, "in_target_fraction": 0.67}
    assert grid["before_meal"]["mean"] == pytest.approx(126.1, abs=.05) and grid["before_meal"]["in_target_fraction"] == 1.0
    assert grid["after_meal"]["in_target_fraction"] == 0.5
    assert grid["bedtime"]["count"] == 0 and grid["bedtime"]["mean"] is None
    assert result["alerts"] == [] and result["pattern_note"] and result["key"] == "glucose_log_pattern"
    assert result["points"][0] == {"date": "2026-10-01", "time": "07:00", "value_mg_dl": 100.0, "value_mmol_l": 5.6, "tag": "fasting"}
    assert {band["slot"] for band in result["target_bands"]} == {"fasting", "before_meal", "after_meal"}
    assert "adag" not in result


def test_glucose_alert_levels_in_order():
    level_two = run("glucose_log_pattern", {"readings": [glucose(53), glucose(65, day=2), glucose(251, day=3)]})
    assert [a["level"] for a in level_two["alerts"]] == ["emergency", "call_today", "call_today"]
    assert "54" in level_two["alerts"][0]["text"] and "70" in level_two["alerts"][1]["text"] and "250" in level_two["alerts"][2]["text"]
    assert run("glucose_log_pattern", {"readings": [glucose(54)]})["alerts"][0]["level"] == "call_today"
    assert run("glucose_log_pattern", {"readings": [glucose(2.9, units="mmol/L")]})["alerts"][0]["level"] == "emergency"
    assert run("glucose_log_pattern", {"readings": [glucose(250)]})["alerts"] == []


def test_glucose_adag_with_a1c():
    result = run("glucose_log_pattern", {"readings": [glucose(150), glucose(170, day=2)], "a1c_percent": 7})
    assert result["adag"]["eag_mg_dl"] == 154.2 and result["adag"]["eag_mmol_l"] == 8.5
    assert len(result["adag"]["line"]) == 15 and result["adag"]["mean_of_readings_mg_dl"] == 160.0
    assert "cannot predict A1c" in result["adag"]["note"]


@pytest.mark.parametrize("inputs", [
    {"readings": [glucose(5, units="mg/dL")]}, {"readings": [glucose(1100)]}, {"readings": [glucose(60, units="mmol/L")]},
    {"readings": [glucose(100, tag="lunch")]}, {"readings": [glucose("100")]}, {"readings": [glucose(float("nan"))]},
    {"readings": [glucose(100)], "a1c_percent": 3}, {"readings": [glucose(100)], "a1c_percent": 13}, {"readings": []}])
def test_glucose_invalid_input_fails_closed(inputs):
    result = run("glucose_log_pattern", inputs)
    assert result["error"] and not {"grid", "points", "summary", "adag"}.intersection(result)


class FakeReferences:
    def __init__(self, table=None, boom=(), slow=()):
        self.table, self.boom, self.slow, self.calls, self.active, self.peak = table or {}, set(boom), set(slow), [], 0, 0

    async def run(self, key, variables):
        assert key == "rxnorm_ingredients"
        name = variables["query"].lower()
        self.calls.append(name)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(0)
            if name in self.slow:
                await asyncio.sleep(60)
            if name in self.boom:
                raise RuntimeError("down")
            if name not in self.table:
                return {"tool": "RxNorm ingredients", "status": "empty", "items": []}
            return {"tool": "RxNorm ingredients", "status": "available", "rxcui": "1", "combination": len(self.table[name]) > 1,
                    "items": [{"title": t, "url": "https://x", "rxcui": c, "tty": "IN"} for t, c in self.table[name]]
                    + [{"title": "combo", "url": "https://x", "rxcui": "999", "tty": "MIN"}]}
        finally:
            self.active -= 1


ACETAMINOPHEN = ("acetaminophen", "161")
TABLE = {"tylenol": [ACETAMINOPHEN], "paracetamol": [ACETAMINOPHEN], "lipitor": [("atorvastatin", "83367")],
         "nyquil": [ACETAMINOPHEN, ("dextromethorphan", "3289")]}


def med(name, directions="twice_daily", **extra):
    return {"name": name, "directions": directions, **extra}


def test_schedule_slots_and_wording():
    meds = [med(d.replace("_", " "), d) for d in forms.DIRECTION_SLOTS if d != "other"] + [med("odd", "other", directions_text="every other day")]
    result = run("medication_schedule", {"medicines": meds[:12]}, FakeReferences())
    rows = {row["name"]: row for row in result["grid"]}
    slots = lambda name: [s for s, on in rows[name.replace("_", " ")]["slots"].items() if on]  # noqa: E731
    assert slots("once_daily_morning") == ["morning"] and slots("once_daily_bedtime") == ["bedtime"]
    assert slots("twice_daily") == ["morning", "evening"] and slots("three_times_daily") == ["morning", "noon", "evening"]
    assert slots("four_times_daily") == ["morning", "noon", "evening", "bedtime"] and slots("with_meals") == ["morning", "noon", "evening"]
    assert slots("every_morning_and_bedtime") == ["morning", "bedtime"]
    assert not rows["weekly"]["placed"] and not rows["as needed"]["placed"] and slots("weekly") == []
    assert result["ums_note"] and "items" not in result and result["key"] == "medication_schedule"


def test_schedule_other_requires_text_and_shows_it_verbatim():
    assert "error" in run("medication_schedule", {"medicines": [med("x", "other")]}, FakeReferences())
    row = run("medication_schedule", {"medicines": [med("x", "other", directions_text="as directed")]}, FakeReferences())["grid"][0]
    assert "as directed" in row["wording"] and "ask the pharmacist" in row["wording"] and not row["placed"]


def test_schedule_flags_brand_and_generic_sharing_an_ingredient():
    refs = FakeReferences(TABLE)
    result = run("medication_schedule", {"medicines": [med("Tylenol", strength="500 mg"), med("paracetamol"), med("Lipitor")]}, refs)
    assert result["status"] == "available"
    assert result["duplicates"] == [{"ingredient": "acetaminophen", "medicines": ["Tylenol", "paracetamol"]}]
    assert "not an interaction check" in result["duplicates_note"]
    first = result["grid"][0]
    assert first["ingredients"] == ["acetaminophen"] and first["normalisation"]["status"] == "matched"
    assert first["normalisation"]["rxcui"] == "1" and first["normalisation"]["ingredients"] == [{"name": "acetaminophen", "rxcui": "161"}]
    assert result["grid"][2]["ingredients"] == ["atorvastatin"]


def test_schedule_combination_product_shares_ingredient_and_ignores_min_items():
    result = run("medication_schedule", {"medicines": [med("NyQuil"), med("Tylenol")]}, FakeReferences(TABLE))
    assert result["duplicates"] == [{"ingredient": "acetaminophen", "medicines": ["NyQuil", "Tylenol"]}]
    assert result["grid"][0]["ingredients"] == ["acetaminophen", "dextromethorphan"]
    assert all(i["name"] != "combo" for row in result["grid"] for i in row["normalisation"]["ingredients"])


def test_schedule_unmatched_name_is_listed_as_limitation():
    result = run("medication_schedule", {"medicines": [med("Zzzz")]}, FakeReferences(TABLE))
    assert result["status"] == "available" and result["grid"][0]["normalisation"]["status"] == "unmatched"
    assert any("Zzzz" in line for line in result["limitations"]) and result["duplicates"] == []


def test_schedule_unavailable_falls_back_to_exact_typed_names():
    refs = FakeReferences(boom={"tylenol", "tylenol "})
    result = run("medication_schedule", {"medicines": [med("Tylenol"), med("TYLENOL", "as_needed"), med("Lipitor")]}, refs)
    assert result["status"] == "partial"
    assert result["grid"][0]["normalisation"]["status"] == "unavailable" and result["grid"][2]["normalisation"]["status"] == "unmatched"
    assert result["duplicates"] == [{"ingredient": "Tylenol", "medicines": ["Tylenol", "TYLENOL"]}]
    assert all(row["wording"] for row in result["grid"])


def test_schedule_all_lookups_failing_is_unavailable_but_grid_renders():
    result = run("medication_schedule", {"medicines": [med("A"), med("B")]}, FakeReferences(boom={"a", "b"}))
    assert result["status"] == "unavailable" and len(result["grid"]) == 2 and not result["duplicates"]


def test_schedule_without_a_references_object_degrades():
    result = run("medication_schedule", {"medicines": [med("A")]}, None)
    assert result["status"] == "unavailable" and result["grid"][0]["placed"]


def test_schedule_timeout_keeps_finished_lookups(monkeypatch):
    monkeypatch.setattr(forms, "LOOKUP_TIMEOUT_SECONDS", 0.05)
    refs = FakeReferences(TABLE, slow={"paracetamol"})
    result = run("medication_schedule", {"medicines": [med("Tylenol"), med("paracetamol")]}, refs)
    assert result["status"] == "partial"
    assert [row["normalisation"]["status"] for row in result["grid"]] == ["matched", "unavailable"]


def test_schedule_lookups_are_concurrent_but_bounded():
    refs = FakeReferences(TABLE)
    run("medication_schedule", {"medicines": [med(f"drug{i}") for i in range(12)]}, refs)
    assert len(refs.calls) == 12 and 1 < refs.peak <= 4


@pytest.mark.parametrize("inputs", [
    {"medicines": []}, {"medicines": [med("x")] * 13}, {"medicines": [med("x", "hourly")]}, {"medicines": [med("x" * 61)]},
    {"medicines": [med("x", strength="y" * 31)]}, {"medicines": [med("x", directions_text="z" * 81, directions="other")]},
    {"medicines": [med("12345 mg")]}, {"medicines": [med("<script>")]}, {"medicines": [{"directions": "weekly"}]}])
def test_schedule_invalid_input_fails_closed(inputs):
    result = run("medication_schedule", inputs, FakeReferences())
    assert result["error"] and "grid" not in result


def test_bp_emergency_alert_survives_an_invalid_companion_row():
    result = run("bp_log_summary", {"readings": [bp(1, "08:00", 190, 100), bp(1, "09:00", 120, 80, pulse=10)]})
    assert result["error"].startswith("Invalid or out-of-range input") and "averages" not in result
    assert result["alerts"] == [{"level": "emergency", "text": forms.BP_ALERT}]
    calm = run("bp_log_summary", {"readings": [bp(1, "08:00", 120, 80), bp(1, "09:00", 120, 80, pulse=10)]})
    assert "alerts" not in calm


def test_glucose_hypoglycaemia_alert_survives_an_invalid_companion_row():
    result = run("glucose_log_pattern", {"readings": [glucose(50), {"date": "2026-10-01", "time": "08:00", "value": 100, "units": "mg/dL", "tag": "nope"}]})
    assert "error" in result and result["alerts"][0]["level"] == "emergency"


def test_glucose_high_alert_survives_an_invalid_companion_row_or_a1c():
    bad_row = {"date": "2026-10-01", "time": "08:00", "value": 100, "units": "mg/dL", "tag": "nope"}
    result = run("glucose_log_pattern", {"readings": [glucose(300), bad_row]})
    assert "error" in result and [a["level"] for a in result["alerts"]] == ["call_today"]
    assert "above 250" in result["alerts"][0]["text"]
    result = run("glucose_log_pattern", {"readings": [glucose(300)], "a1c_percent": 99})
    assert "error" in result and "above 250" in result["alerts"][0]["text"]


def test_times_with_a_timezone_are_rejected_not_crashed():
    result = run("bp_log_summary", {"readings": [bp(1, "08:00", 120, 80), bp(1, "09:00Z", 120, 80)]})
    assert result["error"] == "Invalid or out-of-range input: readings[1].time."
    result = run("glucose_log_pattern", {"readings": [glucose(100), glucose(100, time="09:00+02:00")]})
    assert result["error"] == "Invalid or out-of-range input: readings[1].time."
