"""Unit tests for deterministic clinical calculators."""

from app.tools.clinical import (
    TOOL_REGISTRY,
    compute_bmi,
    compute_cha2ds2_vasc,
    compute_wells_dvt,
)


class TestWellsDVT:
    def test_high_risk(self):
        result = compute_wells_dvt(
            {
                "active_cancer": 1,
                "entire_leg_swollen": 1,
                "calf_swelling_gt_3cm": 1,
                "pitting_edema": 1,
            }
        )
        assert result["score"] == 4
        assert result["risk"] == "High"

    def test_low_risk_with_alternative_diagnosis(self):
        result = compute_wells_dvt(
            {"tenderness_along_veins": 1, "alternative_diagnosis_likely": 1}
        )
        assert result["score"] == -1
        assert result["risk"] == "Low"

    def test_moderate_risk(self):
        result = compute_wells_dvt({"previous_dvt": 1})
        assert result["score"] == 1
        assert result["risk"] == "Moderate"

    def test_empty_input(self):
        result = compute_wells_dvt({})
        assert result["score"] == 0
        assert result["risk"] == "Low"


class TestCha2ds2Vasc:
    def test_elderly_female_with_comorbidities(self):
        result = compute_cha2ds2_vasc(
            {
                "congestive_heart_failure": 1,
                "hypertension": 1,
                "age_75_or_older": 1,
                "diabetes": 1,
                "stroke_or_tia_history": 1,
                "sex_female": 1,
            }
        )
        # CHF(1) + HTN(1) + age>=75(2) + DM(1) + stroke(2) + female(1) = 8
        assert result["score"] == 8

    def test_age_bands_mutually_exclusive(self):
        older = compute_cha2ds2_vasc({"age_75_or_older": 1, "age_65_to_74": 1})
        assert older["score"] == 2  # 75+ wins, not additive

    def test_zero(self):
        assert compute_cha2ds2_vasc({})["score"] == 0


class TestBMI:
    def test_normal(self):
        result = compute_bmi({"weight_kg": 70, "height_cm": 175})
        assert abs(result["bmi"] - 22.9) < 0.1
        assert "normal" in result["category"].lower()

    def test_obese(self):
        result = compute_bmi({"weight_kg": 120, "height_cm": 170})
        assert result["bmi"] > 30

    def test_missing_data(self):
        result = compute_bmi({})
        # Should not raise; returns an error/notice structure
        assert isinstance(result, dict)


class TestRegistry:
    def test_all_tools_have_required_keys(self):
        for key, info in TOOL_REGISTRY.items():
            assert "description" in info, key
            assert "variables" in info, key
            assert callable(info["function"]), key

    def test_all_tools_run_with_empty_input(self):
        for key, info in TOOL_REGISTRY.items():
            result = info["function"]({})
            assert isinstance(result, dict), key
