from __future__ import annotations

import math
import re
from functools import wraps

TOOL_REGISTRY = {}


class ToolError(ValueError):
    """A refusal that carries extra fixed fields (for example `hard_stop`) next to `error`."""

    def __init__(self, message, **extra):
        super().__init__(message)
        self.extra = extra


# Free-text rule: a short label, never a date, phone number or identifier (no run of four digits).
_TEXT_FIRST = "A-Za-z0-9%\u00b5\u03bc"
_TEXT_REST = "A-Za-z0-9 ,.%()/+'\u00b5\u03bc-"


def valid_text(value, max_len, allow_empty=False):
    """Return the stripped text when it satisfies the `("text", max_len)` rule, else None."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return value if allow_empty else None
    if re.search(r"\d{4}", value) or not re.fullmatch(f"[{_TEXT_FIRST}][{_TEXT_REST}]{{0,{max_len - 1}}}", value):
        return None
    return value


def _finite_number(value):
    """True for an int or float inside the double range; never raises (huge JSON ints overflow `math.isfinite`)."""
    if type(value) is int:
        return -1e308 < value < 1e308
    return type(value) is float and math.isfinite(value)


def calculator(key, name, description, inputs, source, scope, guard=None):
    """`guard(data)` runs on the raw inputs before any validation so a fixed safety stop is
    never hidden behind a missing or invalid unrelated field; it may raise `ToolError`."""
    def register(function):
        @wraps(function)
        def run(data):
            base = {"tool": name, "key": key, "source": source, "scope": scope}
            if not isinstance(data, dict):
                return {**base, "error": "Inputs must be an object."}
            try:
                if guard is not None:
                    guard(data)
            except ToolError as exc:
                return {**base, "error": str(exc), **exc.extra}
            missing = [field for field in inputs if data.get(field) is None]
            if missing:
                return {**base, "error": "Required inputs were not supplied.", "missing_inputs": missing}
            clean = {}
            for field, rule in inputs.items():
                value = clean[field] = data[field]
                if isinstance(rule, tuple) and rule[0] == "text":
                    text = valid_text(value, rule[1], len(rule) > 2 and rule[2])
                    valid = text is not None
                    clean[field] = text
                elif rule == "boolean":
                    valid = type(value) is bool or type(value) is int and value in (0, 1)
                elif isinstance(rule, set):
                    valid = isinstance(value, str) and value in rule
                else:
                    low, high = rule
                    valid = _finite_number(value) and low <= value <= high
                if not valid:
                    return {**base, "error": f"Invalid or out-of-range input: {field}."}
            try:
                return {**base, "inputs": dict(clean), **function({**data, **clean})}
            except ToolError as exc:
                return {**base, "error": str(exc), **exc.extra}
            except ValueError as exc:
                return {**base, "error": str(exc)}
        TOOL_REGISTRY[key] = {"name": name, "description": description, "variables": list(inputs),
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


def adag_line():
    """ADAG line for drawing: estimated average glucose at A1c 5 to 12 % in 0.5 steps."""
    return [{"a1c": a1c, "eag": round(28.7 * a1c - 46.7, 1)} for a1c in (5 + 0.5 * step for step in range(15))]


@calculator(
    "estimated_glucose", "Estimated Average Glucose", "Convert measured HbA1c percent (4–12%) to estimated average glucose; not a current blood glucose measurement. Require percent units, not mmol/mol.",
    {"a1c_percent": (4, 12)}, "https://doi.org/10.2337/dc08-0545",
    "Population estimate from HbA1c; unreliable when A1c is affected by altered red-cell turnover or hemoglobin variants. Not for insulin dosing.",
)
def compute_estimated_glucose(data):
    value = 28.7 * data["a1c_percent"] - 46.7
    return {"value": round(value, 1), "units": "mg/dL", "mmol_l": round(value / 18, 1),
            "line": adag_line(), "point": {"a1c": data["a1c_percent"], "eag": round(value, 1)}}


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


LB_PER_KG = 2.2046226
WEIGHT_LIMITS = {"kg": (2, 60), "lb": (4, 132)}


def weight_in_kg_lb(data):
    """Validate `weight` against its own units (the generic range covers both) and return (kg, lb)."""
    low, high = WEIGHT_LIMITS[data["weight_units"]]
    if not low <= data["weight"] <= high:
        raise ValueError("Invalid or out-of-range input: weight.")
    if data["weight_units"] == "kg":
        return data["weight"], data["weight"] * LB_PER_KG
    return data["weight"] / LB_PER_KG, data["weight"]


# Weight bands copied from the American Academy of Pediatrics HealthyChildren dosing tables
# (retrieved 2026-10-25):
#   https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Acetaminophen-for-Fever-and-Pain.aspx
#   https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Ibuprofen-for-Fever-and-Pain.aspx
# Each row is (low_lb, high_lb, amount_ml): the amount printed for that inclusive pound band. The first
# page lists infants' and children's acetaminophen (both 160 mg / 5 mL) with the same amounts, so one
# list serves both. A weight is never used to compute mg/kg here; the tests only sanity-check rows.
CHILD_DOSE_BANDS = {
    "acetaminophen": {
        "160mg/5mL": [(6, 11, 1.25), (12, 17, 2.5), (18, 23, 3.75), (24, 35, 5), (36, 47, 7.5),
                      (48, 59, 10), (60, 71, 12.5), (72, 95, 15)],
    },
    "ibuprofen": {
        "100mg/5mL": [(12, 17, 2.5), (18, 23, 4), (24, 35, 5), (36, 47, 7.5), (48, 59, 10),
                      (60, 71, 12.5), (72, 95, 15)],
        "50mg/1.25mL": [(12, 17, 1.25), (18, 23, 1.875), (24, 35, 2.5), (36, 47, 3.75), (48, 59, 5)],
    },
}
# First pound weight the label table gives no amount for (the next column of the AAP table).
CHILD_DOSE_LIMIT_LB = {"160mg/5mL": 96, "100mg/5mL": 96, "50mg/1.25mL": 60}
CHILD_DOSE_MG_PER_ML = {"160mg/5mL": 32, "100mg/5mL": 20, "50mg/1.25mL": 40}
CHILD_DOSE_RULES = {  # interval hours (low, high), maximum doses in 24 hours
    "acetaminophen": ((4, 4), 5), "ibuprofen": ((6, 8), 4),
}
CHILD_DOSE_SOURCES = {
    "acetaminophen": "https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Acetaminophen-for-Fever-and-Pain.aspx",
    "ibuprofen": "https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Ibuprofen-for-Fever-and-Pain.aspx",
}
CHILD_DOSE_COMBINATION_WARNING = "Many cold, flu, and pain products already contain acetaminophen or ibuprofen. Check every other product for the same ingredient before giving another."
CHILD_DOSE_RECOMMENDATION = ("Use the oral syringe or cup that came in the box, not a kitchen spoon. "
                             "Check every other product your child takes for the same ingredient. "
                             "This is the amount printed for this weight band on the label table, not a prescription for your child.")
CHILD_DOSE_UNDER_TWO_NOTE = "AAP: acetaminophen should not be given to children under 2 years of age without the guidance of a doctor."
CHILD_DOSE_EDGE_NOTE = "This weight is within 1 lb of a band boundary. Confirm the amount with a pharmacist or your child's doctor."


def dose_stop(title, text, urgent=False):
    return ToolError(text, hard_stop={"title": title, "text": text, "urgent": urgent})


INFANT_STOP = ("Baby under 3 months", "A fever in a baby under 3 months needs a same-day call to a clinician; this tool shows no amount.")
IBUPROFEN_STOP = ("Baby under 6 months", "Ibuprofen is not for babies under 6 months unless a clinician directs it; no amount shown.")


def child_dose_guard(data):
    """Age-based stops come first: a missing or unknown concentration must not hide them."""
    age = data.get("age_months")
    if not _finite_number(age) or age < 0:
        return
    if age < 3:
        raise dose_stop(*INFANT_STOP, urgent=True)
    if age < 6 and data.get("medicine") == "ibuprofen":
        raise dose_stop(*IBUPROFEN_STOP)


@calculator(
    "child_dose_check", "Child fever-medicine dose check",
    "Label weight-band amount (US AAP table) of acetaminophen or ibuprofen. Needs medicine, concentration (160mg/5mL, 100mg/5mL, 50mg/1.25mL), weight, weight_units kg or lb, age_months; concentration from user's words. Not a prescription.",
    {"medicine": {"acetaminophen", "ibuprofen"}, "concentration": {"160mg/5mL", "100mg/5mL", "50mg/1.25mL"},
     "weight": (2, 132), "weight_units": {"kg", "lb"}, "age_months": (0, 215)},
    "https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Acetaminophen-for-Fever-and-Pain.aspx",
    "Children 3 months to 11 years in the US; the amount printed on the AAP label table for the weight band, not a calculated or personalised dose. Ibuprofen source: AAP HealthyChildren ibuprofen page.",
    guard=child_dose_guard,
)
def compute_child_dose_check(data):
    medicine, concentration, age = data["medicine"], data["concentration"], data["age_months"]
    if age < 3:
        raise dose_stop(*INFANT_STOP, urgent=True)
    if medicine == "ibuprofen" and age < 6:
        raise dose_stop(*IBUPROFEN_STOP)
    bands = CHILD_DOSE_BANDS[medicine].get(concentration)
    if bands is None:
        raise dose_stop("Concentration does not match", "Concentration does not match the medicine; read it from the Drug Facts label.")
    weight_kg, weight_lb = weight_in_kg_lb(data)
    limit = CHILD_DOSE_LIMIT_LB[concentration]
    if age >= 144 or weight_lb >= limit:
        if concentration == "50mg/1.25mL" and age < 144:
            raise dose_stop("Above the infant drops table", f"The infant drops label table ends at {limit - 1} lb; use the directions on the label of the product you have.")
        raise dose_stop("Above the children's table", "The children's label table ends at 95 lb / 11 years; use the adult directions on the label.")
    if weight_lb < bands[0][0]:
        raise dose_stop("Below the smallest band", "Below the smallest label band; ask a pharmacist or clinician.")
    # A weight between two printed bands (for example 35.5 lb) maps to the lower band.
    low, high, amount = [band for band in bands if band[0] <= weight_lb][-1]
    boundaries = [band[0] for band in bands] + [limit]
    near_edge = any(abs(weight_lb - boundary) <= 1 for boundary in boundaries)
    (interval_low, interval_high), max_doses = CHILD_DOSE_RULES[medicine]
    every = f"{interval_low}" if interval_low == interval_high else f"{interval_low}–{interval_high}"
    notes = []
    if medicine == "acetaminophen" and age < 24:
        notes.append(CHILD_DOSE_UNDER_TWO_NOTE)
    if near_edge:
        notes.append(CHILD_DOSE_EDGE_NOTE)
    return {
        "medicine": medicine, "concentration": concentration,
        "weight_kg": round(weight_kg, 1), "weight_lb": round(weight_lb, 1),
        "band_low_lb": low, "band_high_lb": high,
        "band_low_kg": round(low / LB_PER_KG, 1), "band_high_kg": round(high / LB_PER_KG, 1),
        "amount_ml": amount, "amount_mg": round(amount * CHILD_DOSE_MG_PER_ML[concentration], 1),
        "interval_hours_low": interval_low, "interval_hours_high": interval_high, "max_doses_24h": max_doses,
        "near_band_edge": near_edge, "notes": notes,
        "summary": f"{amount:g} mL every {every} h, at most {max_doses} doses in 24 h; label band {low}–{high} lb",
        "syringe": {"capacity_ml": 5 if amount <= 5 else 10 if amount <= 10 else 15, "amount_ml": amount},
        "combination_warning": CHILD_DOSE_COMBINATION_WARNING, "recommendation": CHILD_DOSE_RECOMMENDATION,
        "source": CHILD_DOSE_SOURCES[medicine],
    }


ORS_RED_FLAGS = [
    "Reduced responsiveness, or more sleepy or irritable than usual",
    "Sunken eyes",
    "Dry mouth or tongue",
    "Reduced skin turgor (skin stays pinched)",
    "Fast heartbeat or fast breathing",
    "Passing urine less often than usual",
    "Blood in the stool",
    "Vomiting everything for more than a few hours",
    "Under 6 months old",
]
ORS_FIXED_LINE = "Clinical dehydration is treated by a clinician, not at home; this tool does not replace that."
ORS_UNDER_SIX_MONTHS = "NICE CG84 lists age under 6 months as a risk factor for dehydration; talk to a clinician today about this illness."


@calculator(
    "ors_planner", "Oral rehydration planner",
    "Oral rehydration volume per watery stool from explicit weight, weight_units (kg or lb) and age_months (1 month or older). Not a dehydration assessment or treatment plan.",
    {"weight": (2, 132), "weight_units": {"kg", "lb"}, "age_months": (0, 215)},
    "https://www.nice.org.uk/guidance/cg84",
    "Maintenance volumes only: NICE CG84 (5 mL/kg after each large watery stool) and CDC MMWR 2003 RR-16 volumes per episode. Not a dehydration assessment or treatment plan.",
)
def compute_ors_planner(data):
    if data["age_months"] < 1:
        raise ToolError("Newborns with vomiting or diarrhoea need a clinician today; no plan shown.")
    weight_kg, _ = weight_in_kg_lb(data)
    per_stool = round(5 * weight_kg)
    cdc = {"low": 60, "high": 120} if weight_kg <= 10 else {"low": 120, "high": 240}
    result = {
        "weight_kg": round(weight_kg, 1), "per_stool_ml": per_stool,
        "per_stool_rule": "NICE CG84: 5 mL/kg after each large watery stool",
        "cdc_per_episode_ml": cdc,
        "cdc_per_episode_rule": "CDC MMWR 2003 RR-16: 60–120 mL per stool or vomit under 10 kg, 120–240 mL over 10 kg",
        "teaspoon_timer": {"ml_per_sip": 5, "seconds_between_low": 60, "seconds_between_high": 120},
        "summary": f"About {per_stool} mL of oral rehydration solution after each large watery stool (5 mL/kg); small sips, 5 mL every 1–2 minutes",
        "red_flags": ORS_RED_FLAGS, "recommendation": ORS_FIXED_LINE,
    }
    if data["age_months"] < 6:
        result["risk_note"] = ORS_UNDER_SIX_MONTHS
    return result


LAB_FACTORS = {  # analyte: {(from_units, to_units): (function, decimals)}
    "glucose": {("mg/dl", "mmol/l"): (lambda v: v / 18.016, 2), ("mmol/l", "mg/dl"): (lambda v: v * 18.016, 1)},
    "cholesterol": {("mg/dl", "mmol/l"): (lambda v: v * 0.02586, 2), ("mmol/l", "mg/dl"): (lambda v: v / 0.02586, 0)},
    "triglycerides": {("mg/dl", "mmol/l"): (lambda v: v * 0.01129, 2), ("mmol/l", "mg/dl"): (lambda v: v / 0.01129, 0)},
    "creatinine": {("mg/dl", "umol/l"): (lambda v: v * 88.4, 1), ("umol/l", "mg/dl"): (lambda v: v / 88.4, 2)},
    "urea_nitrogen": {("mg/dl", "mmol/l"): (lambda v: v * 0.357, 2), ("mmol/l", "mg/dl"): (lambda v: v / 0.357, 1)},
    "hemoglobin": {("g/dl", "g/l"): (lambda v: v * 10, 0), ("g/l", "g/dl"): (lambda v: v / 10, 1)},
    "calcium": {("mg/dl", "mmol/l"): (lambda v: v * 0.2495, 2), ("mmol/l", "mg/dl"): (lambda v: v / 0.2495, 1)},
    "bilirubin": {("mg/dl", "umol/l"): (lambda v: v * 17.104, 1), ("umol/l", "mg/dl"): (lambda v: v / 17.104, 2)},
    "uric_acid": {("mg/dl", "umol/l"): (lambda v: v * 59.48, 0), ("umol/l", "mg/dl"): (lambda v: v / 59.48, 1)},
    "vitamin_d_25oh": {("ng/ml", "nmol/l"): (lambda v: v * 2.496, 1), ("nmol/l", "ng/ml"): (lambda v: v / 2.496, 1)},
    "albumin": {("g/dl", "g/l"): (lambda v: v * 10, 0), ("g/l", "g/dl"): (lambda v: v / 10, 1)},
    "hba1c": {("%", "mmol/mol"): (lambda v: (v - 2.15) * 10.929, 0), ("mmol/mol", "%"): (lambda v: v / 10.929 + 2.15, 1)},
}
LAB_UNIT_LABELS = {"mg/dl": "mg/dL", "mmol/l": "mmol/L", "umol/l": "µmol/L", "g/dl": "g/dL", "g/l": "g/L",
                   "ng/ml": "ng/mL", "nmol/l": "nmol/L", "%": "%", "mmol/mol": "mmol/mol"}
LAB_WORD_HELP = {
    "reactive": "On many reports, 'reactive' means the test detected the thing it looks for. It is not a diagnosis by itself; ask the clinician what follow-up test it needs.",
    "non-reactive": "On many reports, 'non-reactive' means the test did not detect the thing it looks for. Ask the clinician whether any test needs repeating.",
    "h": "'H' is the laboratory's flag that the value is above the range printed on the report.",
    "l": "'L' is the laboratory's flag that the value is below the range printed on the report.",
    "critical": "'Critical' is the laboratory's flag for a value far outside its range that it reports to the ordering clinician quickly. If you see it on your own report and have not been contacted, call the clinician's office.",
    "abnormal": "'Abnormal' is the laboratory's flag that the value is outside the range printed on the report. It does not say why or how much it matters.",
}
LAB_QUESTIONS = ["What does this value mean for me?", "Does this test need to be repeated?", "Does this change anything I do?"]


def _lab_units(units):
    return units.lower().replace("µ", "u").replace("μ", "u").replace(" ", "")


@calculator(
    "lab_result_reader", "Lab result reader",
    "Place a lab value on the range printed on the person's own report. Needs test_name, analyte, value, units, range_kind (between, below, above), range_low, range_high, flag_on_report. No range table. Not an interpretation.",
    {"test_name": ("text", 60),
     "analyte": {"glucose", "cholesterol", "triglycerides", "creatinine", "urea_nitrogen", "hemoglobin", "calcium",
                 "bilirubin", "uric_acid", "vitamin_d_25oh", "albumin", "hba1c", "other"},
     "value": (-1e6, 1e6), "units": ("text", 12), "range_kind": {"between", "below", "above"},
     "range_low": (-1e6, 1e6), "range_high": (-1e6, 1e6), "flag_on_report": ("text", 20, True)},
    "https://www.nist.gov/pml/special-publication-811",
    "Position relative to the range printed on your own report; ranges differ between laboratories; not an interpretation. Conversion factors: NIST SP 811 and the IFCC/NGSP HbA1c master equation.",
)
def compute_lab_result_reader(data):
    kind, low, high, value = data["range_kind"], data["range_low"], data["range_high"], data["value"]
    if kind == "between" and low >= high:
        raise ValueError("For a range with two limits, the low limit must be below the high limit.")
    if kind != "between" and low != high:
        raise ValueError("For a one-sided range, enter the same limit in both range fields.")
    if kind == "between":
        status = "below" if value < low else "above" if value > high else "within"
        position = {"low": low, "high": high, "value": value,
                    "fraction": round(min(max((value - low) / (high - low), -0.5), 1.5), 3)}
    elif kind == "below":  # report prints "< limit"
        status = "within" if value < high else "above"
        position = {"low": None, "high": high, "value": value, "fraction": None}
    else:  # report prints "> limit"
        status = "within" if value > low else "below"
        position = {"low": low, "high": None, "value": value, "fraction": None}
    result = {"analyte": data["analyte"], "status": status, "position": position}
    units = _lab_units(data["units"])
    for (source_units, target_units), (convert, decimals) in LAB_FACTORS.get(data["analyte"], {}).items():
        if units == source_units:
            label = LAB_UNIT_LABELS[target_units]
            result["converted"] = {"value": round(convert(value), decimals), "units": label}
            result["converted_range"] = {
                "low": None if kind == "below" else round(convert(low), decimals),
                "high": None if kind == "above" else round(convert(high), decimals), "units": label}
    flag = data["flag_on_report"].lower()
    result["word_help"] = {"term": data["flag_on_report"], "text": LAB_WORD_HELP[flag]} if flag in LAB_WORD_HELP else None
    result["questions"] = LAB_QUESTIONS
    result["summary"] = {"below": "Below the range printed on the report", "within": "Within the range printed on the report",
                         "above": "Above the range printed on the report"}[status]
    return result


PEAK_FLOW_WORDING = {
    "green": "Green zone in the NHLBI Asthma Action Plan is 80% to 100% of your personal best. The plan says to keep taking the daily medicines written in your own plan.",
    "yellow": "Yellow zone in the NHLBI Asthma Action Plan is 50% to 79% of your personal best, which the plan describes as asthma getting worse. Follow the yellow-zone steps in your own written plan and contact your care team if symptoms do not improve.",
    "red": "Red zone in the NHLBI Asthma Action Plan is below 50% of your personal best, which the plan describes as a medical alert. Follow the red-zone steps in your own written plan and get medical help right away.",
}
PEAK_FLOW_OWN_PLAN = "Use the numbers and medicines in your own written asthma action plan."


@calculator(
    "peak_flow_zone", "Peak-flow zone",
    "Asthma peak-flow zone from explicit personal_best_l_min and today's reading_l_min (litres per minute). Uses the NHLBI zone cut-offs; not a medicine change.",
    {"personal_best_l_min": (50, 900), "reading_l_min": (10, 900)},
    "https://www.nhlbi.nih.gov/resources/asthma-action-plan",
    "People with asthma who know their personal best; NHLBI Asthma Action Plan (2020) zones. Follow your own written plan; no medicine advice.",
)
def compute_peak_flow_zone(data):
    best, reading = data["personal_best_l_min"], data["reading_l_min"]
    if reading > 1.3 * best:
        raise ValueError("The reading is above the recorded personal best by more than 30 %; check the numbers.")
    percent = math.floor(reading / best * 100 + 1e-9)
    zone = "green" if percent >= 80 else "yellow" if percent >= 50 else "red"
    green_low, yellow_low = math.ceil(best * 80 / 100 - 1e-9), math.ceil(best * 50 / 100 - 1e-9)
    zones = [{"label": "green", "low_pct": 80, "high_pct": 100, "low_l_min": green_low, "high_l_min": best},
             {"label": "yellow", "low_pct": 50, "high_pct": 79, "low_l_min": yellow_low, "high_l_min": green_low - 1},
             {"label": "red", "low_pct": 0, "high_pct": 49, "low_l_min": 0, "high_l_min": yellow_low - 1}]
    result = {"value": percent, "units": "% of personal best", "zone": zone, "zones": zones,
              "recommendation": f"{PEAK_FLOW_WORDING[zone]} {PEAK_FLOW_OWN_PLAN}"}
    if zone == "red":
        result["alerts"] = [{"level": "emergency", "text": PEAK_FLOW_WORDING["red"]}]
    return result


HF_THRESHOLDS = {"1_day": {"lb": 2, "kg": 0.9}, "7_days": {"lb": 5, "kg": 2.3}}
HF_WORDING = ("AHA: a gain of 2–3 lb in a day or 5 lb in a week is a reason to contact your care team. "
              "Use the thresholds in your own plan.")
HF_ALERT = "Your weight gain reached the AHA threshold for contacting your care team. Contact them today, using the thresholds in your own plan."


@calculator(
    "hf_weight_zone", "Heart-failure weight check",
    "Weight change for heart failure from weight_now, weight_before, weight_units (kg or lb) and interval (1_day or 7_days). Compares with AHA thresholds; not a medicine change.",
    {"weight_now": (20, 400), "weight_before": (20, 400), "weight_units": {"kg", "lb"}, "interval": {"1_day", "7_days"}},
    "https://www.heart.org/en/health-topics/heart-failure/warning-signs-of-heart-failure/managing-heart-failure-symptoms",
    "Adults with heart failure; AHA weight-gain thresholds. Use the thresholds in your own plan. Not a diagnosis or a medicine change.",
)
def compute_hf_weight_zone(data):
    units, now, before = data["weight_units"], data["weight_now"], data["weight_before"]
    change = round(now - before, 6)
    threshold = HF_THRESHOLDS[data["interval"]]
    if abs(change) > 0.2 * before:
        # No calculated result for an implausible pair, but a gain that would cross the AHA threshold keeps its warning.
        extra = {"alerts": [{"level": "call_today", "text": HF_ALERT}]} if change >= threshold[units] else {}
        raise ToolError("The two weights differ by more than 20 %; check the numbers and units.", **extra)
    zone = "call_team" if change >= threshold[units] else "within"
    change_kg, change_lb = (change, change * LB_PER_KG) if units == "kg" else (change / LB_PER_KG, change)
    result = {"value": round(change, 1), "units": units, "change_kg": round(change_kg, 1), "change_lb": round(change_lb, 1),
              "direction": "gain" if change > 0 else "loss" if change < 0 else "none",
              "threshold": {**threshold, "interval": data["interval"]}, "zone": zone, "recommendation": HF_WORDING}
    if zone == "call_team":
        result["alerts"] = [{"level": "call_today", "text": HF_ALERT}]
    return result


# Wording verified against the CDC STEADI "Stay Independent" brochure
# (https://www.cdc.gov/steadi/pdf/steadi-brochure-stayindependent-508.pdf, checked 2026-10-25).
# The home-hazard list paraphrases the CDC "Check for Safety" brochure.
STEADI_ITEMS = [  # key, CDC wording, points
    ("fallen_past_year", "I have fallen in the past year.", 2),
    ("uses_or_advised_cane_walker", "I use or have been advised to use a cane or walker to get around safely.", 2),
    ("unsteady_walking", "Sometimes I feel unsteady when I am walking.", 1),
    ("steadies_on_furniture", "I steady myself by holding onto furniture when walking at home.", 1),
    ("worried_about_falling", "I am worried about falling.", 1),
    ("pushes_with_hands_to_stand", "I need to push with my hands to stand up from a chair.", 1),
    ("trouble_stepping_up_curb", "I have some trouble stepping up onto a curb.", 1),
    ("rushes_to_toilet", "I often have to rush to the toilet.", 1),
    ("lost_feeling_in_feet", "I have lost some feeling in my feet.", 1),
    ("medicine_causes_lightheaded_or_tired", "I take medication that sometimes makes me feel light-headed or more tired than usual.", 1),
    ("medicine_for_sleep_or_mood", "I take medication to help me sleep or improve my mood.", 1),
    ("often_sad_or_depressed", "I often feel sad or depressed.", 1),
]
STEADI_AT_RISK = "A score of 4 or more means you may be at risk of falling; discuss this with your doctor."
STEADI_BELOW = "A score below 4 is not a statement that you cannot fall."
STEADI_TALK_ANYWAY = "CDC: a fall in the past year, feeling unsteady, or being worried about falling is a reason to talk to your doctor, whatever the score."
STEADI_HAZARDS = [
    "Floors: remove things you can trip over (papers, books, clothes, shoes, cords); remove or tape down small throw rugs; wipe up spills right away.",
    "Stairs: keep them well lit with a light switch at the top and bottom; have handrails on both sides; fix loose or uneven steps; keep them free of clutter.",
    "Kitchen: keep the things you use often on lower shelves, between waist and eye level; use a sturdy step stool with a bar to hold, not a chair.",
    "Bathroom: use a non-slip mat in the tub or shower; have grab bars for the tub, shower, and toilet.",
    "Bedroom: keep a lamp or flashlight within reach of the bed and a night light on the way to the bathroom.",
    "Footwear: wear shoes with non-slip, thin, firm soles inside and outside; avoid walking in socks or loose slippers.",
]


@calculator(
    "steadi_fall_risk", "STEADI fall-risk checklist",
    "CDC STEADI 12-item fall-risk self-screen, only when the person has explicitly answered every item yes or no. Never infer an answer.",
    {key: "boolean" for key, _, _ in STEADI_ITEMS},
    "https://www.cdc.gov/steadi/patient.html",
    "Self-screen published by CDC for patients; not an assessment or diagnosis.",
)
def compute_steadi_fall_risk(data):
    items = [{"key": key, "text": text, "answer": bool(data[key]), "points": points if data[key] else 0}
             for key, text, points in STEADI_ITEMS]
    score = sum(item["points"] for item in items)
    at_risk = score >= 4
    talk_anyway = any(data[key] for key in ("fallen_past_year", "unsteady_walking", "worried_about_falling"))
    return {"score": score, "max_score": 14, "at_risk": at_risk, "talk_anyway": talk_anyway, "items": items,
            "recommendation": STEADI_AT_RISK if at_risk else STEADI_BELOW,
            "talk_anyway_text": STEADI_TALK_ANYWAY if talk_anyway else "",
            "home_hazards": STEADI_HAZARDS}


# Register the percentile tools in the same registry (circular import is intentional and safe).
from app.tools import growth  # noqa: E402,F401
