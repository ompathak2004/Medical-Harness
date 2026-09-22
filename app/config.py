"""Application configuration via environment variables (.env supported)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- LLM (Cerebras, OpenAI-compatible) ---
    cerebras_api_key: str
    cerebras_model: str = "gpt-oss-120b"
    cerebras_base_url: str = "https://api.cerebras.ai/v1"
    llm_temperature: float = 0.3
    llm_max_tokens: int = 4096
    llm_timeout_seconds: float = 90.0
    llm_max_retries: int = 3
    # Optional Cerebras prompt_cache_key: requests sharing a key are routed
    # to the same cache shard, improving prefix-cache hit rates. Requires the
    # feature to be enabled on the Cerebras account; empty = omitted.
    cerebras_prompt_cache_key: str = ""

    # --- Evidence retrieval ---
    medisearch_api_key: str

    # --- Token budgets (answer prompt) ---
    max_evidence_articles: int = 8
    max_tldr_chars: int = 400
    max_summary_chars: int = 1500

    # --- Result caches (in-process TTL+LRU) ---
    evidence_cache_entries: int = 256
    evidence_cache_ttl_seconds: float = 3600.0
    step_cache_entries: int = 512
    step_cache_ttl_seconds: float = 600.0

    # --- Server ---
    port: int = 8080
    log_level: str = "INFO"
    cors_origins: str = ""
    request_timeout_seconds: float = 150.0
    max_concurrent_requests: int = 8
    metrics_token: str = ""

    # --- Request limits ---
    max_conversation_messages: int = 40
    max_message_chars: int = 8000
    rate_limit_requests: int = 20      # requests per window per client
    rate_limit_window_seconds: int = 60

    @property
    def cors_origin_list(self) -> list[str]:
        raw = self.cors_origins.strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
