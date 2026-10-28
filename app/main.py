from __future__ import annotations

import logging
import json
import asyncio
import secrets
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.routes import router
from app.config import get_settings
from app.evidence import EvidenceRetriever
from app.llm import CerebrasClient
from app.logging_conf import setup_logging
from app.middleware import RequestSizeMiddleware
from app.pipeline import AgentPipeline
from app.rate_limit import RateLimitMiddleware
from app.tools.references import ReferenceTools

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)
    assets = json.loads((STATIC_DIR / "build.json").read_text(encoding="utf-8"))
    index_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for token, entry in (("APP_JS", "app.js"), ("THEME_JS", "theme-init.js"), ("APP_CSS", "app.css")):
        index_html = index_html.replace("{{" + token + "}}", assets[entry])
    analytics_script = ""
    if os.getenv("VERCEL") == "1" and os.getenv("VERCEL_ENV") == "production":
        analytics_script = f'<script type="module" src="{assets["analytics.js"]}"></script>'
    index_html = index_html.replace("{{ANALYTICS_SCRIPT}}", analytics_script)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        llm = CerebrasClient(
            api_key=settings.cerebras_api_key,
            model=settings.cerebras_model,
            base_url=settings.cerebras_base_url,
            temperature=settings.llm_temperature,
            max_tokens=settings.llm_max_tokens,
            timeout_seconds=settings.llm_timeout_seconds,
            max_retries=settings.llm_max_retries,
            prompt_cache_key=settings.cerebras_prompt_cache_key,
        )
        evidence = EvidenceRetriever(api_key=settings.medisearch_api_key)
        references = ReferenceTools()
        app.state.request_slots = asyncio.Semaphore(settings.max_concurrent_requests)
        app.state.llm = llm
        pipeline = AgentPipeline(llm=llm, evidence=evidence, references=references)
        app.state.pipeline = pipeline
        logger.info("startup complete model=%s version=%s", settings.cerebras_model, __version__)
        try:
            yield
        finally:
            await pipeline.aclose()
            await asyncio.gather(llm.aclose(), evidence.aclose(), references.aclose())

    app = FastAPI(title="medical-harness", version=__version__, lifespan=lifespan)

    app.add_middleware(RequestSizeMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        RateLimitMiddleware,
        limits=[("/api/chat", settings.rate_limit_requests), ("/api/tools", settings.tool_rate_limit_requests)],
        window_seconds=settings.rate_limit_window_seconds,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def response_security(request: Request, call_next):
        session = request.cookies.get("medical_harness_session", "")
        valid_session = len(session) == 64 and all(c in "0123456789abcdef" for c in session)
        request.state.cache_scope = session if valid_session else secrets.token_hex(32)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        if request.url.path in {"/docs", "/redoc", "/docs/oauth2-redirect"}:
            response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data: https://fastapi.tiangolo.com; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path.startswith("/static/dist/") or (request.url.path.startswith("/static/assets/atlas/") and request.url.path.endswith(".glb")):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        if not valid_session and not request.url.path.startswith("/static/"):
            response.set_cookie("medical_harness_session", request.state.cache_scope, httponly=True,
                                secure=request.url.scheme == "https", samesite="strict")
        return response

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.error("unhandled error kind=%s", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error. Please try again."},
        )

    app.include_router(router)
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> HTMLResponse:
        return HTMLResponse(index_html)

    return app


app = create_app()


def run() -> None:

    import uvicorn

    settings = get_settings()
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.port)
