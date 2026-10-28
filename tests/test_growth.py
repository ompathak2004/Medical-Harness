import hashlib
import json
from pathlib import Path

import pytest

from app.tools import growth
from app.tools.clinical import TOOL_REGISTRY

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "growth_reference_points.json").read_text())["rows"]
Z_BY_KEY = {"p3": -1.8808, "p97": 1.8808, "p2_3": -2.0, "p97_7": 2.0, "p50": 0.0}


def run(key, **data):
    return TOOL_REGISTRY[key]["function"](data)


def test_table_budget_manifest_and_hash():
    manifest = json.loads(growth.MANIFEST_PATH.read_text())
    raw = growth.TABLES_PATH.read_bytes()
    assert len(raw) <= 128 * 1024 and len(raw) == manifest["bytes"]
    assert hashlib.sha256(raw).hexdigest() == manifest["sha256"]
    tables = growth.load_tables()
    assert len(tables["who"]["weight_for_age"]["male"]) == 25
    assert len(tables["cdc"]["bmi_for_age"]["female"]) == 218
    assert manifest["retrieved"] == "2026-10-25" and manifest["licence"]


@pytest.mark.parametrize("row", FIXTURE, ids=lambda r: f"{r['system']}-{r['indicator']}-{r['sex']}-{r['age_months']}")
def test_published_percentile_rows_give_the_published_z(row):
    tables = growth.load_tables()[row["system"]][row["indicator"]][row["sex"]]
    lms = growth.lms_at(tables, row["age_months"])
    assert lms == pytest.approx((row["L"], row["M"], row["S"]))
    for key, value in row["published"].items():
        if key in Z_BY_KEY:
            assert growth.z_from_lms(value, lms) == pytest.approx(Z_BY_KEY[key], abs=.01 if key != "p50" else .001)


def test_who_boy_at_birth_median():
    result = run("growth_percentile", sex="male", age_months=0, measure="weight", value=3.3464)
    assert result["z"] == 0 and result["percentile"] == 50.0
    assert result["reference"] == "WHO 2006" and result["z_method"] == "who_lms" and not result["flag"]
    assert len(result["curve"]) == 25 and result["point"] == {"age_months": 0, "value": 3.35}
    assert {"p3", "p15", "p50", "p85", "p97", "age_months"} == set(result["curve"][0])


def test_cdc_boy_at_24_months_median():
    result = run("growth_percentile", sex="male", age_months=24, measure="weight", value=12.6707633)
    assert abs(result["z"]) < .01 and result["reference"] == "CDC 2000" and len(result["curve"]) == 217


def test_who_modified_z_beyond_three_sd():
    result = run("growth_percentile", sex="male", age_months=0, measure="weight", value=6)
    assert result["z_method"] == "who_modified" and result["z"] == pytest.approx(4.59, abs=.05)
    assert result["flag"] and result["percentile_text"].startswith("more than 999 of 1,000")


def test_interpolation_between_rows_is_linear():
    rows = growth.load_tables()["who"]["weight_for_age"]["male"]
    middle = growth.lms_at(rows, 4.5)
    for i in range(3):
        assert middle[i] == pytest.approx((rows[4][i + 1] + rows[5][i + 1]) / 2)
    with pytest.raises(ValueError):
        growth.lms_at(rows, 25)


def test_head_circumference_after_two_years_is_refused():
    result = run("growth_percentile", sex="female", age_months=30, measure="head_circumference", value=48)
    assert result["error"] and "percentile" not in result and "z" not in result


def test_bmi_percentile_and_plausibility():
    result = run("child_bmi_percentile", sex="female", age_months=120, weight_kg=32, height_cm=137)
    assert 0 < result["percentile"] < 100 and result["reference_lines"]["p5"] < result["reference_lines"]["p95"]
    assert result["recommendation"] and result["units"] == "kg/m²"
    assert "error" in run("child_bmi_percentile", sex="female", age_months=120, weight_kg=190, height_cm=60)
    assert "error" in run("child_bmi_percentile", sex="female", age_months=20, weight_kg=10, height_cm=80)


def test_unavailable_tables_return_error_and_no_number(monkeypatch):
    def broken():
        raise growth.GrowthTablesError("hash")
    monkeypatch.setattr(growth, "load_tables", broken)
    for key, data in [("growth_percentile", dict(sex="male", age_months=6, measure="weight", value=7.5)),
                      ("child_bmi_percentile", dict(sex="male", age_months=60, weight_kg=18, height_cm=107))]:
        result = run(key, **data)
        assert result["error"] == growth.UNAVAILABLE
        assert not {"value", "z", "percentile", "curve"}.intersection(result)


def test_hash_mismatch_raises(monkeypatch, tmp_path):
    bad = tmp_path / "growth_lms.json"
    bad.write_bytes(growth.TABLES_PATH.read_bytes().replace(b"0", b"1", 1))
    monkeypatch.setattr(growth, "TABLES_PATH", bad)
    growth.load_tables.cache_clear()
    try:
        with pytest.raises(growth.GrowthTablesError):
            growth.load_tables()
    finally:
        monkeypatch.undo()
        growth.load_tables.cache_clear()
    assert growth.load_tables()


def test_missing_table_file_raises(monkeypatch, tmp_path):
    monkeypatch.setattr(growth, "TABLES_PATH", tmp_path / "missing.json")
    growth.load_tables.cache_clear()
    try:
        with pytest.raises(growth.GrowthTablesError):
            growth.load_tables()
    finally:
        monkeypatch.undo()
        growth.load_tables.cache_clear()
