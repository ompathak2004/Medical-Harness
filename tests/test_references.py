import asyncio
import logging
import re
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from app.tools.references import (
    LABEL_COMBINATION_ERROR, LABEL_RATE_LIMIT_ERROR, LABEL_UNVERIFIED_ERROR, REFERENCE_TOOLS, RXNORM_RATE_LIMIT_ERROR, ReferenceTools,
)
from tests.test_pipeline import make_pipeline, FakeEvidence


async def lookup(key, payload, query="metformin", status=200):
    requests = []
    async def handler(request):
        requests.append(request)
        return httpx.Response(status, json=payload)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    tools = ReferenceTools(client)
    try:
        return await tools.run(key, {"query": query}), requests
    finally:
        await tools.aclose()


async def test_labels_use_validated_set_ids_and_do_not_claim_full_label_contents():
    result, requests = await lookup("drug_labels", {"data": [
        {"setid": "fdbfe194-b845-42c5-bb87-a48118bc72e7", "title": "<b>METFORMIN</b>", "published_date": "Oct 01, 2026"},
        {"setid": "https://evil.invalid/", "title": "Fake"}]})
    assert result["status"] == "available"
    assert len(result["items"]) == 1
    assert result["items"][0]["title"] == "METFORMIN"
    assert result["items"][0]["url"].startswith("https://dailymed.nlm.nih.gov/")
    assert "not been checked" in result["scope"]
    assert requests[0].url.params["drug_name"] == "metformin"


async def test_literature_keeps_only_pubmed_records_with_abstracts():
    result, requests = await lookup("pubmed_search", {"resultList": {"result": [
        {"id": "123456", "source": "MED", "title": "A study", "abstractText": "<p>Abstract &amp; limitations</p>", "pubYear": "2025"},
        {"id": "789", "source": "PPR", "title": "Preprint", "abstractText": "Text"},
        {"id": "123", "source": "MED", "title": "No abstract"}]}}, "diabetes exercise")
    assert result["items"][0]["tldr"] == "Abstract & limitations"
    assert result["items"][0]["url"] == "https://pubmed.ncbi.nlm.nih.gov/123456/"
    assert len(result["items"]) == 1
    assert requests[0].url.params["query"] == '("diabetes" AND "exercise") AND SRC:MED AND HAS_ABSTRACT:Y'


@pytest.mark.parametrize("query", ["https://internal", "name@example.com", "x" * 81, 12, "diabetes OR SRC:PPR", "DOB 1990-01-01"])
async def test_invalid_reference_queries_make_no_network_request(query):
    result, requests = await lookup("drug_labels", {}, query)
    assert result["status"] == "unavailable"
    assert not requests


@pytest.mark.parametrize("payload,status", [({}, 503), ({"data": None}, 200), ([], 200), ({"huge": "x" * 270000}, 200)])
async def test_provider_failures_are_explicit(payload, status):
    result, _ = await lookup("drug_labels", payload, status=status)
    assert result["status"] == "unavailable"
    assert result["items"] == []


async def test_empty_results_are_not_a_no_risk_claim():
    result, _ = await lookup("drug_labels", {"data": []})
    assert result["status"] == "empty"
    assert "interactions have not been checked" in result["scope"]


SET_ID = "fdbfe194-b845-42c5-bb87-a48118bc72e7"
COMBO_SET_ID = "0b6c6d4c-2f7e-4b7e-9c43-6d0d2c1b1a11"


def label_row(generic=("METFORMIN HYDROCHLORIDE",), set_id=SET_ID, effective="20250314", substances=None, **sections):
    if substances is None:
        substances = [part.strip() for name in generic for part in re.split(r" AND |,", name)]
    return {"set_id": set_id, "effective_time": effective,
            "openfda": {"generic_name": list(generic), "substance_name": substances, "brand_name": ["Glucophage"],
                        "dosage_form": ["TABLET"]}, **sections}


async def label_lookup(responder, query="metformin", api_key="", tools=None):
    requests = []
    async def handler(request):
        requests.append(request)
        return responder(request)
    tools = tools or ReferenceTools(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    settings = SimpleNamespace(openfda_api_key=api_key)
    with patch("app.tools.references.get_settings", return_value=settings):
        return await tools.run("label_sections", {"query": query}), requests, tools


async def test_label_sections_select_single_ingredient_over_newer_combination():
    long_text = "<p>Lactic &amp; acidosis. " + "x" * 2000 + "</p>"
    payload = {"results": [
        label_row(("METFORMIN HYDROCHLORIDE AND SITAGLIPTIN",), COMBO_SET_ID, "20260101", boxed_warning=["Combo warning"]),
        {"set_id": "not-a-uuid", "openfda": {"generic_name": ["METFORMIN HYDROCHLORIDE"]}, "boxed_warning": ["bad"]},
        label_row(boxed_warning=[long_text], indications_and_usage=["Glycemic control", "in adults"],
                  contraindications=["Severe renal impairment"], warnings=["OTC warning"],
                  warnings_and_precautions=["Lactic acidosis"], adverse_reactions=["Diarrhea"],
                  drug_interactions=["Do not quote this text"]),
    ]}
    result, requests, tools = await label_lookup(lambda request: httpx.Response(200, json=payload))
    await tools.aclose()
    assert result["tool"] == "FDA label sections"
    assert result["status"] == "available"
    assert result["generic_name"] == "METFORMIN HYDROCHLORIDE"
    assert result["product"] == "Glucophage tablet"
    assert result["effective_time"] == "2025-03-14"
    assert result["set_id"] == SET_ID
    assert result["url"] == f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={SET_ID}"
    assert result["has_interactions_section"] is True
    assert [item["section"] for item in result["items"]] == [
        "boxed_warning", "indications_and_usage", "contraindications", "warnings_and_precautions", "adverse_reactions"]
    first = result["items"][0]
    assert first["title"] == "METFORMIN HYDROCHLORIDE label: Boxed warning"
    assert first["tldr"].startswith("Lactic & acidosis. xxx")
    assert len(first["tldr"]) == 1000
    assert result["items"][1]["tldr"] == "Glycemic control in adults"
    assert {item["url"] for item in result["items"]} == {result["url"]}
    assert all(item["year"] == "2025" and item["journal"] == "US FDA label (openFDA)" and item["source"] == "openFDA"
               and item["evidence_kind"] == "label_section" for item in result["items"])
    assert "Do not quote this text" not in str(result)
    assert len(requests) == 1
    params = requests[0].url.params
    assert str(requests[0].url).startswith("https://api.fda.gov/drug/label.json")
    assert params["search"] == 'openfda.generic_name:"metformin"'
    assert params["sort"] == "effective_time:desc"
    assert params["limit"] == "5"


async def test_label_sections_use_warnings_for_otc_labels_and_report_no_interactions_section():
    payload = {"results": [label_row(warnings=["Ask a doctor before use"], indications_and_usage=["Pain relief"])]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload))
    await tools.aclose()
    assert [item["section"] for item in result["items"]] == ["indications_and_usage", "warnings"]
    assert result["items"][1]["title"].endswith("label: Warnings")
    assert result["has_interactions_section"] is False


async def test_label_sections_prefer_exact_generic_name_then_earliest_row():
    payload = {"results": [
        label_row(("METFORMIN HYDROCHLORIDE",), SET_ID, "20260101", warnings=["Salt"]),
        label_row(("METFORMIN",), COMBO_SET_ID, "20240101", warnings=["Exact"]),
    ]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload))
    await tools.aclose()
    assert result["set_id"] == COMBO_SET_ID
    assert result["items"][0]["tldr"] == "Exact"


async def test_label_sections_combination_only_is_empty_and_flagged():
    payload = {"results": [label_row(("METFORMIN HYDROCHLORIDE AND SITAGLIPTIN",), COMBO_SET_ID, warnings=["Combo"]),
                           label_row(("METFORMIN HYDROCHLORIDE", "GLIPIZIDE"), COMBO_SET_ID, warnings=["Combo two"])]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload))
    await tools.aclose()
    assert result["status"] == "empty"
    assert result["combination_only"] is True
    assert result["error"] == LABEL_COMBINATION_ERROR
    assert result["items"] == []
    assert "set_id" not in result


async def test_label_sections_not_found_is_empty_after_brand_fallback():
    result, requests, tools = await label_lookup(lambda request: httpx.Response(404, json={"error": {"code": "NOT_FOUND"}}))
    assert result["status"] == "empty"
    assert result["items"] == []
    assert "error" not in result
    assert [request.url.params["search"] for request in requests] == [
        'openfda.generic_name:"metformin"', 'openfda.brand_name:"metformin"']
    assert tools.circuits["label_sections"].failures == 0
    await tools.aclose()


async def test_label_sections_brand_fallback_only_after_generic_not_found():
    def responder(request):
        if "generic_name" in request.url.params["search"]:
            return httpx.Response(404, json={})
        return httpx.Response(200, json={"results": [label_row(("METFORMIN HYDROCHLORIDE",), warnings=["Brand label"])]})
    result, requests, tools = await label_lookup(responder, query="Glucophage")
    await tools.aclose()
    assert result["status"] == "available"
    assert result["items"][0]["tldr"] == "Brand label"
    assert len(requests) == 2
    assert requests[1].url.params["search"] == 'openfda.brand_name:"Glucophage"'
    _, requests, tools = await label_lookup(lambda request: httpx.Response(200, json={"results": []}))
    await tools.aclose()
    assert len(requests) == 1


async def test_label_sections_rate_limit_is_unavailable_and_counts_toward_circuit():
    result, requests, tools = await label_lookup(lambda request: httpx.Response(429, json={}))
    assert result["status"] == "unavailable"
    assert result["error"] == LABEL_RATE_LIMIT_ERROR
    assert tools.circuits["label_sections"].failures == 1
    assert len(requests) == 1
    for _ in range(2):
        await label_lookup(None, tools=tools)
    assert tools.circuits["label_sections"].opened_at is not None
    assert len(requests) == 3
    result, _, _ = await label_lookup(None, tools=tools)
    assert result["error"] == "Reference provider temporarily unavailable."
    assert len(requests) == 3
    await tools.aclose()


async def test_label_sections_server_error_is_generic_unavailable():
    result, _, tools = await label_lookup(lambda request: httpx.Response(503, json={}))
    await tools.aclose()
    assert result["status"] == "unavailable"
    assert result["error"] != LABEL_RATE_LIMIT_ERROR
    assert result["items"] == []


async def test_label_sections_send_api_key_only_when_configured():
    def ok(request):
        return httpx.Response(200, json={"results": []})
    _, without_key, tools = await label_lookup(ok)
    await tools.aclose()
    assert "api_key" not in without_key[0].url.params
    _, with_key, tools = await label_lookup(ok, api_key="fake-openfda-key")
    await tools.aclose()
    assert with_key[0].url.params["api_key"] == "fake-openfda-key"


@pytest.mark.parametrize("query", ["https://internal", "name@example.com", "x" * 81, 12, 'metformin" OR openfda.brand_name:"x'])
async def test_label_sections_invalid_queries_make_no_network_request(query):
    result, requests, tools = await label_lookup(lambda request: httpx.Response(200, json={}), query=query)
    await tools.aclose()
    assert result["status"] == "unavailable"
    assert not requests


def test_label_tool_registry_entry_and_settings_hide_key():
    info = REFERENCE_TOOLS["label_sections"]
    assert info["name"] == "FDA label sections"
    assert info["variables"] == ["query"]
    assert info["source"] == "https://open.fda.gov/apis/drug/label/"
    from app.config import Settings
    assert "fake-openfda-key" not in repr(Settings(openfda_api_key="fake-openfda-key"))


async def test_cancellation_propagates():
    async def handler(request):
        raise asyncio.CancelledError
    service = ReferenceTools(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(asyncio.CancelledError):
        await service.run("drug_labels", {"query": "metformin"})
    assert service.circuits["drug_labels"].failures == 0
    await service.aclose()


async def test_research_can_supply_sources_when_primary_retrieval_fails():
    class References:
        calls = 0
        async def run(self, key, variables):
            self.calls += 1
            return {"tool": "PubMed research lookup", "status": "available", "items": [
                {"title": "Research", "tldr": "An abstract", "url": "https://pubmed.ncbi.nlm.nih.gov/123/"}]}
    pipeline = make_pipeline({"action": "answer"}, tools={"selected_tools": ["pubmed_search"]}, extract={"query": "diabetes exercise"})
    pipeline.evidence = FakeEvidence(articles=[])
    pipeline.references = References()
    result = await pipeline.run(["Find research on exercise and diabetes"], "test")
    assert result["evidence_status"] == "available"
    assert result["articles"][0]["title"] == "Research"
    await pipeline.run(["Find research on exercise and diabetes"], "test")
    assert pipeline.references.calls == 1
    await pipeline.aclose()


async def test_emergency_never_calls_reference_tools():
    class NoReferences:
        async def run(self, *args):
            raise AssertionError("Emergency must skip retrieval")
    pipeline = make_pipeline({"action": "emergency"}, tools={"selected_tools": ["drug_labels"]})
    pipeline.references = NoReferences()
    result = await pipeline.run(["Synthetic emergency"], "test")
    assert result["emergency"] is True
    assert not result["tool_results"]


async def test_label_sections_fail_closed_on_comma_combinations_and_missing_substances():
    payload = {"results": [
        label_row(("ACETAMINOPHEN, ASPIRIN, CAFFEINE",), COMBO_SET_ID, "20260101", warnings=["Combo"]),
        label_row(("ACETAMINOPHEN",), SET_ID, "20250101", substances=["ACETAMINOPHEN", "CAFFEINE"], warnings=["Two substances"]),
        label_row(("ACETAMINOPHEN",), SET_ID, "20240101", substances=[], warnings=["No substances"]),
    ]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload), query="acetaminophen")
    await tools.aclose()
    assert result["status"] == "empty"
    assert result["combination_only"] is True


async def test_label_sections_with_only_unverified_metadata_are_empty_but_not_combination_only():
    payload = {"results": [label_row(("ACETAMINOPHEN",), SET_ID, "20240101", substances=[], warnings=["No substances"])]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload), query="acetaminophen")
    await tools.aclose()
    assert result["status"] == "empty"
    assert "combination_only" not in result
    assert result["error"] == LABEL_UNVERIFIED_ERROR
    assert result["items"] == []


async def test_label_sections_accept_full_size_labels_within_their_own_budget():
    row = label_row(warnings=["Big label"], description=["x" * 600_000])
    payload = {"results": [row]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload))
    await tools.aclose()
    assert result["status"] == "available"
    assert result["items"][0]["tldr"] == "Big label"


async def test_label_sections_still_reject_payloads_over_the_label_budget():
    payload = {"results": [label_row(warnings=["Big"], description=["x" * (2 * 1024 * 1024 + 10)])]}
    result, _, tools = await label_lookup(lambda request: httpx.Response(200, json=payload))
    await tools.aclose()
    assert result["status"] == "unavailable"


# ---------------------------------------------------------------- RxNorm ingredients

def rxnorm_responder(match, related, calls=None):
    def respond(request):
        if calls is not None:
            calls.append(request)
        if request.url.path.endswith("/rxcui.json"):
            return httpx.Response(200, json=match)
        return httpx.Response(200, json=related)
    return respond


def concept(rxcui, name, tty="IN"):
    return {"rxcui": rxcui, "name": name, "synonym": "", "tty": tty, "language": "ENG", "suppress": "N", "umlscui": ""}


def related_group(ingredients=(), combinations=()):
    return {"relatedGroup": {"rxcui": None, "conceptGroup": [
        {"tty": "IN", **({"conceptProperties": [concept(*i) for i in ingredients]} if ingredients else {})},
        {"tty": "MIN", **({"conceptProperties": [concept(*c, "MIN") for c in combinations]} if combinations else {})},
    ]}}


async def rxnorm_lookup(responder, query="Tylenol", tools=None):
    requests = []
    def handler(request):
        requests.append(request)
        return responder(request)
    tools = tools or ReferenceTools(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return await tools.run("rxnorm_ingredients", {"query": query}), requests, tools


def test_rxnorm_registry_entry_and_pipeline_tool_list():
    info = REFERENCE_TOOLS["rxnorm_ingredients"]
    assert info["name"] == "RxNorm ingredients"
    assert info["variables"] == ["query"]
    assert info["source"] == "https://rxnav.nlm.nih.gov/"
    assert info["scope"] == "US RxNorm vocabulary; confirm the exact product with a pharmacist"
    assert len(info["description"]) < 300
    assert list(REFERENCE_TOOLS)[-1] == "rxnorm_ingredients"
    assert "rxnorm_ingredients" in make_pipeline({"action": "answer"}).tools


async def test_rxnorm_resolves_brand_to_ingredient_with_two_fixed_requests():
    calls = []
    responder = rxnorm_responder({"idGroup": {"rxnormId": ["202433"]}}, related_group([("161", "acetaminophen")]), calls)
    result, requests, tools = await rxnorm_lookup(responder)
    await tools.aclose()
    assert result["status"] == "available"
    assert result["tool"] == "RxNorm ingredients"
    assert result["combination"] is False
    assert result["rxcui"] == "202433"
    assert result["items"] == [{"title": "acetaminophen", "rxcui": "161", "tty": "IN",
                                "url": "https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=161"}]
    assert [str(r.url) for r in requests] == [
        "https://rxnav.nlm.nih.gov/REST/rxcui.json?name=Tylenol&search=2",
        "https://rxnav.nlm.nih.gov/REST/rxcui/202433/related.json?tty=IN+MIN",
    ]
    assert not any("tldr" in item for item in result["items"])


async def test_rxnorm_combination_product_lists_ingredients_and_the_combination():
    related = related_group([("161", "acetaminophen"), ("7804", "oxycodone")], [("214183", "acetaminophen / oxycodone")])
    result, _, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {"rxnormId": ["42844"]}}, related), "Percocet")
    await tools.aclose()
    assert result["combination"] is True
    assert [(i["tty"], i["rxcui"]) for i in result["items"]] == [("IN", "161"), ("IN", "7804"), ("MIN", "214183")]


async def test_rxnorm_single_ingredient_is_not_flagged_when_its_combinations_are_listed():
    # RxNorm returns every combination containing a single ingredient under MIN; that is not "this is a combination".
    related = related_group([("29046", "lisinopril")], [("214618", "hydrochlorothiazide / lisinopril")])
    result, _, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {"rxnormId": ["29046"]}}, related), "lisinopril")
    await tools.aclose()
    assert result["combination"] is False
    assert [i["tty"] for i in result["items"]] == ["IN"]


async def test_rxnorm_no_match_is_empty_without_second_request():
    result, requests, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {}}, {}), "Tylenool")
    await tools.aclose()
    assert result["status"] == "empty"
    assert result["items"] == []
    assert len(requests) == 1


@pytest.mark.parametrize("match", [{"idGroup": ["bad"]}, {"idGroup": {"rxnormId": "161"}}, {"idGroup": {"rxnormId": []}}, {}])
async def test_rxnorm_unrecognised_match_shapes_are_empty(match):
    result, requests, tools = await rxnorm_lookup(rxnorm_responder(match, {}))
    await tools.aclose()
    assert result["status"] == "empty"
    assert len(requests) == 1


@pytest.mark.parametrize("rxcui", ["abc", "123456789", "", "12 34", "../1", 161, None])
async def test_rxnorm_rejects_invalid_rxcui_before_second_request(rxcui):
    result, requests, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {"rxnormId": [rxcui]}}, {}))
    await tools.aclose()
    assert result["status"] == "empty"
    assert len(requests) == 1
    assert tools.circuits["rxnorm_ingredients"].failures == 0


async def test_rxnorm_skips_malformed_related_concepts():
    related = {"relatedGroup": {"conceptGroup": [
        {"tty": "IN", "conceptProperties": [
            concept("../9", "bad id"), concept("161", "<b>acetaminophen</b>"), concept("161", "acetaminophen"),
            concept("12", ""), concept("13", "other", "BN"), "junk"]},
        "junk",
    ]}}
    result, _, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {"rxnormId": ["1"]}}, related))
    await tools.aclose()
    assert [(i["rxcui"], i["title"]) for i in result["items"]] == [("161", "acetaminophen")]


@pytest.mark.parametrize("query", ["Tylenol", "co-trimoxazole", "vitamin D3", "Metformin 500", "a", "A" * 60])
async def test_rxnorm_accepts_medicine_style_queries(query):
    result, requests, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {}}, {}), query)
    await tools.aclose()
    assert result["status"] == "empty"
    assert requests[0].url.params["name"] == query


@pytest.mark.parametrize("query", [
    "A" * 61, "1abc", " Tylenol", "name@example.com", "https://internal", "DOB 1990-01-01", "call 5551234",
    "aspirin 2026", "Tylenol; DROP", "tylenol\n", "", 12, None, "aspirin/ibuprofen", "x" * 5000,
])
async def test_rxnorm_invalid_queries_make_no_network_request(query):
    result, requests, tools = await rxnorm_lookup(rxnorm_responder({}, {}), query)
    await tools.aclose()
    assert result["status"] == "unavailable"
    assert result["items"] == []
    assert not requests


async def test_rxnorm_pattern_applies_to_this_key_only():
    # Digits and a 60-character budget are RxNorm-only; the other reference tools keep their pattern.
    for key in ("drug_labels", "pubmed_search", "label_sections"):
        result, requests = await lookup(key, {}, "vitamin D3")
        assert result["status"] == "unavailable" and not requests


async def test_rxnorm_rate_limit_is_unavailable_and_counts_toward_circuit():
    result, requests, tools = await rxnorm_lookup(lambda request: httpx.Response(429, json={}))
    assert result["status"] == "unavailable"
    assert result["error"] == RXNORM_RATE_LIMIT_ERROR
    assert result["items"] == []
    assert tools.circuits["rxnorm_ingredients"].failures == 1
    assert len(requests) == 1
    # A 429 on the second request counts the same way.
    def second_limited(request):
        return httpx.Response(200, json={"idGroup": {"rxnormId": ["1"]}}) if request.url.path.endswith("/rxcui.json") else httpx.Response(429)
    result, _, tools2 = await rxnorm_lookup(second_limited)
    assert result["error"] == RXNORM_RATE_LIMIT_ERROR
    assert tools2.circuits["rxnorm_ingredients"].failures == 1
    await tools.aclose()
    await tools2.aclose()


async def test_rxnorm_rate_limit_does_not_open_other_tools_circuits():
    _, _, tools = await rxnorm_lookup(lambda request: httpx.Response(429, json={}))
    assert tools.circuits["label_sections"].failures == 0
    assert tools.circuits["drug_labels"].failures == 0
    await tools.aclose()


@pytest.mark.parametrize("responder", [
    lambda request: httpx.Response(503, json={}),
    lambda request: httpx.Response(200, content=b"<html>Error</html>"),
    lambda request: httpx.Response(200, json=[]),
    lambda request: httpx.Response(200, json={"idGroup": {"rxnormId": ["1"]}, "pad": "x" * 270000}),
])
async def test_rxnorm_failures_are_unavailable_not_empty(responder):
    result, _, tools = await rxnorm_lookup(responder)
    await tools.aclose()
    assert result["status"] == "unavailable"
    assert result["items"] == []
    assert result["error"] != RXNORM_RATE_LIMIT_ERROR


async def test_rxnorm_related_response_over_the_byte_cap_is_unavailable():
    related = {"relatedGroup": {"conceptGroup": []}, "pad": "x" * 270000}
    result, requests, tools = await rxnorm_lookup(rxnorm_responder({"idGroup": {"rxnormId": ["161"]}}, related))
    await tools.aclose()
    assert result["status"] == "unavailable"
    assert len(requests) == 2


async def test_rxnorm_timeout_is_unavailable():
    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)
    result, _, tools = await rxnorm_lookup(timeout)
    await tools.aclose()
    assert result["status"] == "unavailable"
    assert tools.circuits["rxnorm_ingredients"].failures == 1


async def test_rxnorm_open_circuit_makes_no_request():
    _, _, tools = await rxnorm_lookup(lambda request: httpx.Response(503, json={}))
    for _ in range(2):
        await rxnorm_lookup(lambda request: httpx.Response(503, json={}), tools=tools)
    assert tools.circuits["rxnorm_ingredients"].opened_at is not None
    seen = []
    tools.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={})))
    result, _, _ = await rxnorm_lookup(None, tools=tools)
    assert result["error"] == "Reference provider temporarily unavailable."
    assert not seen
    await tools.aclose()


async def test_rxnorm_never_logs_the_query(caplog):
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.WARNING, logger="httpx")  # the app silences httpx request lines the same way
    secret = "Zyxwvutsr Medicine"
    for responder in (
        rxnorm_responder({"idGroup": {"rxnormId": ["161"]}}, related_group([("161", "acetaminophen")])),
        lambda request: httpx.Response(429, json={}),
        lambda request: httpx.Response(503, json={}),
    ):
        _, _, tools = await rxnorm_lookup(responder, secret)
        await tools.aclose()
    assert secret.lower() not in caplog.text.lower()
    assert "Zyxwvutsr" not in caplog.text


async def test_rxnorm_cancellation_propagates():
    async def handler(request):
        raise asyncio.CancelledError
    service = ReferenceTools(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(asyncio.CancelledError):
        await service.run("rxnorm_ingredients", {"query": "Tylenol"})
    assert service.circuits["rxnorm_ingredients"].failures == 0
    await service.aclose()
