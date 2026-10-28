from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    cerebras_api_key: str = Field(min_length=1, repr=False)
    cerebras_model: str = "gpt-oss-120b"
    cerebras_base_url: str = "https://api.cerebras.ai/v1"
    llm_temperature: float = Field(default=0.3, ge=0, le=2)
    llm_max_tokens: int = Field(default=4096, ge=256, le=16384)
    llm_timeout_seconds: float = Field(default=45, gt=0, le=120)
    llm_max_retries: int = Field(default=2, ge=1, le=4)
    cerebras_prompt_cache_key: str = ""
    medisearch_api_key: str = Field(min_length=1, repr=False)
    openfda_api_key: str = Field(default="", repr=False)
    max_evidence_articles: int = Field(default=8, ge=1, le=16)
    max_tldr_chars: int = Field(default=400, ge=1, le=2000)
    max_summary_chars: int = Field(default=1500, ge=1, le=4000)
    max_answer_chars: int = Field(default=24000, ge=1000, le=64000)
    evidence_cache_entries: int = Field(default=128, ge=0, le=2048)
    evidence_cache_ttl_seconds: float = Field(default=600, ge=0, le=3600)
    step_cache_entries: int = Field(default=256, ge=0, le=4096)
    step_cache_ttl_seconds: float = Field(default=120, ge=0, le=600)
    port: int = Field(default=8080, ge=1, le=65535)
    log_level: str = "INFO"
    cors_origins: str = ""
    request_timeout_seconds: float = Field(default=150, gt=0, le=170)
    max_concurrent_requests: int = Field(default=8, ge=1, le=64)
    metrics_token: str = Field(default="", repr=False)
    max_conversation_messages: int = Field(default=39, ge=1, le=99)
    max_message_chars: int = Field(default=8000, ge=1, le=16000)
    max_conversation_chars: int = Field(default=32000, ge=1000, le=128000)
    max_request_bytes: int = Field(default=262144, ge=1024, le=1048576)
    rate_limit_requests: int = Field(default=20, ge=1, le=1000)
    rate_limit_window_seconds: int = Field(default=60, ge=1, le=3600)
    tool_rate_limit_requests: int = Field(default=60, ge=1, le=1000)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
