"""Runtime settings, read once from the environment."""

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Core
    app_secret: str = os.getenv("APP_SECRET", "dev-secret-change-me-before-you-deploy-this")
    database_url: str = os.getenv("DATABASE_URL", "sqlite:///./sidequest.db")
    frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:3000").rstrip("/")
    public_api_url: str = os.getenv("PUBLIC_API_URL", "http://localhost:8000").rstrip("/")
    cors_origin_regex: str = os.getenv(
        "CORS_ORIGIN_REGEX", r"https://sidequest[a-z0-9-]*\.vercel\.app|https://.*\.onrender\.com"
    )
    cron_secret: str = os.getenv("CRON_SECRET", "")
    demo_mode: bool = _bool("DEMO_MODE", True)
    seed_on_start: bool = _bool("SEED_ON_START", True)
    scheduler_seconds: int = int(os.getenv("SCHEDULER_SECONDS", "20"))

    # PayPal. Mode "mock" needs no keys. Mode "sandbox" talks to api-m.sandbox.paypal.com.
    paypal_mode: str = os.getenv("PAYPAL_MODE", "").strip().lower()
    paypal_client_id: str = os.getenv("PAYPAL_CLIENT_ID", "")
    paypal_client_secret: str = os.getenv("PAYPAL_CLIENT_SECRET", "")
    paypal_webhook_id: str = os.getenv("PAYPAL_WEBHOOK_ID", "")
    paypal_brand_name: str = os.getenv("PAYPAL_BRAND_NAME", "Sidequest")
    # Optional. With a sandbox test card (Developer Dashboard > Testing tools > Card generator),
    # demo crowd joins create real sandbox authorizations instead of simulated ones.
    demo_card_number: str = os.getenv("DEMO_CARD_NUMBER", "")
    demo_card_expiry: str = os.getenv("DEMO_CARD_EXPIRY", "2030-12")
    demo_card_cvv: str = os.getenv("DEMO_CARD_CVV", "123")
    # Shown to judges inside the guided demo so they can approve sandbox holds. Sandbox only, never live.
    demo_buyer_email: str = os.getenv("DEMO_BUYER_EMAIL", "")
    demo_buyer_password: str = os.getenv("DEMO_BUYER_PASSWORD", "")
    chat_per_minute: int = int(os.getenv("CHAT_PER_MINUTE", "8"))
    # Hours after the trip ends before the host is paid, so members can report a problem first.
    payout_hold_hours: int = int(os.getenv("PAYOUT_HOLD_HOURS", "24"))

    # Money
    currency: str = os.getenv("CURRENCY", "USD")
    platform_fee_pct: float = float(os.getenv("PLATFORM_FEE_PCT", "0"))

    # AI
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    # Render Workflows: settle up fans out one task per invoice. Off unless both are set.
    render_api_key: str = os.getenv("RENDER_API_KEY", "")
    render_workflow_slug: str = os.getenv("RENDER_WORKFLOW_SLUG", "")
    render_workflow_wait: int = int(os.getenv("RENDER_WORKFLOW_WAIT", "90"))
    anthropic_model: str = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")

    @property
    def paypal_live_keys(self) -> bool:
        return bool(self.paypal_client_id and self.paypal_client_secret)

    @property
    def effective_paypal_mode(self) -> str:
        if self.paypal_mode in {"mock", "sandbox"}:
            if self.paypal_mode == "sandbox" and not self.paypal_live_keys:
                return "mock"
            return self.paypal_mode
        return "sandbox" if self.paypal_live_keys else "mock"

    @property
    def ai_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


settings = Settings()
