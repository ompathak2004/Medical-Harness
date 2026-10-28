from __future__ import annotations

import math
from functools import wraps

TOOL_REGISTRY = {}


def calculator(key, name, description, inputs, source, scope):
    def register(function):
        @wraps(function)
        def run(data):
            base = {"tool": name, "source": source, "scope": scope}
            if not isinstance(data, dict):
                return {**base, "error": "Inputs must be an object."}
            missing = [field for field in inputs if data.get(field) is None]
            if missing:
                return {**base, "error": "Required inputs were not supplied.", "missing_inputs": missing}
            for field, rule in inputs.items():
                value = data[field]
                if rule == "boolean":
                    valid = type(value) is bool or type(value) is int and value in (0, 1)
                elif isinstance(rule, set):
                    valid = isinstance(value, str) and value in rule
                else:
                    low, high = rule
                    valid = type(value) in (int, float) and math.isfinite(value) and low <= value <= high
                if not valid:
                    return {**base, "error": f"Invalid or out-of-range input: {field}."}
            try:
                return {**base, "inputs": {field: data[field] for field in inputs}, **function(data)}
            except ValueError as exc:
                return {**base, "error": str(exc)}
        TOOL_REGISTRY[key] = {"description": description, "variables": list(inputs),
                              "source": source, "scope": scope, "function": run}
        return run
    return register


@calculator(
    "wells_dvt", "Wells Score (DVT)",
    "Two-level Wells DVT score only when every criterion is explicitly supplied, including clinician examination and alternative diagnosis assessment. Never infer absent findings.",
    {key: "boolean" for key in ("active_cancer", "paralysis_or_cast", "bedridden_or_surgery",
     "tenderness_along_veins", "entire_leg_swollen", "calf_swelling_gt_3cm", "pitting_edema",
     "collateral_superficial_veins", "previous_dvt", "alternative_diagnosis_likely")},
    "https://www.nice.org.uk/guidance/ng158/chapter/recommendations", "Adult clinical assessment; cannot diagnose or rule out a clot.",
)
def compute_wells_dvt(data):
    score = sum(int(data[key]) for key in TOOL_REGISTRY["wells_dvt"]["variables"] if key != "alternative_diagnosis_likely") - 2 * int(data["alternative_diagnosis_likely"])
    return {"score": score, "risk": "DVT likely" if score >= 2 else "DVT unlikely",
            "recommendation": "A clinician must interpret this score with examination and appropriate testing. It does not exclude DVT or replace urgent care."}


@calculator(
    "cha2ds2_vasc", "CHA2DS2-VASc Score",
    "CHA2DS2-VASc for adults with confirmed atrial fibrillation and all explicitly supplied risk factors. Do not use for an undiagnosed irregular heartbeat or prescribe treatment.",
    {key: "boolean" for key in ("congestive_heart_failure", "hypertension", "age_75_or_older",
     "age_65_to_74", "diabetes", "stroke_or_tia_history", "vascular_disease", "sex_female")},
    "https://doi.org/10.1378/chest.09-1584", "Adults with diagnosed atrial fibrillation; treatment decisions require current local guidelines and clinical review.",
)
def compute_cha2ds2_vasc(data):
    if data["age_75_or_older"] and data["age_65_to_74"]:
        raise ValueError("Age bands cannot both be true.")
    score = sum(int(data[key]) for key in ("congestive_heart_failure", "hypertension", "diabetes", "vascular_disease", "sex_female"))
    score += 2 * int(data["age_75_or_older"]) + int(data["age_65_to_74"]) + 2 * int(data["stroke_or_tia_history"])
    return {"score": score, "recommendation": "Review this score with the clinician managing the atrial fibrillation; it is not a medication recommendation."}


@calculator(
    "mrc_muscle", "MRC Muscle Strength", "Explain a clinician-recorded integer MRC strength grade from 0 to 5. Never infer grade from a symptom description.",
    {"grade": (0, 5)}, "https://www.ukri.org/councils/mrc/facilities-and-resources/find-an-mrc-facility-or-resource/mrc-muscle-scale/",
    "Requires an examined muscle strength grade.",
)
def compute_mrc_grade(data):
    grade = data["grade"]
    if int(grade) != grade:
        raise ValueError("MRC grade must be an integer.")
    descriptions = ["No contraction", "Flicker or trace contraction", "Active movement with gravity eliminated",
                    "Active movement against gravity", "Active movement against gravity and resistance", "Normal strength"]
    return {"grade": int(grade), "description": descriptions[int(grade)]}


@calculator(
    "bmi", "BMI Calculator", "Adult BMI with explicit weight in kg, height in cm, and age in years (20 or older). Screening measure, not a diagnosis; not for pregnancy or pediatric classification.",
    {"weight_kg": (1, 700), "height_cm": (50, 275), "age_years": (20, 120)},
    "https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html", "Adult screening measure; does not distinguish fat from muscle or assess pregnancy.",
)
def compute_bmi(data):
    value = data["weight_kg"] / (data["height_cm"] / 100) ** 2
    category = next(label for upper, label in [(18.5, "Underweight"), (25, "Healthy weight"), (30, "Overweight"),
                    (35, "Obesity, class 1"), (40, "Obesity, class 2"), (math.inf, "Obesity, class 3")] if value < upper)
    return {"bmi": round(value, 1), "units": "kg/m²", "category": category}


@calculator(
    "egfr", "eGFR (CKD-EPI 2021)", "Race-free 2021 CKD-EPI creatinine eGFR for adults with age_years, sex (female/male as used by the equation), and creatinine_mg_dl. Require explicit laboratory units. Not for acute kidney injury, pregnancy or drug dosing.",
    {"age_years": (18, 120), "sex": {"female", "male"}, "creatinine_mg_dl": (0.1, 30)},
    "https://www.niddk.nih.gov/research-funding/research-programs/kidney-clinical-research-epidemiology/laboratory/glomerular-filtration-rate-equations/adults",
    "Adults with stable creatinine. An estimate, not a CKD diagnosis. Not validated here for pregnancy, acute kidney injury, or medication dosing.",
)
def compute_egfr(data):
    female = data["sex"] == "female"
    ratio = data["creatinine_mg_dl"] / (0.7 if female else 0.9)
    value = 142 * min(ratio, 1) ** (-0.241 if female else -0.302) * max(ratio, 1) ** -1.2 * 0.9938 ** data["age_years"] * (1.012 if female else 1)
    return {"value": round(value, 1), "units": "mL/min/1.73 m²"}


@calculator(
    "estimated_glucose", "Estimated Average Glucose", "Convert measured HbA1c percent (4–12%) to estimated average glucose; not a current blood glucose measurement. Require percent units, not mmol/mol.",
    {"a1c_percent": (4, 12)}, "https://doi.org/10.2337/dc08-0545",
    "Population estimate from HbA1c; unreliable when A1c is affected by altered red-cell turnover or hemoglobin variants. Not for insulin dosing.",
)
def compute_estimated_glucose(data):
    value = 28.7 * data["a1c_percent"] - 46.7
    return {"value": round(value, 1), "units": "mg/dL", "mmol_l": round(value / 18, 1)}


@calculator(
    "non_hdl_cholesterol", "Non-HDL Cholesterol",
    "Calculate non-HDL as total cholesterol minus HDL from the same lipid panel. Require explicit total_cholesterol, hdl_cholesterol, total_units and hdl_units (mg/dL or mmol/L). Copy shared explicit units to both fields. Do not convert mixed units, estimate LDL, assign risk or recommend medication.",
    {"total_cholesterol": (0.01, 1000), "hdl_cholesterol": (0, 1000),
     "total_units": {"mg/dL", "mmol/L"}, "hdl_units": {"mg/dL", "mmol/L"}},
    "https://medlineplus.gov/cholesterollevelswhatyouneedtoknow.html",
    "Lab arithmetic only, using values from the same panel. Not an LDL measurement, cardiovascular risk estimate, treatment target or medication recommendation.",
)
def compute_non_hdl_cholesterol(data):
    if data["total_units"] != data["hdl_units"]:
        raise ValueError("Total and HDL cholesterol must use the same units.")
    total, hdl = data["total_cholesterol"], data["hdl_cholesterol"]
    if data["total_units"] == "mmol/L" and total > 30:
        raise ValueError("Total cholesterol is outside the supported range; check the units.")
    if hdl > total:
        raise ValueError("HDL cholesterol cannot exceed total cholesterol; check the values and units.")
    return {"value": round(total - hdl, 2), "units": data["total_units"]}


@calculator(
    "unit_conversion", "Measurement Conversion", "Convert an explicitly given measurement and units using conversion: lb_to_kg, in_to_cm, f_to_c, glucose_mg_dl_to_mmol_l, or creatinine_umol_l_to_mg_dl. Never convert drug doses.",
    {"value": (-100, 100000), "conversion": {"lb_to_kg", "in_to_cm", "f_to_c", "glucose_mg_dl_to_mmol_l", "creatinine_umol_l_to_mg_dl"}},
    "https://www.nist.gov/pml/special-publication-811", "Measurement conversion only; interpretation requires clinical context.",
)
def compute_unit_conversion(data):
    value, conversion = data["value"], data["conversion"]
    if conversion != "f_to_c" and value < 0:
        raise ValueError("This measurement cannot be negative.")
    conversions = {"lb_to_kg": (value * 0.45359237, "kg"), "in_to_cm": (value * 2.54, "cm"),
                   "f_to_c": ((value - 32) / 1.8, "°C"), "glucose_mg_dl_to_mmol_l": (value / 18, "mmol/L"),
                   "creatinine_umol_l_to_mg_dl": (value / 88.4, "mg/dL")}
    result, units = conversions[conversion]
    source = TOOL_REGISTRY["egfr"]["source"] if conversion.startswith("creatinine") else TOOL_REGISTRY["estimated_glucose"]["source"] if conversion.startswith("glucose") else TOOL_REGISTRY["unit_conversion"]["source"]
    return {"value": round(result, 3), "units": units, "source": source}


@calculator(
    "pack_years", "Pack-years",
    "Pack-years of smoking from explicit packs_per_day and years_smoked. Require both numbers from the user; convert cigarettes per day to packs only when the user gives the number (20 cigarettes = 1 pack). Never estimate a missing value. Not an eligibility decision or a cancer risk estimate.",
    {"packs_per_day": (0.05, 10), "years_smoked": (0, 100)},
    "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lung-cancer-screening",
    "Arithmetic from supplied smoking history; not an eligibility determination or a cancer risk estimate.",
)
def compute_pack_years(data):
    return {"value": round(float(data["packs_per_day"] * data["years_smoked"]), 1), "units": "pack-years",
            "recommendation": "USPSTF (2021) describes annual low-dose CT screening for adults 50 to 80 with a 20 pack-year history who currently smoke or quit within the past 15 years. Those numbers are a conversation starter for a clinician; this tool does not decide eligibility."}


@calculator(
    "waist_to_height", "Waist-to-height ratio",
    "Waist-to-height ratio for an adult from explicit waist_cm and height_cm. Require both measurements from the user in centimetres; convert inches only when the user states inches (use in_to_cm guidance). Never estimate a missing value. Not a diagnosis.",
    {"waist_cm": (40, 250), "height_cm": (100, 250)},
    "https://www.nice.org.uk/guidance/ng246",
    "Adults; NICE applies it alongside BMI below 35 and not in pregnancy or for children.",
)
def compute_waist_to_height(data):
    if data["waist_cm"] >= data["height_cm"]:
        raise ValueError("Waist must be smaller than height; check the measurements and units.")
    return {"value": round(data["waist_cm"] / data["height_cm"], 2), "units": "ratio",
            "recommendation": "NICE NG246 wording: for adults, keeping waist measurement to less than half of height (a ratio below 0.5) is part of its guidance on central adiposity. This is the guideline's wording, not a diagnosis or a category for you."}
