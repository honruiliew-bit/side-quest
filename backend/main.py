"""Sidequest API.

    uvicorn main:app --reload
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.admin import router as admin_router
from app.api import router
from app.books import router as books_router
from app.config import settings
from app.db import init_db, session_scope
from app.engine import QuestError, tick
from app.mcp_server import mcp
from app.paypal.gateway import PayPalError, paypal_mode
from app.seed import seed_if_empty

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("sidequest")


def _tick_once() -> None:
    with session_scope() as db:
        counts = tick(db)
        if any(counts.values()):
            log.info("tick %s", counts)


async def _clock() -> None:
    while True:
        await asyncio.sleep(settings.scheduler_seconds)
        try:
            await run_in_threadpool(_tick_once)
        except Exception:  # keep the clock alive
            log.exception("scheduler tick failed")


mcp_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if settings.seed_on_start:
        with session_scope() as db:
            if seed_if_empty(db):
                log.info("seeded demo quests")
    log.info("PayPal mode: %s. AI: %s.", paypal_mode(), "claude" if settings.ai_enabled else "offline")
    task = asyncio.create_task(_clock())
    async with mcp.session_manager.run():
        yield
    task.cancel()


app = FastAPI(title="Sidequest API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(QuestError)
async def quest_error(_: Request, exc: QuestError):
    return JSONResponse(status_code=exc.status, content={"detail": str(exc)})


@app.exception_handler(PayPalError)
async def paypal_error(_: Request, exc: PayPalError):
    return JSONResponse(status_code=502, content={"detail": f"PayPal: {exc}", "debug_id": exc.debug_id})


app.include_router(router)
app.include_router(books_router)
app.include_router(admin_router)
app.mount("/mcp", mcp_app)
