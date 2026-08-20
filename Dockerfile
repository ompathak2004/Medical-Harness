# --- Build stage: install dependencies with uv ---
FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

WORKDIR /srv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
COPY static ./static
RUN uv sync --frozen --no-dev

# --- Runtime stage ---
FROM python:3.12-slim

RUN useradd --create-home --uid 1001 appuser
WORKDIR /srv

COPY --from=builder --chown=appuser:appuser /srv /srv

ENV PATH="/srv/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PORT=8080

USER appuser
EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
