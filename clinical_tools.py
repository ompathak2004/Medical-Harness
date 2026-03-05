"""
Clinical scoring tools — deterministic Python implementations of validated
medical calculators.

Each tool is registered in TOOL_REGISTRY with:
    - description: what the tool does (used by LLM for selection)
    - variables: list of variable names needed
    - function: callable(dict) -> dict with results

All functions handle missing data gracefully via .get() with defaults.
"""

# ---------------------------------------------------------------------------
# 1. Wells Score for DVT
#    Reference: Wells PS et al. Lancet 1997; validated decision rule.
# ---------------------------------------------------------------------------

def compute_wells_dvt(data: dict) -> dict:
    """Compute the Wells score for Deep Vein Thrombosis."""
    score = 0
    score += 1 if data.get("active_cancer") else 0
    score += 1 if data.get("paralysis_or_cast") else 0
    score += 1 if data.get("bedridden_or_surgery") else 0
    score += 1 if data.get("tenderness_along_veins") else 0
    score += 1 if data.get("entire_leg_swollen") else 0
    score += 1 if data.get("calf_swelling_gt_3cm") else 0
    score += 1 if data.get("pitting_edema") else 0
    score += 1 if data.get("collateral_superficial_veins") else 0
    score += 1 if data.get("previous_dvt") else 0
    score -= 2 if data.get("alternative_diagnosis_likely") else 0

    if score >= 3:
        risk = "High"
        recommendation = "DVT is likely. Consider imaging (ultrasound) and anticoagulation pending results."
    elif score >= 1:
        risk = "Moderate"
        recommendation = "Moderate probability. Consider D-dimer testing; if positive, proceed to imaging."
    else:
        risk = "Low"
        recommendation = "DVT is unlikely. D-dimer test can help rule it out."

    return {
        "tool": "Wells Score (DVT)",
        "score": score,
        "risk": risk,
        "recommendation": recommendation,
    }


# ---------------------------------------------------------------------------
# 2. CHA2DS2-VASc Score
#    Reference: Lip GY et al. Chest 2010; stroke risk in atrial fibrillation.
# ---------------------------------------------------------------------------

def compute_cha2ds2_vasc(data: dict) -> dict:
    """Compute CHA2DS2-VASc score for stroke risk in atrial fibrillation."""
    score = 0
    score += 1 if data.get("congestive_heart_failure") else 0
    score += 1 if data.get("hypertension") else 0
    score += 2 if data.get("age_75_or_older") else (1 if data.get("age_65_to_74") else 0)
    score += 1 if data.get("diabetes") else 0
    score += 2 if data.get("stroke_or_tia_history") else 0
    score += 1 if data.get("vascular_disease") else 0
    score += 1 if data.get("sex_female") else 0

    if score == 0:
        risk = "Low"
        recommendation = "Low stroke risk. Anticoagulation generally not recommended."
    elif score == 1:
        risk = "Low-Moderate"
        recommendation = "Consider anticoagulation or antiplatelet therapy based on individual risk-benefit."
    else:
        risk = "Moderate-High"
        recommendation = f"Score {score}: Anticoagulation (e.g. DOAC or warfarin) is generally recommended."

    return {
        "tool": "CHA2DS2-VASc Score",
        "score": score,
        "risk": risk,
        "recommendation": recommendation,
    }


# ---------------------------------------------------------------------------
# 3. Framingham Risk Score (simplified 10-year CVD risk)
#    Reference: Wilson PWF et al. Circulation 1998.
#    This is a simplified point-based estimation.
# ---------------------------------------------------------------------------

def _framingham_age_points(age: int, sex: str) -> int:
    """Age points for Framingham (simplified)."""
    if sex == "male":
        if age < 35:
            return -1
        elif age <= 39:
            return 0
        elif age <= 44:
            return 1
        elif age <= 49:
            return 2
        elif age <= 54:
            return 3
        elif age <= 59:
            return 4
        elif age <= 64:
            return 5
        elif age <= 69:
            return 6
        elif age <= 74:
            return 7
        else:
            return 8
    else:  # female
        if age < 35:
            return -9
        elif age <= 39:
            return -4
        elif age <= 44:
            return 0
        elif age <= 49:
            return 3
        elif age <= 54:
            return 6
        elif age <= 59:
            return 7
        elif age <= 64:
            return 8
        elif age <= 69:
            return 8
        elif age <= 74:
            return 8
        else:
            return 8


def compute_framingham(data: dict) -> dict:
    """Compute simplified Framingham 10-year CVD risk score."""
    age = int(data.get("age", 50))
    sex = str(data.get("sex", "male")).lower()

    points = _framingham_age_points(age, sex)

    # Total cholesterol points (simplified)
    tc = int(data.get("total_cholesterol", 200))
    if tc < 160:
        points += 0
    elif tc <= 199:
        points += 1
    elif tc <= 239:
        points += 2
    elif tc <= 279:
        points += 3
    else:
        points += 4

    # HDL cholesterol
    hdl = int(data.get("hdl_cholesterol", 50))
    if hdl >= 60:
        points -= 2
    elif hdl >= 50:
        points -= 1
    elif hdl >= 40:
        points += 0
    else:
        points += 2

    # Systolic blood pressure
    sbp = int(data.get("systolic_bp", 120))
    treated = data.get("bp_treated", False)
    if sbp < 120:
        points += 0
    elif sbp <= 129:
        points += 1 if treated else 0
    elif sbp <= 139:
        points += 2 if treated else 1
    elif sbp <= 159:
        points += 3 if treated else 2
    else:
        points += 4 if treated else 3

    # Smoking
    if data.get("smoker"):
        points += 4 if sex == "male" else 7

    # Diabetes
    if data.get("diabetes"):
        points += 3 if sex == "male" else 4

    # Point-to-risk mapping (simplified, approximate)
    risk_map_male = {
        -3: 1, -2: 1, -1: 2, 0: 3, 1: 4, 2: 4, 3: 6, 4: 7,
        5: 9, 6: 11, 7: 14, 8: 18, 9: 22, 10: 27, 11: 33, 12: 40,
    }
    risk_map_female = {
        -2: 1, -1: 1, 0: 2, 1: 2, 2: 3, 3: 4, 4: 4, 5: 5,
        6: 6, 7: 7, 8: 8, 9: 9, 10: 11, 11: 13, 12: 15, 13: 17,
        14: 20, 15: 24, 16: 27,
    }
    risk_map = risk_map_male if sex == "male" else risk_map_female

    clamped = max(min(points, max(risk_map.keys())), min(risk_map.keys()))
    risk_percent = risk_map.get(clamped, 30)

    if risk_percent < 10:
        category = "Low"
    elif risk_percent < 20:
        category = "Moderate"
    else:
        category = "High"

    return {
        "tool": "Framingham Risk Score",
        "points": points,
        "ten_year_risk_percent": risk_percent,
        "risk": category,
        "recommendation": f"Estimated 10-year cardiovascular disease risk: {risk_percent}% ({category}).",
    }


# ---------------------------------------------------------------------------
# 4. MRC Muscle Strength Grading
#    Reference: Medical Research Council, standard 0-5 scale.
# ---------------------------------------------------------------------------

def compute_mrc_grade(data: dict) -> dict:
    """Evaluate MRC muscle strength grade (0-5)."""
    grade = int(data.get("grade", 0))
    grade = max(0, min(5, grade))

    descriptions = {
        0: "No contraction",
        1: "Flicker or trace contraction",
        2: "Active movement with gravity eliminated",
        3: "Active movement against gravity",
        4: "Active movement against gravity and resistance",
        5: "Normal strength",
    }

    return {
        "tool": "MRC Muscle Strength",
        "grade": grade,
        "description": descriptions[grade],
    }


# ---------------------------------------------------------------------------
# Tool Registry
# ---------------------------------------------------------------------------

TOOL_REGISTRY = {
    "wells_dvt": {
        "description": "Wells score for Deep Vein Thrombosis (DVT) risk stratification. Use when a patient reports leg pain, swelling, calf pain, or risk factors for blood clots.",
        "variables": [
            "active_cancer", "paralysis_or_cast", "bedridden_or_surgery",
            "tenderness_along_veins", "entire_leg_swollen", "calf_swelling_gt_3cm",
            "pitting_edema", "collateral_superficial_veins", "previous_dvt",
            "alternative_diagnosis_likely",
        ],
        "function": compute_wells_dvt,
    },
    "cha2ds2_vasc": {
        "description": "CHA2DS2-VASc score for stroke risk in atrial fibrillation. Use when a patient has atrial fibrillation or irregular heartbeat and needs stroke risk assessment.",
        "variables": [
            "congestive_heart_failure", "hypertension", "age_75_or_older",
            "age_65_to_74", "diabetes", "stroke_or_tia_history",
            "vascular_disease", "sex_female",
        ],
        "function": compute_cha2ds2_vasc,
    },
    "framingham": {
        "description": "Framingham Risk Score for 10-year cardiovascular disease risk. Use when assessing general heart disease risk based on age, cholesterol, blood pressure, smoking, and diabetes.",
        "variables": [
            "age", "sex", "total_cholesterol", "hdl_cholesterol",
            "systolic_bp", "bp_treated", "smoker", "diabetes",
        ],
        "function": compute_framingham,
    },
    "mrc_muscle": {
        "description": "MRC muscle strength grading (0-5 scale). Use when assessing muscle weakness or neurological symptoms affecting strength.",
        "variables": ["grade"],
        "function": compute_mrc_grade,
    },
}
