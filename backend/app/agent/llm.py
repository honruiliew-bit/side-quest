"""Thin wrapper around the Anthropic Messages API with a tool-use loop."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from ..config import settings

log = logging.getLogger("sidequest.agent")

_client = None


def enabled() -> bool:
    return settings.ai_enabled


def client():
    global _client
    if _client is None:
        from anthropic import Anthropic

        _client = Anthropic(api_key=settings.anthropic_api_key, max_retries=2, timeout=60)
    return _client


def _text(content) -> str:
    return "".join(getattr(b, "text", "") for b in content if getattr(b, "type", "") == "text").strip()


def run_with_tools(
    system: str,
    messages: list[dict],
    tools: list[dict],
    handle: Callable[[str, dict], Any],
    max_turns: int = 6,
    max_tokens: int = 1200,
) -> tuple[str, list[dict]]:
    """Run until the model stops calling tools. Returns (final text, tool log)."""
    history = list(messages)
    calls: list[dict] = []
    for _ in range(max_turns):
        resp = client().messages.create(
            model=settings.anthropic_model,
            max_tokens=max_tokens,
            system=system,
            messages=history,
            tools=tools,
        )
        if resp.stop_reason != "tool_use":
            return _text(resp.content), calls
        history.append({"role": "assistant", "content": resp.content})
        results = []
        for block in resp.content:
            if getattr(block, "type", "") != "tool_use":
                continue
            try:
                output = handle(block.name, dict(block.input or {}))
                is_error = False
            except Exception as exc:  # the model gets the error and can recover
                output = {"error": str(exc)}
                is_error = True
            calls.append({"name": block.name, "input": block.input, "error": is_error})
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output if isinstance(output, str) else json.dumps(output, default=str)[:8000],
                "is_error": is_error,
            })
        history.append({"role": "user", "content": results})
    return "I ran out of steps on that one. Try asking again more simply.", calls


def forced_tool(system: str, prompt: str, tool: dict, max_tokens: int = 2500) -> dict:
    resp = client().messages.create(
        model=settings.anthropic_model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
    )
    for block in resp.content:
        if getattr(block, "type", "") == "tool_use":
            return dict(block.input)
    raise RuntimeError("The model did not return a draft.")
