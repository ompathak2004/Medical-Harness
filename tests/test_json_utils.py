"""Tests for robust LLM JSON parsing."""

import pytest

from app.json_utils import parse_json_response


def test_plain_json():
    assert parse_json_response('{"a": 1}') == {"a": 1}


def test_fenced_json():
    assert parse_json_response('```json\n{"a": 1}\n```') == {"a": 1}


def test_fence_without_language():
    assert parse_json_response('```\n{"a": 1}\n```') == {"a": 1}


def test_leading_prose():
    text = 'Here is the result:\n{"action": "answer", "follow_up_questions": []}'
    assert parse_json_response(text)["action"] == "answer"


def test_trailing_prose():
    text = '{"a": 1}\nHope that helps!'
    assert parse_json_response(text) == {"a": 1}


def test_nested_object():
    text = 'blah {"a": {"b": [1, 2]}} blah'
    assert parse_json_response(text) == {"a": {"b": [1, 2]}}


def test_no_json_raises():
    with pytest.raises(ValueError):
        parse_json_response("no json here at all")


def test_whitespace():
    assert parse_json_response('   \n {"x": true} \n  ') == {"x": True}
