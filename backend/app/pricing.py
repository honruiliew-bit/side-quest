"""The split. Shared costs divide by headcount, per-person costs don't.

Holds are placed at the price for the minimum group, which is the most anyone can
ever pay. The final charge is the price for the real group, so it can only go down.
"""

from math import ceil


def totals(cost_lines: list[dict]) -> tuple[int, int]:
    shared = sum(int(l["cents"]) for l in cost_lines if l.get("split") == "shared")
    each = sum(int(l["cents"]) for l in cost_lines if l.get("split") != "shared")
    return shared, each


def base_cents(cost_lines: list[dict], people: int) -> int:
    """One person's share of the costs, before Sidequest's booking fee."""
    if people <= 0:
        raise ValueError("people must be positive")
    shared, each = totals(cost_lines)
    return ceil(shared / people) + each


def booking_fee(base: int, fee_bps: int = 0, fee_fixed: int = 0) -> int:
    return ceil(base * fee_bps / 10_000) + fee_fixed if base > 0 else 0


def price_cents(cost_lines: list[dict], people: int, fee_bps: int = 0, fee_fixed: int = 0) -> int:
    base = base_cents(cost_lines, people)
    return base + booking_fee(base, fee_bps, fee_fixed)


def hold_cents(cost_lines: list[dict], min_people: int, fee_bps: int = 0, fee_fixed: int = 0) -> int:
    return price_cents(cost_lines, min_people, fee_bps, fee_fixed)


def price_table(cost_lines: list[dict], min_people: int, max_people: int, fee_bps: int = 0, fee_fixed: int = 0) -> list[dict]:
    return [
        {"people": n, "cents": price_cents(cost_lines, n, fee_bps, fee_fixed)}
        for n in range(min_people, max_people + 1)
    ]


# A quest carries its own fee terms, copied from the fee schedule when it was posted.

def quest_price(q, people: int) -> int:
    return price_cents(q.cost_lines, people, q.fee_bps or 0, q.fee_fixed_cents or 0)


def quest_fee(q, people: int) -> int:
    """The booking fee inside one person's share at this group size."""
    return booking_fee(base_cents(q.cost_lines, people), q.fee_bps or 0, q.fee_fixed_cents or 0)


def quest_price_table(q) -> list[dict]:
    return price_table(q.cost_lines, q.min_people, q.max_people, q.fee_bps or 0, q.fee_fixed_cents or 0)


def fmt(cents: int, currency: str = "USD") -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    symbol = "$" if currency == "USD" else f"{currency} "
    return f"{sign}{symbol}{cents // 100:,}.{cents % 100:02d}"


def to_value(cents: int) -> str:
    """PayPal wants amounts as strings like "81.00"."""
    return f"{cents // 100}.{cents % 100:02d}"


def from_value(value: str | float | int) -> int:
    return int(round(float(value) * 100))
