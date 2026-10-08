"""Sidequest on Render Workflows.

    settle_up(jobs)      fans out one send_invoice task per person, in parallel
    send_invoice(job)    creates and sends one PayPal invoice through the Agent Toolkit

Each send_invoice run gets its own instance and retries on its own. Invoice numbers are
deterministic, so a retry after a lost response finds the invoice it already sent instead of
billing twice. Tasks never touch the database: the API applies results under the quest lock.

Deployed by render.yaml as the `sidequest-settle` workflow service:
    python workflows.py
"""

from __future__ import annotations

import asyncio

from render import Retry, TaskContext, Workflows

app = Workflows(
    default_retry=Retry(max_retries=3, wait_duration_ms=2000, backoff_scaling=2.0),
    default_timeout=120,
)


def _send(job: dict) -> dict:
    from app.paypal import toolkit  # imported in the task so registration stays fast

    out = toolkit.create_and_send_invoice(
        email=job["email"], name=job["name"], cents=int(job["cents"]), item=job["item"], note=job["note"],
        reference=job["reference"], description=job.get("description"), number=job.get("number"),
    )
    return {"key": job["key"], **out}


@app.task
def send_invoice(ctx: TaskContext, job: dict) -> dict:
    """One person's invoice. Raises on failure so Render retries it."""
    return _send(job)


@app.task(retry=Retry(max_retries=0, wait_duration_ms=0))
async def settle_up(ctx: TaskContext, jobs: list[dict]) -> list[dict]:
    """Everyone's invoices at once. One failure doesn't stop the others; each result says what happened."""

    async def one(job: dict) -> dict:
        try:
            return await ctx.run(send_invoice, job)
        except Exception as exc:  # after send_invoice used up its retries
            return {"key": job["key"], "error": str(exc)[:300]}

    return list(await asyncio.gather(*(one(j) for j in jobs)))


if __name__ == "__main__":
    app.start()
