"""Shared test configuration — provide required env vars before app imports."""

import os

os.environ.setdefault("CEREBRAS_API_KEY", "test-key")
os.environ.setdefault("MEDISEARCH_API_KEY", "test-key")
