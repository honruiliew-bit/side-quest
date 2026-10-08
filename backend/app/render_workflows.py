"""Run settle up on Render Workflows.

Each invoice is its own task run on its own instance, with retries. The tasks only talk to
PayPal; the API keeps sole ownership of the database and applies the results under the quest lock.
If the workflow can't be started, the caller sends invoices in-process instead. Once a run has
started we never fall back, because that could send the same invoices twice."""

from __future__ import annotations

import logging
import time

from .config import settings

log = logging.getLogger("sidequest.workflows")

TERMINAL = {"completed", "succeeded", "failed", "canceled", "cancelled"}


class NotStarted(Exception):
    """The workflow never started, so sending in-process is safe."""


class StillRunning(Exception):
    """The workflow started but didn't finish in time. Its invoices may still go out."""


def enabled() -> bool:
    return bool(settings.render_api_key and settings.render_workflow_slug)


def _client():
    from render import Render

    return Render(token=settings.render_api_key)


def settle_up(jobs: list[dict]) -> tuple[list[dict], str]:
    """Send every invoice through the settle_up workflow. Returns (results, task run id)."""
    try:
        client = _client()
        run = client.workflows.start_task(f"{settings.render_workflow_slug}/settle_up", [jobs])
    except Exception as exc:  # bad key, wrong slug, Render unreachable
        raise NotStarted(str(exc)) from exc
    run_id = run.id
    log.info("settle_up started on Render Workflows: %s (%d invoices)", run_id, len(jobs))
    deadline = time.monotonic() + settings.render_workflow_wait
    while True:
        details = client.workflows.get_task_run(run_id)
        status = str(getattr(details.status, "value", details.status)).lower()
        if status in TERMINAL:
            break
        if time.monotonic() > deadline:
            raise StillRunning(run_id)
        time.sleep(1.5)
    if status not in {"completed", "succeeded"}:
        raise RuntimeError(f"Render Workflows run {run_id} {status}: {getattr(details, 'error', '') or 'no detail'}")
    results = details.results[0] if details.results and isinstance(details.results[0], list) else details.results
    return list(results or []), run_id
