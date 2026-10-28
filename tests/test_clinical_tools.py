import math

import pytest

from app.tools.clinical import CHILD_DOSE_BANDS, LB_PER_KG, TOOL_REGISTRY, compute_bmi, compute_cha2ds2_vasc, compute_wells_dvt, compute_egfr, compute_estimated_glucose, compute_mrc_grade, compute_unit_conversion, compute_non_hdl_cholesterol, compute_pack_years, compute_waist_to_height


def complete(key, **overrides):
    return {**dict.fromkeys(TOOL_REGISTRY[key]["variables"], 0), **overrides}


def test_wells_two_level_thresholds():
    assert compute_wells_dvt(complete("wells_dvt", previous_dvt=1))["risk"] == "DVT unlikely"
    likely = compute_wells_dvt(complete("wells_dvt", previous_dvt=1, entire_leg_swollen=1))
    assert likely["score"] == 2
    assert likely["risk"] == "DVT likely"
    assert compute_wells_dvt(complete("wells_dvt", alternative_diagnosis_likely=1))["score"] == -2


def test_cha2ds2_vasc_and_conflicting_ages():
    result = compute_cha2ds2_vasc(complete("cha2ds2_vasc", age_75_or_older=1, sex_female=1, hypertension=1, stroke_or_tia_history=1))
    assert result["score"] == 6
    assert "error" in compute_cha2ds2_vasc(complete("cha2ds2_vasc", age_75_or_older=1, age_65_to_74=1))


@pytest.mark.parametrize("key", list(TOOL_REGISTRY))
def test_missing_data_never_produces_score(key):
    result = TOOL_REGISTRY[key]["function"]({})
    assert result["error"]
    assert result["missing_inputs"]
    assert not {"score", "bmi", "value", "grade", "summary", "amount_ml", "percentile"}.intersection(result)
    assert result["source"].startswith("https://")


@pytest.mark.parametrize("weight", [-1, 0, math.nan, math.inf, True, "70"])
def test_bmi_rejects_invalid_values(weight):
    assert "error" in compute_bmi({"weight_kg": weight, "height_cm": 175, "age_years": 30})


def test_bmi_unrounded_threshold_and_age_scope():
    result = compute_bmi({"weight_kg": 99.96, "height_cm": 200, "age_years": 30})
    assert result["bmi"] == 25.0
    assert result["category"] == "Healthy weight"
    assert "error" in compute_bmi({"weight_kg": 50, "height_cm": 160, "age_years": 12})


@pytest.mark.parametrize("sex,creatinine,expected", [("male", 1, 91.7), ("female", 1, 68.6), ("female", .7, 105.3)])
def test_egfr_reference_cases(sex, creatinine, expected):
    result = compute_egfr({"age_years": 50, "sex": sex, "creatinine_mg_dl": creatinine})
    assert result["value"] == pytest.approx(expected, abs=.1)
    assert result["units"] == "mL/min/1.73 m²"


def test_egfr_rejects_child_and_wrong_units():
    assert "error" in compute_egfr({"age_years": 15, "sex": "male", "creatinine_mg_dl": 1})
    assert "error" in compute_egfr({"age_years": 50, "sex": "male", "creatinine_mg_dl": 88.4})


def test_average_glucose_reference():
    result = compute_estimated_glucose({"a1c_percent": 7})
    assert result["value"] == 154.2
    assert result["mmol_l"] == 8.6


@pytest.mark.parametrize("value", [-1, 6, 2.5, "3", True])
def test_mrc_does_not_clamp_or_coerce(value):
    assert "error" in compute_mrc_grade({"grade": value})


@pytest.mark.parametrize("conversion,value,expected", [("f_to_c", 98.6, 37), ("lb_to_kg", 100, 45.359), ("in_to_cm", 10, 25.4), ("creatinine_umol_l_to_mg_dl", 88.4, 1), ("glucose_mg_dl_to_mmol_l", 180, 10)])
def test_unit_conversions(conversion, value, expected):
    assert compute_unit_conversion({"conversion": conversion, "value": value})["value"] == expected


def test_boolean_string_not_truthy():
    assert "error" in compute_wells_dvt(complete("wells_dvt", previous_dvt="false"))


def test_approximate_framingham_removed():
    assert "framingham" not in TOOL_REGISTRY


@pytest.mark.parametrize("total,hdl,units,expected", [(200, 50, "mg/dL", 150), (5.2, 1.3, "mmol/L", 3.9)])
def test_non_hdl_preserves_supplied_units(total, hdl, units, expected):
    result = compute_non_hdl_cholesterol({"total_cholesterol": total, "hdl_cholesterol": hdl,
                                         "total_units": units, "hdl_units": units})
    assert result["value"] == pytest.approx(expected)
    assert result["units"] == units
    assert not {"risk", "category", "recommendation"}.intersection(result)


@pytest.mark.parametrize("overrides", [
    {"hdl_units": "mmol/L"}, {"hdl_cholesterol": 250}, {"total_cholesterol": math.nan},
    {"total_cholesterol": True}, {"total_cholesterol": -1}, {"total_units": "unknown"},
    {"total_units": "mmol/L", "hdl_units": "mmol/L"},
])
def test_non_hdl_rejects_invalid_panels(overrides):
    result = compute_non_hdl_cholesterol({"total_cholesterol": 200, "hdl_cholesterol": 50,
                                         "total_units": "mg/dL", "hdl_units": "mg/dL", **overrides})
    assert result["error"]
    assert "value" not in result


def test_pack_years_reference_and_inputs_echo():
    result = compute_pack_years({"packs_per_day": 1, "years_smoked": 30})
    assert result["value"] == 30.0 and isinstance(result["value"], float)
    assert result["units"] == "pack-years"
    assert result["inputs"] == {"packs_per_day": 1, "years_smoked": 30}
    assert result["source"].startswith("https://www.uspreventiveservicestaskforce.org/")
    assert "does not decide eligibility" in result["recommendation"]


@pytest.mark.parametrize("packs,years,expected", [(0.05, 1, 0.1), (10, 100, 1000.0), (0.5, 0, 0.0), (1.5, 20, 30.0)])
def test_pack_years_bounds_and_zero_years(packs, years, expected):
    assert compute_pack_years({"packs_per_day": packs, "years_smoked": years})["value"] == expected


@pytest.mark.parametrize("overrides", [
    {"packs_per_day": 0.04}, {"packs_per_day": 10.1}, {"packs_per_day": -1}, {"years_smoked": -1},
    {"years_smoked": 101}, {"packs_per_day": "1"}, {"years_smoked": "30"}, {"years_smoked": True},
    {"packs_per_day": math.nan}, {"years_smoked": math.inf},
])
def test_pack_years_rejects_invalid_values(overrides):
    result = compute_pack_years({"packs_per_day": 1, "years_smoked": 30, **overrides})
    assert result["error"]
    assert "value" not in result


def test_waist_to_height_reference_and_rounding():
    result = compute_waist_to_height({"waist_cm": 90, "height_cm": 180})
    assert result["value"] == 0.5
    assert result["units"] == "ratio"
    assert result["inputs"] == {"waist_cm": 90, "height_cm": 180}
    assert result["source"] == "https://www.nice.org.uk/guidance/ng246"
    assert "not a diagnosis" in result["recommendation"]
    assert compute_waist_to_height({"waist_cm": 100, "height_cm": 170})["value"] == 0.59
    assert compute_waist_to_height({"waist_cm": 85.5, "height_cm": 165.2})["value"] == 0.52


@pytest.mark.parametrize("waist,height", [(180, 180), (200, 180), (250, 150)])
def test_waist_to_height_rejects_waist_not_smaller_than_height(waist, height):
    result = compute_waist_to_height({"waist_cm": waist, "height_cm": height})
    assert result["error"]
    assert "value" not in result


@pytest.mark.parametrize("overrides", [
    {"waist_cm": 39}, {"waist_cm": 251}, {"height_cm": 99}, {"height_cm": 251}, {"waist_cm": "90"},
    {"height_cm": None}, {"waist_cm": math.nan}, {"height_cm": True},
])
def test_waist_to_height_rejects_out_of_range_values(overrides):
    result = compute_waist_to_height({"waist_cm": 90, "height_cm": 180, **overrides})
    assert result["error"]
    assert "value" not in result


def test_calculators_echo_inputs_on_success_only():
    data = {"weight_kg": 70, "height_cm": 175, "age_years": 30, "extra": "ignored"}
    result = compute_bmi(data)
    assert result["inputs"] == {"weight_kg": 70, "height_cm": 175, "age_years": 30}
    assert compute_egfr({"age_years": 50, "sex": "male", "creatinine_mg_dl": 1})["inputs"]["sex"] == "male"
    assert compute_wells_dvt(complete("wells_dvt"))["inputs"] == complete("wells_dvt")
    assert "inputs" not in compute_bmi({"weight_kg": -1, "height_cm": 175, "age_years": 30})
    assert "inputs" not in compute_bmi({})


def test_new_calculators_are_registered():
    assert TOOL_REGISTRY["pack_years"]["variables"] == ["packs_per_day", "years_smoked"]
    assert TOOL_REGISTRY["waist_to_height"]["variables"] == ["waist_cm", "height_cm"]


# ---------------------------------------------------------------- v2 patient tools

run = lambda key, **data: TOOL_REGISTRY[key]["function"](data)  # noqa: E731


def dose(**overrides):
    return run("child_dose_check", **{"medicine": "acetaminophen", "concentration": "160mg/5mL", "weight": 30, "weight_units": "lb", "age_months": 36, **overrides})


def test_every_tool_has_name_key_and_short_description():
    assert len(TOOL_REGISTRY) == 18
    for key, info in TOOL_REGISTRY.items():
        assert len(info["description"]) < 300, key
        assert info["name"] and info["scope"] and info["source"].startswith("https://")
        assert TOOL_REGISTRY[key]["function"]({})["key"] == key


@pytest.mark.parametrize("medicine,concentration,rows", [
    ("acetaminophen", "160mg/5mL", [(6, 1.25), (12, 2.5), (18, 3.75), (24, 5), (36, 7.5), (48, 10), (60, 12.5), (72, 15)]),
    ("ibuprofen", "100mg/5mL", [(12, 2.5), (18, 4), (24, 5), (36, 7.5), (48, 10), (60, 12.5), (72, 15)]),
    ("ibuprofen", "50mg/1.25mL", [(12, 1.25), (18, 1.875), (24, 2.5), (36, 3.75), (48, 5)]),
])
def test_dose_table_rows_are_pinned(medicine, concentration, rows):
    assert [(low, amount) for low, _, amount in CHILD_DOSE_BANDS[medicine][concentration]] == rows
    for low, amount in rows:
        result = dose(medicine=medicine, concentration=concentration, weight=low, age_months=48)
        assert result["amount_ml"] == amount and result["band_low_lb"] == low
        assert result["syringe"]["amount_ml"] == amount <= result["syringe"]["capacity_ml"]


@pytest.mark.parametrize("medicine,concentration,low_mg_kg,high_mg_kg", [
    ("acetaminophen", "160mg/5mL", 9.5, 15), ("ibuprofen", "100mg/5mL", 5, 10), ("ibuprofen", "50mg/1.25mL", 5, 10)])
def test_dose_rows_are_plausible_mg_per_kg(medicine, concentration, low_mg_kg, high_mg_kg):
    mg_per_ml = {"160mg/5mL": 32, "100mg/5mL": 20, "50mg/1.25mL": 40}[concentration]
    for low, high, amount in CHILD_DOSE_BANDS[medicine][concentration]:
        middle_kg = (low + high + 1) / 2 / LB_PER_KG
        assert low_mg_kg <= amount * mg_per_ml / middle_kg <= high_mg_kg, (low, high)


def test_dose_converts_kilograms_to_pounds_band():
    result = dose(weight=14, weight_units="kg")
    assert result["weight_lb"] == 30.9
    assert (result["band_low_lb"], result["band_high_lb"], result["amount_ml"]) == (24, 35, 5)
    assert result["max_doses_24h"] == 5 and result["interval_hours_low"] == 4
    assert result["amount_mg"] == 160 and result["summary"] and "error" not in result


def test_dose_edge_flag_and_under_two_note():
    assert dose(weight=24.5, age_months=36)["near_band_edge"]
    assert not dose(weight=30, age_months=36)["near_band_edge"]
    result = dose(weight=20, age_months=18)
    assert any("under 2 years" in note for note in result["notes"])


@pytest.mark.parametrize("overrides,urgent", [
    ({"age_months": 2}, True),
    ({"medicine": "ibuprofen", "concentration": "100mg/5mL", "age_months": 5}, False),
    ({"medicine": "ibuprofen"}, False),
    ({"weight": 96}, False),
    ({"age_months": 150}, False),
    ({"weight": 5}, False),
    ({"medicine": "ibuprofen", "concentration": "50mg/1.25mL", "weight": 60}, False),
])
def test_dose_hard_stops_carry_no_amount(overrides, urgent):
    result = dose(**overrides)
    assert result["error"] and result["hard_stop"]["urgent"] is urgent
    assert not {"amount_ml", "amount_mg", "summary", "syringe"}.intersection(result)


def test_dose_rejects_weight_outside_its_units():
    assert "error" in dose(weight=70, weight_units="kg")
    assert "hard_stop" not in dose(weight=70, weight_units="kg")
    assert "error" in dose(weight=1, weight_units="lb")


def test_ors_volumes_and_scope():
    result = run("ors_planner", weight=14, weight_units="kg", age_months=30)
    assert result["per_stool_ml"] == 70
    assert result["cdc_per_episode_ml"] == {"low": 120, "high": 240}
    assert result["teaspoon_timer"] == {"ml_per_sip": 5, "seconds_between_low": 60, "seconds_between_high": 120}
    assert "risk_note" not in result and result["red_flags"] and result["summary"]
    assert run("ors_planner", weight=8, weight_units="kg", age_months=4)["risk_note"]
    assert run("ors_planner", weight=8, weight_units="kg", age_months=4)["cdc_per_episode_ml"] == {"low": 60, "high": 120}
    newborn = run("ors_planner", weight=4, weight_units="kg", age_months=0)
    assert newborn["error"] and "per_stool_ml" not in newborn


def lab(**overrides):
    return run("lab_result_reader", **{"test_name": "Glucose", "analyte": "glucose", "value": 100, "units": "mg/dL",
                                       "range_kind": "between", "range_low": 70, "range_high": 99, "flag_on_report": "H", **overrides})


def test_lab_conversions_and_position():
    result = lab()
    assert result["status"] == "above" and result["converted"] == {"value": 5.55, "units": "mmol/L"}
    assert result["position"]["fraction"] == pytest.approx(1.034, abs=.001)
    assert result["word_help"]["term"] == "H" and len(result["questions"]) == 3
    assert lab(analyte="creatinine", test_name="Creat", value=1.0, range_low=.6, range_high=1.2)["converted"]["value"] == 88.4
    a1c = lab(analyte="hba1c", test_name="A1c", value=7.0, units="%", range_low=4, range_high=5.6, flag_on_report="")
    assert a1c["converted"] == {"value": 53.0, "units": "mmol/mol"} and a1c["word_help"] is None
    assert a1c["position"]["fraction"] == 1.5


def test_lab_other_analyte_has_no_conversion_and_bad_range_errors():
    assert "converted" not in lab(analyte="other")
    bad = lab(range_low=99, range_high=70)
    assert bad["error"] and not {"status", "position"}.intersection(bad)
    assert "error" in lab(range_low=99, range_high=99)


def test_lab_one_sided_ranges():
    below = lab(range_kind="below", range_low=100, range_high=100, value=90, flag_on_report="")
    assert below["status"] == "within" and below["position"]["fraction"] is None and below["position"]["low"] is None
    assert lab(range_kind="above", range_low=60, range_high=60, value=50)["status"] == "below"
    assert "error" in lab(range_kind="below", range_low=50, range_high=100)


@pytest.mark.parametrize("reading,percent,zone", [(400, 100, "green"), (320, 80, "green"), (319, 79, "yellow"), (200, 50, "yellow"), (199, 49, "red")])
def test_peak_flow_zones(reading, percent, zone):
    result = run("peak_flow_zone", personal_best_l_min=400, reading_l_min=reading)
    assert (result["value"], result["zone"]) == (percent, zone)
    assert result["units"] == "% of personal best" and len(result["zones"]) == 3
    assert bool(result.get("alerts")) is (zone == "red")


def test_peak_flow_rejects_reading_far_above_best():
    assert "error" in run("peak_flow_zone", personal_best_l_min=400, reading_l_min=600)
    assert "value" not in run("peak_flow_zone", personal_best_l_min=400, reading_l_min=600)


def hf(now, before, units="kg", interval="1_day"):
    return run("hf_weight_zone", weight_now=now, weight_before=before, weight_units=units, interval=interval)


def test_hf_weight_thresholds():
    one_kg = hf(81.0, 80.0)
    assert (one_kg["value"], one_kg["change_lb"], one_kg["zone"], one_kg["direction"]) == (1.0, 2.2, "call_team", "gain")
    assert one_kg["alerts"]
    assert hf(177.5, 176, "lb")["zone"] == "within" and hf(177.5, 176, "lb")["value"] == 1.5
    assert hf(180, 175, "lb", "7_days")["zone"] == "call_team"
    assert hf(179.9, 175, "lb", "7_days")["zone"] == "within"
    loss = hf(170, 175, "lb", "7_days")
    assert (loss["zone"], loss["direction"], loss["value"]) == ("within", "loss", -5)
    assert "error" in hf(100, 70)


STEADI_KEYS = TOOL_REGISTRY["steadi_fall_risk"]["variables"]


def steadi(*yes):
    return run("steadi_fall_risk", **{key: key in yes for key in STEADI_KEYS})


def test_steadi_scoring_and_talk_anyway():
    assert len(STEADI_KEYS) == 12
    none = steadi()
    assert (none["score"], none["at_risk"], none["talk_anyway"], none["max_score"]) == (0, False, False, 14)
    fall = steadi("fallen_past_year")
    assert (fall["score"], fall["at_risk"], fall["talk_anyway"]) == (2, False, True)
    assert steadi("fallen_past_year", "uses_or_advised_cane_walker")["at_risk"]
    three = steadi("steadies_on_furniture", "rushes_to_toilet", "often_sad_or_depressed")
    assert (three["score"], three["at_risk"]) == (3, False)
    four = steadi("steadies_on_furniture", "rushes_to_toilet", "often_sad_or_depressed", "lost_feeling_in_feet")
    assert (four["score"], four["at_risk"]) == (4, True)
    assert [item["key"] for item in four["items"]] == STEADI_KEYS and four["home_hazards"]
    assert steadi(*STEADI_KEYS)["score"] == 14


def test_steadi_missing_item_fails_closed():
    answers = dict.fromkeys(STEADI_KEYS, False)
    del answers["often_sad_or_depressed"]
    result = TOOL_REGISTRY["steadi_fall_risk"]["function"](answers)
    assert result["missing_inputs"] == ["often_sad_or_depressed"] and "score" not in result


def test_estimated_glucose_draws_the_adag_line():
    result = compute_estimated_glucose({"a1c_percent": 7})
    assert result["value"] == 154.2 and result["mmol_l"] == 8.6
    assert [p["a1c"] for p in result["line"]] == [5 + .5 * i for i in range(15)]
    assert result["point"] == {"a1c": 7, "eag": 154.2}
    assert result["key"] == "estimated_glucose"


def test_infant_stop_comes_before_missing_or_unknown_concentration():
    """A missing or unknown concentration must not hide the same-day call for a baby under 3 months."""
    missing = TOOL_REGISTRY["child_dose_check"]["function"]({"medicine": "acetaminophen", "weight": 10, "weight_units": "lb", "age_months": 2})
    assert missing["hard_stop"]["urgent"] and "missing_inputs" not in missing and "amount_ml" not in missing
    unknown = dose(concentration="unknown", age_months=2)
    assert unknown["hard_stop"]["title"] == "Baby under 3 months" and "amount_ml" not in unknown
    assert dose(medicine="ibuprofen", concentration="unknown", age_months=2)["hard_stop"]["urgent"]
    assert dose(medicine="ibuprofen", concentration="unknown", age_months=4)["hard_stop"]["title"] == "Baby under 6 months"
    # Without an age the ordinary validation still applies.
    assert "Invalid or out-of-range input: concentration." == dose(concentration="unknown")["error"]


def test_hf_implausible_pair_keeps_the_contact_today_alert():
    big_gain = hf(85, 70, "kg", "7_days")
    assert "error" in big_gain and "value" not in big_gain and "zone" not in big_gain
    assert big_gain["alerts"][0]["level"] == "call_today"
    assert "alerts" not in hf(70, 85, "kg", "7_days")


def test_huge_json_integers_are_a_bounded_input_error():
    result = TOOL_REGISTRY["bmi"]["function"]({"weight_kg": 10**310, "height_cm": 175, "age_years": 30})
    assert result["error"] == "Invalid or out-of-range input: weight_kg." and "bmi" not in result
