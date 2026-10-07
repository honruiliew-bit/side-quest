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


# Some models reject a forced tool_choice. Learn that once, then ask for the tool in the prompt instead.
_forced_ok = True


def call_tool(system: str, content, tool: dict, max_tokens: int = 2500) -> dict:
    """Get structured output by having the model call one tool. Works with or without forced tool_choice."""
    global _forced_ok
    from anthropic import BadRequestError

    name = tool["name"]
    base = dict(
        model=settings.anthropic_model,
        max_tokens=max_tokens,
        system=f"{system}\n\nRespond only by calling the {name} tool.",
        messages=[{"role": "user", "content": content}],
        tools=[tool],
    )
    resp = None
    if _forced_ok:
        try:
            resp = client().messages.create(**base, tool_choice={"type": "tool", "name": name})
        except BadRequestError as exc:
            if "tool_choice" not in str(exc):
                raise
            _forced_ok = False
            log.info("model doesn't support forced tool_choice; using auto from now on")
    if resp is None:
        resp = client().messages.create(**base, tool_choice={"type": "auto"})
    for block in resp.content:
        if getattr(block, "type", "") == "tool_use" and block.name == name:
            return dict(block.input)
    raise RuntimeError(f"The model answered without calling {name}.")


def forced_tool(system: str, prompt: str, tool: dict, max_tokens: int = 2500) -> dict:
    return call_tool(system, prompt, tool, max_tokens)
