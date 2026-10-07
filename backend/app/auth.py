"""Lightweight sign-in. Judges get one-click demo personas, real users sign in with name and email.

Tokens are HS256 JWTs signed with APP_SECRET.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import User

PERSONAS = [
    # persona, name, email, color
    ("hon", "Hon", "hon@sidequest.demo", "#FFC93C"),
    ("maya", "Maya", "maya@sidequest.demo", "#9FD3FF"),
    ("dev", "Dev", "dev@sidequest.demo", "#B9E5A1"),
    ("priya", "Priya", "priya@sidequest.demo", "#FFB3A7"),
    ("leo", "Leo", "leo@sidequest.demo", "#D7C4FF"),
    ("ana", "Ana", "ana@sidequest.demo", "#FFD58A"),
    ("theo", "Theo", "theo@sidequest.demo", "#A8E6DA"),
    ("sam", "Sam", "sam@sidequest.demo", "#F7B6D2"),
    ("jules", "Jules", "jules@sidequest.demo", "#C9D7A4"),
    ("noor", "Noor", "noor@sidequest.demo", "#B8C7FF"),
]

COLORS = [p[3] for p in PERSONAS]


def ensure_personas(db: Session) -> dict[str, User]:
    out = {}
    for persona, name, email, color in PERSONAS:
        u = db.scalar(select(User).where(User.email == email))
        if not u:
            u = User(name=name, email=email, color=color, is_demo=True, persona=persona)
            db.add(u)
        out[persona] = u
    db.flush()
    return out


def issue_token(user: User) -> str:
    payload = {"sub": user.id, "name": user.name, "exp": datetime.now(timezone.utc) + timedelta(days=30)}
    return jwt.encode(payload, settings.app_secret, algorithm="HS256")


def _user_from_header(authorization: str | None, db: Session) -> User | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.app_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return db.get(User, payload.get("sub"))


def optional_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User | None:
    return _user_from_header(authorization, db)


def require_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    user = _user_from_header(authorization, db)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to do that.")
    return user


def get_or_create_user(db: Session, name: str, email: str) -> User:
    email = email.strip().lower()
    u = db.scalar(select(User).where(User.email == email))
    if u:
        return u
    count = db.query(User).count()
    u = User(name=name.strip()[:80] or email.split("@")[0], email=email, color=COLORS[count % len(COLORS)])
    db.add(u)
    db.flush()
    return u
