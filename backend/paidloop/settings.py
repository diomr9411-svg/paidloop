"""App settings, read from environment variables and the local .env file."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
SANDBOX_URL = "https://api-m.sandbox.paypal.com"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    paypal_client_id: str = ""
    paypal_client_secret: SecretStr = SecretStr("")
    paypal_base_url: str = SANDBOX_URL
    paypal_webhook_id: str = ""
    # Test customers receive sandbox notices at this address. It must be a sandbox personal account.
    sandbox_buyer_email: str = ""

    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = ""
    ai_timeout_seconds: int = 180
    ai_cpu_only: bool = False

    database_url: str = "sqlite:///data/paidloop.db"
    sync_interval_seconds: int = 20
    public_base_url: str = "http://localhost:8000"

    @field_validator("paypal_base_url")
    @classmethod
    def only_sandbox(cls, value: str) -> str:
        """This project never touches real money, so live PayPal is refused."""
        cleaned = value.rstrip("/")
        if cleaned != SANDBOX_URL:
            raise ValueError(f"PAYPAL_BASE_URL must be {SANDBOX_URL}")
        return cleaned

    @property
    def has_paypal_keys(self) -> bool:
        return bool(self.paypal_client_id and self.paypal_client_secret.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()
