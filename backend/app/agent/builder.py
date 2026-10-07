"""Turn one sentence into a bookable quest draft."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import llm

TZ = ZoneInfo("America/New_York")

DRAFT_TOOL = {
    "name": "draft_quest",
    "description": "Return a complete, realistic quest draft that a host can publish as is.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Plain, specific, under 60 characters. No emoji."},
            "area": {"type": "string", "description": "Region or neighborhood, e.g. Hudson Valley"},
            "summary": {"type": "string", "description": "Two sentences in plain language. What you do and when you are back."},
            "line_code": {"type": "string", "description": "Two capital letters for the area, e.g. HV for Hudson Valley"},
            "from_label": {"type": "string"},
            "to_label": {"type": "string"},
            "meet_point": {"type": "string", "description": "A specific, findable meeting spot"},
            "date": {"type": "string", "description": "YYYY-MM-DD"},
            "start_time": {"type": "string", "description": "24h HH:MM"},
            "end_time": {"type": "string", "description": "24h HH:MM"},
            "min_people": {"type": "integer", "minimum": 2, "maximum": 20},
            "max_people": {"type": "integer", "minimum": 2, "maximum": 30},
            "join_by_hours_before": {"type": "integer", "minimum": 6, "maximum": 168},
            "itinerary": {
                "type": "array", "minItems": 2, "maxItems": 8,
                "items": {"type": "object", "properties": {
                    "time": {"type": "string", "description": "e.g. 8:10 am"},
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                }, "required": ["time", "title", "detail"]},
            },
            "cost_lines": {
                "type": "array", "minItems": 1, "maxItems": 8,
                "items": {"type": "object", "properties": {
                    "label": {"type": "string"},
                    "amount_usd": {"type": "number", "description": "Total for shared lines, per person for each lines"},
                    "split": {"type": "string", "enum": ["shared", "each"]},
                }, "required": ["label", "amount_usd", "split"]},
            },
        },
        "required": ["title", "area", "summary", "line_code", "from_label", "to_label", "meet_point", "date",
                     "start_time", "end_time", "min_people", "max_people", "join_by_hours_before",
                     "itinerary", "cost_lines"],
    },
}

SYSTEM = """You plan side quests: cheap, spontaneous day trips and city adventures for a small group.
The host types one sentence. You return a draft they can publish without editing.

Rules
- Default city is New York unless the host names another place.
- Use real, well known places. Prices are honest estimates for the date; round to whole dollars.
- Split costs correctly. Vehicles, gas, tolls, a guide or a rental are "shared" (one total, split by headcount).
  Tickets, entry, food flights or rentals per person are "each".
- Only include costs that are collected up front. Meals people buy themselves go in the itinerary as "pay your own".
- min_people is where shared costs become reasonable. max_people fits the vehicle or venue.
- Pick the next date that matches what they asked for. If they said nothing, use the coming Saturday.
- Write plainly. No em dashes, no exclamation marks, no hype."""


def _coming_saturday(today: date) -> date:
    days = (5 - today.weekday()) % 7 or 7
    return today + timedelta(days=days)


def draft(prompt: str) -> dict:
    today = datetime.now(TZ).date()
    if llm.enabled():
        try:
            raw = llm.forced_tool(SYSTEM, f"Today is {today:%A, %B %d, %Y}.\n\nHost: {prompt}", DRAFT_TOOL)
            return normalise(raw, source="claude")
        except Exception as exc:  # fall back so the demo never dead-ends
            llm.log.warning("builder fell back: %s", exc)
    return normalise(_offline(prompt, today), source="offline")


def normalise(raw: dict, source: str) -> dict:
    lines = []
    for l in raw.get("cost_lines", []):
        cents = int(round(float(l.get("amount_usd", 0)) * 100))
        if cents > 0:
            lines.append({"label": str(l.get("label", "Cost"))[:80], "cents": cents,
                          "split": "shared" if l.get("split") == "shared" else "each"})
    mn = max(2, int(raw.get("min_people", 4)))
    mx = max(mn, int(raw.get("max_people", mn + 2)))
    code = re.sub(r"[^A-Z]", "", str(raw.get("line_code", "SQ")).upper())[:2] or "SQ"
    return {
        "title": str(raw.get("title", "Side quest"))[:160],
        "area": str(raw.get("area", ""))[:80],
        "summary": str(raw.get("summary", "")),
        "line_code": code,
        "from_label": str(raw.get("from_label", ""))[:80],
        "to_label": str(raw.get("to_label", ""))[:80],
        "meet_point": str(raw.get("meet_point", ""))[:200],
        "date": str(raw.get("date")),
        "start_time": str(raw.get("start_time", "09:00")),
        "end_time": str(raw.get("end_time", "18:00")),
        "min_people": mn,
        "max_people": mx,
        "join_by_hours_before": int(raw.get("join_by_hours_before", 36)),
        "itinerary": [{"time": str(s.get("time", "")), "title": str(s.get("title", "")),
                       "detail": str(s.get("detail", ""))} for s in raw.get("itinerary", [])][:8],
        "cost_lines": lines,
        "source": source,
    }


# --- Offline drafts ---------------------------------------------------------
# Used when no ANTHROPIC_API_KEY is set, so the app still works end to end.

_TEMPLATES = [
    (r"bak|cinnamon|croissant|pastr|donut|bagel", {
        "title": "Brooklyn bakery crawl", "area": "Brooklyn", "line_code": "BK",
        "summary": "Five bakeries across Williamsburg and Greenpoint, one pastry each. Done by early afternoon.",
        "from_label": "Bedford Ave", "to_label": "Greenpoint", "meet_point": "Bedford Av L station, north exit",
        "start_time": "10:00", "end_time": "14:00", "min_people": 4, "max_people": 10, "join_by_hours_before": 24,
        "itinerary": [
            {"time": "10:00 am", "title": "Meet at Bedford Av", "detail": "North exit, by the bike racks"},
            {"time": "10:15 am", "title": "Bakeries one and two", "detail": "Croissants and a morning bun"},
            {"time": "11:30 am", "title": "Coffee stop", "detail": "Pay your own"},
            {"time": "12:15 pm", "title": "Bakeries three to five", "detail": "Cinnamon rolls, then a vote on the best"},
        ],
        "cost_lines": [
            {"label": "Pastry tasting, five stops", "amount_usd": 32, "split": "each"},
            {"label": "Reserved tasting table at the last stop", "amount_usd": 60, "split": "shared"},
        ],
    }),
    (r"beach|surf|rockaway|swim|ocean", {
        "title": "Rockaway surf lesson and beach day", "area": "Rockaway Beach", "line_code": "RB",
        "summary": "Ferry out to Rockaway, a two hour group surf lesson, then beach time. Back by evening.",
        "from_label": "Wall St Pier 11", "to_label": "Rockaway", "meet_point": "Pier 11, ferry ticket machines",
        "start_time": "09:00", "end_time": "18:00", "min_people": 4, "max_people": 8, "join_by_hours_before": 36,
        "itinerary": [
            {"time": "9:00 am", "title": "Ferry from Pier 11", "detail": "About an hour"},
            {"time": "10:30 am", "title": "Group surf lesson", "detail": "Boards and wetsuits included"},
            {"time": "1:00 pm", "title": "Tacos on the boardwalk", "detail": "Pay your own"},
            {"time": "4:30 pm", "title": "Ferry back", "detail": "Sunset optional"},
        ],
        "cost_lines": [
            {"label": "Surf instructor, two hours", "amount_usd": 240, "split": "shared"},
            {"label": "Board and wetsuit rental", "amount_usd": 35, "split": "each"},
            {"label": "Ferry, round trip", "amount_usd": 9, "split": "each"},
        ],
    }),
    (r"hike|trail|mountain|bear|breakneck|catskill", {
        "title": "Breakneck Ridge hike and Beacon lunch", "area": "Hudson Highlands", "line_code": "HH",
        "summary": "Train up the Hudson, a steep scramble with river views, then lunch in Beacon. Home by dinner.",
        "from_label": "Grand Central", "to_label": "Breakneck Ridge", "meet_point": "Grand Central, main concourse clock",
        "start_time": "07:45", "end_time": "18:30", "min_people": 3, "max_people": 8, "join_by_hours_before": 24,
        "itinerary": [
            {"time": "7:45 am", "title": "Meet at the clock", "detail": "Hudson line, off-peak tickets"},
            {"time": "9:30 am", "title": "Breakneck Ridge", "detail": "About four hours, bring water"},
            {"time": "2:00 pm", "title": "Lunch in Beacon", "detail": "Pay your own"},
            {"time": "5:00 pm", "title": "Train home", "detail": "From Beacon station"},
        ],
        "cost_lines": [
            {"label": "Metro-North round trip", "amount_usd": 32, "split": "each"},
            {"label": "Trail snacks and first aid kit", "amount_usd": 40, "split": "shared"},
        ],
    }),
]

_DEFAULT = {
    "title": "Apple picking and cider in the Hudson Valley", "area": "Hudson Valley", "line_code": "HV",
    "summary": "A minivan out of Midtown, an orchard, a farm lunch and a cider flight. Back in the city by seven.",
    "from_label": "Grand Central", "to_label": "Fishkill, NY",
    "meet_point": "42nd St and Park Ave, by the Pershing Square corner",
    "start_time": "08:10", "end_time": "19:00", "min_people": 5, "max_people": 7, "join_by_hours_before": 36,
    "itinerary": [
        {"time": "8:10 am", "title": "Meet at the van", "detail": "42nd St and Park Ave"},
        {"time": "10:00 am", "title": "Apple picking", "detail": "Orchard entry and a half-peck bag each"},
        {"time": "1:00 pm", "title": "Lunch at the farm cafe", "detail": "Pay your own"},
        {"time": "2:30 pm", "title": "Cider tasting", "detail": "Flight of five, 21 and over"},
        {"time": "5:00 pm", "title": "Drive back to the city", "detail": "Drop-offs in Midtown"},
    ],
    "cost_lines": [
        {"label": "Minivan rental", "amount_usd": 180, "split": "shared"},
        {"label": "Gas and tolls", "amount_usd": 60, "split": "shared"},
        {"label": "Orchard entry", "amount_usd": 15, "split": "each"},
        {"label": "Cider flight", "amount_usd": 18, "split": "each"},
    ],
}


def _offline(prompt: str, today: date) -> dict:
    text = prompt.lower()
    chosen = dict(_DEFAULT)
    for pattern, template in _TEMPLATES:
        if re.search(pattern, text):
            chosen = dict(template)
            break
    people = re.search(r"(\d+)\s*(people|friends|of us|ppl|person)", text)
    if people:
        n = max(2, min(20, int(people.group(1))))
        chosen["max_people"] = max(n, chosen["min_people"])
        chosen["min_people"] = min(chosen["min_people"], n)
    chosen["date"] = _coming_saturday(today).isoformat()
    if "sunday" in text:
        chosen["date"] = (_coming_saturday(today) + timedelta(days=1)).isoformat()
    return chosen
