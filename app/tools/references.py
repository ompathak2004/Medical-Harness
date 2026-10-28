from __future__ import annotations

import asyncio
import html
import re
from uuid import UUID

import httpx

from app.config import get_settings
from app.transport import CircuitBreaker
from app.streaming import bounded_json

REFERENCE_TOOLS = {
    "drug_labels": {
        "description": "Find official US DailyMed label links for one explicitly named medicine. Extract only its generic or brand name as query. This retrieves titles and links, not label contents, approval status, interactions, or dosing advice.",
        "variables": ["query"],
        "name": "DailyMed medicine labels",
        "source": "https://dailymed.nlm.nih.gov/",
        "scope": "US label directory. Match the exact product and formulation with a pharmacist. Label contents and interactions have not been checked.",
    },
    "pubmed_search": {
        "description": "Find PubMed-indexed research abstracts through Europe PMC when the user explicitly asks for studies or research. Extract a short query of medical topic terms only. Never include names, identifiers, personal details, or the conversation. Abstracts are not clinical guidelines.",
        "variables": ["query"],
        "name": "PubMed research lookup",
        "source": "https://europepmc.org/",
        "scope": "PubMed-indexed abstracts, not a systematic review. Study applicability and quality require review.",
    },
    "label_sections": {
        "description": "Quote official US FDA label sections (boxed warning, indications, contraindications, warnings, adverse reactions) for one explicitly named medicine. Extract only its generic or brand name as query. US labels only; not personalized; not an interaction check; not dosing advice. Combination products are flagged, not quoted.",
        "variables": ["query"],
        "name": "FDA label sections",
        "source": "https://open.fda.gov/apis/drug/label/",
        "scope": "US label for the exact product named in the result. Not personalized, not an interaction check, not dosing advice. Confirm the product and formulation with a pharmacist.",
    },
}

OPENFDA_LABEL_URL = "https://api.fda.gov/drug/label.json"
# Full labels run 100-300 KiB each, so the label request has its own byte budget.
OPENFDA_LABEL_LIMIT = 5
OPENFDA_LABEL_MAX_BYTES = 2 * 1024 * 1024
LABEL_RATE_LIMIT_ERROR = "The label service rate limit was reached. Try again in a minute."
LABEL_COMBINATION_ERROR = "Only combination products matched this name. Label sections are not shown because a combination product is not the same medicine."
LABEL_UNVERIFIED_ERROR = "No label could be confirmed as a single-ingredient product for this name. Label sections are not shown."
LABEL_SECTIONS = (
    ("boxed_warning", "Boxed warning"),
    ("indications_and_usage", "Indications and usage"),
    ("contraindications", "Contraindications"),
    ("warnings_and_precautions", "Warnings and precautions"),
    ("warnings", "Warnings"),
    ("adverse_reactions", "Adverse reactions"),
)


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    return " ".join(html.unescape(re.sub(r"<[^>]*>", " ", value)).split())[:limit]


class ReferenceTools:
    def __init__(self, client=None):
        self.client = client or httpx.AsyncClient(timeout=8, follow_redirects=False,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4))
        self.circuits = {key: CircuitBreaker() for key in REFERENCE_TOOLS}

    async def run(self, key, variables):
        info = REFERENCE_TOOLS[key]
        result = {"tool": info["name"], "source": info["source"], "scope": info["scope"], "items": []}
        query = variables.get("query")
        if not isinstance(query, str) or not re.fullmatch(r"[A-Za-z][A-Za-z -]{1,79}", query):
            return {**result, "status": "unavailable", "error": "A short medicine name or medical topic is required."}
        circuit = self.circuits[key]
        try:
            circuit.acquire()
        except Exception:
            return {**result, "status": "unavailable", "error": "Reference provider temporarily unavailable."}
        try:
            async with asyncio.timeout(8):
                if key == "label_sections":
                    label = await self._label_sections(query.strip())
                    items = label.pop("items")
                    result = {**result, **label}
                elif key == "drug_labels":
                    payload = await self._get("https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json",
                        {"drug_name": query.strip(), "pagesize": 3, "page": 1})
                    items = self._labels(payload)
                else:
                    terms = " AND ".join(f'"{term}"' for term in query.lower().split())
                    payload = await self._get("https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                        {"query": f"({terms}) AND SRC:MED AND HAS_ABSTRACT:Y", "format": "json", "resultType": "core", "pageSize": 3})
                    items = self._papers(payload)
            circuit.success()
            return {**result, "status": "available" if items else "empty", "items": items}
        except asyncio.CancelledError:
            circuit.cancel()
            raise
        except Exception as exc:
            circuit.failure()
            if key == "label_sections" and isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
                return {**result, "status": "unavailable", "error": LABEL_RATE_LIMIT_ERROR}
            return {**result, "status": "unavailable", "error": "Reference lookup could not be completed. No conclusion can be drawn from missing results."}

    async def _get(self, url, params, not_found_ok=False, max_bytes=262144):
        async with self.client.stream("GET", url, params=params) as response:
            if not_found_ok and response.status_code == 404:
                return None
            response.raise_for_status()
            payload = await bounded_json(response, max_bytes=max_bytes)
        if not isinstance(payload, dict):
            raise ValueError("Invalid reference response")
        return payload

    async def _label_sections(self, query):
        api_key = get_settings().openfda_api_key
        payload = None
        for field in ("generic_name", "brand_name"):
            params = {"search": f'openfda.{field}:"{query}"', "sort": "effective_time:desc", "limit": OPENFDA_LABEL_LIMIT}
            if api_key:
                params["api_key"] = api_key
            payload = await self._get(OPENFDA_LABEL_URL, params, not_found_ok=True, max_bytes=OPENFDA_LABEL_MAX_BYTES)
            if payload is not None:
                break
        rows = payload.get("results", []) if payload else []
        rows = [row for row in rows if isinstance(row, dict) and self._set_id(row)] if isinstance(rows, list) else []
        row = self._select_label(rows, query)
        if row is None:
            if any(self._ingredient_count(r) > 1 for r in rows):
                return {"items": [], "combination_only": True, "error": LABEL_COMBINATION_ERROR}
            if rows:
                return {"items": [], "error": LABEL_UNVERIFIED_ERROR}
            return {"items": []}
        openfda = row["openfda"]
        generic = clean_text(openfda["generic_name"][0], 120)
        set_id = self._set_id(row)
        url = f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={set_id}"
        effective = str(row.get("effective_time", ""))
        effective_time = f"{effective[:4]}-{effective[4:6]}-{effective[6:8]}" if re.fullmatch(r"[0-9]{8}", effective) else ""
        brand = self._first(openfda.get("brand_name"))
        form = self._first(openfda.get("dosage_form"))
        product = clean_text(" ".join(part for part in (brand or generic, form.lower() if form else "") if part), 160)
        items = []
        for key, title in LABEL_SECTIONS:
            if key == "warnings" and row.get("warnings_and_precautions"):
                continue  # OTC-style "warnings" only when the full section is absent
            values = row.get(key)
            values = [values] if isinstance(values, str) else values if isinstance(values, list) else []
            text = clean_text(" ".join(value for value in values if isinstance(value, str)), 1000)
            if text:
                items.append({"title": f"{generic} label: {title}", "section": key, "url": url,
                              "year": effective[:4] if effective_time else "", "journal": "US FDA label (openFDA)",
                              "tldr": text, "source": "openFDA", "evidence_kind": "label_section"})
        return {"items": items, "product": product, "generic_name": generic, "effective_time": effective_time,
                "set_id": set_id, "url": url, "has_interactions_section": bool(row.get("drug_interactions"))}

    @staticmethod
    def _first(value):
        return clean_text(value[0], 80) if isinstance(value, list) and value else ""

    @staticmethod
    def _set_id(row):
        try:
            return str(UUID(row.get("set_id", "")))
        except (ValueError, TypeError, AttributeError):
            return ""

    @staticmethod
    def _ingredient_count(row):
        """Active ingredients the metadata establishes: 1 for a single-ingredient label, >1 for a confirmed
        combination, 0 when the metadata is missing or ambiguous (treated as unverified, never as single)."""
        openfda = row.get("openfda")
        if not isinstance(openfda, dict):
            return 0
        generic, substances = openfda.get("generic_name"), openfda.get("substance_name")
        names = [g for g in generic if isinstance(g, str)] if isinstance(generic, list) else []
        subs = [v for v in substances if isinstance(v, str)] if isinstance(substances, list) else []
        if len(names) > 1 or len(subs) > 1 or any(re.search(r",|;|/| AND | WITH | PLUS ", f" {n.upper()} ") for n in names):
            return 2
        return 1 if len(names) == 1 and len(subs) == 1 else 0

    @staticmethod
    def _single_ingredient(openfda):
        return ReferenceTools._ingredient_count({"openfda": openfda}) == 1

    @staticmethod
    def _select_label(rows, query):
        """Pick one single-ingredient label: exact name match first, then the earliest (newest) row."""
        name = " ".join(query.upper().split())
        pattern = re.compile(rf"(?<![A-Z0-9]){re.escape(name)}(?![A-Z0-9])")
        matches = []
        for row in rows:
            openfda = row.get("openfda")
            if not isinstance(openfda, dict) or not ReferenceTools._single_ingredient(openfda):
                continue
            generic = openfda["generic_name"]
            names = [generic[0].upper()] + [value.upper() for value in openfda.get("brand_name", []) if isinstance(value, str)]
            if any(pattern.search(value) for value in names):
                matches.append((row, name in names))
        return next((row for row, exact in matches if exact), matches[0][0] if matches else None)

    @staticmethod
    def _labels(payload):
        items = []
        for row in payload.get("data", [])[:3]:
            if not isinstance(row, dict):
                continue
            try:
                identifier = str(UUID(row.get("setid", "")))
            except (ValueError, TypeError, AttributeError):
                continue
            title = clean_text(row.get("title"), 240)
            if title:
                items.append({"title": title, "url": f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={identifier}",
                              "published": clean_text(row.get("published_date"), 30)})
        return items

    @staticmethod
    def _papers(payload):
        items = []
        for row in payload.get("resultList", {}).get("result", [])[:3]:
            if not isinstance(row, dict):
                continue
            identifier = str(row.get("id", ""))
            title = clean_text(row.get("title"), 240)
            abstract = clean_text(row.get("abstractText"), 1800)
            if row.get("source") != "MED" or not re.fullmatch(r"[0-9]{1,10}", identifier) or not title or not abstract:
                continue
            journal = row.get("journalInfo", {}).get("journal", {})
            items.append({"title": title, "url": f"https://pubmed.ncbi.nlm.nih.gov/{identifier}/",
                          "year": clean_text(row.get("pubYear"), 4), "journal": clean_text(journal.get("title"), 120),
                          "tldr": abstract, "source": "Europe PMC / PubMed", "evidence_kind": "abstract"})
        return items

    async def aclose(self):
        await self.client.aclose()
