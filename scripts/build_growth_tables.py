"""Build app/tools/data/growth_lms.json from public CDC-hosted growth-chart files.

Usage: python scripts/build_growth_tables.py [--source-dir DIR]

Without --source-dir the eight source CSV files are downloaded from cdc.gov and ftp.cdc.gov (six WHO
0-24 month files and the CDC 2000 weight-, stature- and BMI-for-age files). With --source-dir the files
are read from DIR under their original names. The script writes the compact JSON table, its manifest
(SHA-256, size, row counts, source URLs, per-file SHA-256 and the retrieval date), and a 24-row fixture
of published percentile values used by tests/test_growth.py.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "tools" / "data"
FIXTURE = ROOT / "tests" / "fixtures" / "growth_reference_points.json"
WHO_BASE = "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/growthcharts/"
CDC_BASE = "https://www.cdc.gov/growthcharts/data/zscore/"
MAX_BYTES = 128 * 1024

# (system, indicator, sex, file name). WHO file names are exactly as published (one has a space).
SOURCES = [
    ("who", "weight_for_age", "male", "WHO-Boys-Weight-for-age-Percentiles.csv"),
    ("who", "weight_for_age", "female", "WHO-Girls-Weight-for-age Percentiles.csv"),
    ("who", "length_for_age", "male", "WHO-Boys-Length-for-age-Percentiles.csv"),
    ("who", "length_for_age", "female", "WHO-Girls-Length-for-age-Percentiles.csv"),
    ("who", "head_circumference_for_age", "male", "WHO-Boys-Head-Circumference-for-age-Percentiles.csv"),
    ("who", "head_circumference_for_age", "female", "WHO-Girls-Head-Circumference-for-age-Percentiles.csv"),
    ("cdc", "weight_for_age", None, "wtage.csv"),
    ("cdc", "stature_for_age", None, "statage.csv"),
    ("cdc", "bmi_for_age", None, "bmiagerev.csv"),
]
CDC_SEX = {"1": "male", "2": "female"}
WHO_PERCENTILE_COLUMNS = {"2nd (2.3rd)": "p2_3", "5th": "p5", "10th": "p10", "25th": "p25", "50th": "p50",
                          "75th": "p75", "90th": "p90", "95th": "p95", "98th (97.7th)": "p97_7"}


def fetch(system, name, source_dir):
    if source_dir:
        return (Path(source_dir) / name).read_bytes()
    url = (WHO_BASE if system == "who" else CDC_BASE) + urllib.parse.quote(name)
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def source_url(system, name):
    return (WHO_BASE if system == "who" else CDC_BASE) + urllib.parse.quote(name)


def number(text):
    value = float(text)
    return int(value) if value.is_integer() else value


def parse(system, raw, who_sex=None):
    """Return {sex: [(age, L, M, S, {percentile column: value})]} with values at source precision."""
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    tables = {"male": [], "female": []}
    for row in reader:
        if system == "who":
            sex = who_sex
            age = number(row["Month"])
            published = {WHO_PERCENTILE_COLUMNS[k]: float(row[k]) for k in WHO_PERCENTILE_COLUMNS}
        else:
            if row["Sex"].strip() not in CDC_SEX:
                continue  # bmiagerev.csv repeats its header line between the sexes
            sex = CDC_SEX[row["Sex"].strip()]
            age = number(row["Agemos"])
            if age > 240:
                continue  # bmiagerev.csv carries an extra 240.5 month row; the bundled range ends at 240.0
            published = {f"p{k[1:]}": float(v) for k, v in row.items() if k.startswith("P") and v.strip()}
        entry = (age, number(row["L"]), number(row["M"]), number(row["S"]), published)
        tables.setdefault(sex, []).append(entry)
    return tables


def build(source_dir=None, retrieved=None):
    retrieved = retrieved or date.today().isoformat()
    data = {"version": 1, "who": {}, "cdc": {}}
    fixture_pool = []
    manifest_sources = []
    row_counts = {"who": {}, "cdc": {}}
    for system, indicator, sex, name in SOURCES:
        raw = fetch(system, name, source_dir)
        parsed = parse(system, raw, sex)
        sexes = [sex] if sex else ["male", "female"]
        data[system].setdefault(indicator, {})
        row_counts[system].setdefault(indicator, {})
        for each in sexes:
            rows = parsed[each]
            data[system][indicator][each] = [[age, l, m, s] for age, l, m, s, _ in rows]
            row_counts[system][indicator][each] = len(rows)
            # Two deterministic rows per table: one a third and one two thirds of the way through.
            for index in (len(rows) // 3, 2 * len(rows) // 3):
                age, l, m, s, published = rows[index]
                fixture_pool.append({"system": system, "indicator": indicator, "sex": each, "age_months": age,
                                     "L": l, "M": m, "S": s, "published": published})
        manifest_sources.append({"system": system, "indicator": indicator, "sex": sex or "male+female",
                                 "url": source_url(system, name), "sha256": hashlib.sha256(raw).hexdigest()})
    payload = (json.dumps(data, separators=(",", ":")) + "\n").encode()
    if len(payload) > MAX_BYTES:
        sys.exit(f"growth_lms.json is {len(payload)} bytes; the budget is {MAX_BYTES}")
    manifest = {
        "version": 1, "file": "growth_lms.json", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload),
        "max_bytes": MAX_BYTES, "retrieved": retrieved, "row_counts": row_counts,
        "formula": "z = ((X/M)^L - 1)/(L*S), or ln(X/M)/S when L = 0; L, M, S linearly interpolated by age in months",
        "sources": manifest_sources,
        "licence": "WHO 2006 growth standards and CDC 2000 growth charts as distributed by the US CDC "
                   "(CDC-authored data are US-government public domain; see NOTICE.md).",
    }
    return payload, manifest, fixture_pool


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-dir", help="read the source CSV files from this directory instead of downloading")
    parser.add_argument("--retrieved", help="retrieval date (default: today)")
    args = parser.parse_args()
    payload, manifest, fixture = build(args.source_dir, args.retrieved)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "growth_lms.json").write_bytes(payload)
    (DATA / "growth_lms.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps({"version": 1, "rows": fixture}, indent=1) + "\n")
    print(f"wrote {len(payload)} bytes, {len(fixture)} fixture rows")


if __name__ == "__main__":
    main()
