"""Claude reads a receipt photo. The engine decides whether to trust it."""

from __future__ import annotations

import base64

from ..models import Quest
from . import llm

CATEGORIES = ["fuel", "tolls", "parking", "vehicle_rental", "tickets", "food", "lodging", "supplies", "other"]


def _tool(quest: Quest) -> dict:
    shared = [l["label"] for l in quest.cost_lines if l.get("split") == "shared"]
    return {
        "name": "read_receipt",
        "description": "Report what this receipt shows. Use null for anything you cannot read clearly. Never guess a total.",
        "input_schema": {
            "type": "object",
            "properties": {
                "is_receipt": {"type": "boolean", "description": "True only for a purchase receipt or invoice."},
                "legible": {"type": "boolean", "description": "True if the total and date are clearly readable."},
                "merchant": {"type": ["string", "null"]},
                "date": {"type": ["string", "null"], "description": "Purchase date as YYYY-MM-DD"},
                "total_usd": {"type": ["number", "null"], "description": "The final amount paid, including tax"},
                "category": {"type": "string", "enum": CATEGORIES},
                "cost_line": {
                    "type": "string",
                    "enum": shared + ["none"],
                    "description": "Which shared cost on the quest this receipt pays for, or none",
                },
                "concerns": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Anything a careful bookkeeper would question: edits, cut-off totals, unrelated items, "
                                   "a sample or demo watermark, a different currency.",
                },
            },
            "required": ["is_receipt", "legible", "merchant", "date", "total_usd", "category", "cost_line", "concerns"],
        },
    }


SYSTEM = """You check receipts for a small group trip before anyone is charged extra.
Read only what is printed. If a field isn't clearly visible, return null. Don't round or infer totals.
Mention any sign the image was edited, cropped to hide something, or is not a real purchase."""


def read(quest: Quest, data: bytes, media_type: str) -> dict | None:
    """Returns Claude's reading, or None when the AI is off."""
    if not llm.enabled():
        return None
    from ..config import settings

    shared = ", ".join(f"{l['label']} (estimated ${l['cents'] / 100:.2f})" for l in quest.cost_lines if l.get("split") == "shared")
    resp = llm.client().messages.create(
        model=settings.anthropic_model,
        max_tokens=800,
        system=SYSTEM,
        tools=[_tool(quest)],
        tool_choice={"type": "tool", "name": "read_receipt"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                             "data": base64.b64encode(data).decode()}},
                {"type": "text", "text": f"Quest: {quest.title} on {quest.starts_at:%Y-%m-%d}. Shared costs: {shared}."},
            ],
        }],
    )
    for block in resp.content:
        if getattr(block, "type", "") == "tool_use":
            return dict(block.input)
    return None
