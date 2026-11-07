import json


def _reject_constant(value):
    raise ValueError("Non-finite JSON number")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def parse_json_response(text, *, whole_object=False):
    if not isinstance(text, str) or len(text) > 64000:
        raise ValueError("Invalid JSON response size")
    decoder = json.JSONDecoder(parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    try:
        if whole_object:
            result = decoder.decode(text)
        else:
            start = text.find("{")
            if start < 0:
                raise ValueError("No JSON object found in LLM response")
            result, _ = decoder.raw_decode(text[start:])
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("Invalid JSON object") from exc
    if not isinstance(result, dict):
        raise ValueError("Expected JSON object")
    return result
