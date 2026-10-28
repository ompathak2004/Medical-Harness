import math

import pytest

from app.tools.clinical import TOOL_REGISTRY, compute_bmi, compute_cha2ds2_vasc, compute_wells_dvt, compute_egfr, compute_estimated_glucose, compute_mrc_grade, compute_unit_conversion, compute_non_hdl_cholesterol, compute_pack_years, compute_waist_to_height


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
    assert not {"score", "bmi", "value", "grade"}.intersection(result)
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
