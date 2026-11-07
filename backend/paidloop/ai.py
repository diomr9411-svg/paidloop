"""Free local AI through Ollama. If it is slow, off or wrong, the app falls back to fixed rules.

Nothing the AI returns is trusted. It must fit a schema, and code checks it before anything happens.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from typing import Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

log = logging.getLogger("paidloop.ai")
Schema = TypeVar("Schema", bound=BaseModel)


class AI(Protocol):
    def ask_json(self, system: str, user: str, schema: type[Schema]) -> Schema | None: ...

    def status(self) -> dict[str, object]: ...


class NoAI:
    """Used when no local model is available. Every caller already has a rules fallback."""

    def ask_json(self, system: str, user: str, schema: type[Schema]) -> Schema | None:
        return None

    def status(self) -> dict[str, object]:
        return {"available": False, "model": ""}


class LocalAI:
    def __init__(
        self,
        base_url: str,
        model: str,
        timeout: int = 180,
        answers_file: Path | None = None,
        http: httpx.Client | None = None,
    ) -> None:
        self._model = model
        self._http = http or httpx.Client(base_url=base_url, timeout=timeout)
        self._answers_file = answers_file
        self._answers: dict[str, str] = {}
        self._lock = threading.Lock()
        self._status: dict[str, object] = {"available": False, "model": model}
        self._status_at = 0.0
        if answers_file and answers_file.exists():
            try:
                self._answers = json.loads(answers_file.read_text(encoding="utf-8"))
            except ValueError:
                self._answers = {}

    def status(self) -> dict[str, object]:
        """Is the model ready? The result is kept for 20 seconds so screens stay fast."""
        if not self._model:
            return {"available": False, "model": ""}
        now = time.monotonic()
        if now - self._status_at < 20:
            return self._status
        try:
            response = self._http.get("/api/tags", timeout=3)
            names = [item.get("name", "") for item in response.json().get("models", [])]
            available = response.status_code == 200 and self._model in names
        except (httpx.HTTPError, ValueError):
            available = False
        self._status = {"available": available, "model": self._model}
        self._status_at = now
        return self._status

    def _key(self, system: str, user: str, schema: type[BaseModel]) -> str:
        text = json.dumps([self._model, system, user, schema.__name__], ensure_ascii=False)
        return hashlib.sha256(text.encode()).hexdigest()

    def _remember(self, key: str, content: str) -> None:
        with self._lock:
            self._answers[key] = content
            if self._answers_file:
                self._answers_file.parent.mkdir(parents=True, exist_ok=True)
                self._answers_file.write_text(json.dumps(self._answers), encoding="utf-8")

    def ask_json(self, system: str, user: str, schema: type[Schema]) -> Schema | None:
        key = self._key(system, user, schema)
        saved = self._answers.get(key)
        if saved is not None:
            try:
                return schema.model_validate_json(saved)
            except ValidationError:
                pass
        if not self.status()["available"]:
            return None
        body = {
            "model": self._model,
            "stream": False,
            "format": schema.model_json_schema(),
            "keep_alive": "20m",
            "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 512},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        try:
            response = self._http.post("/api/chat", json=body)
            response.raise_for_status()
            content = response.json()["message"]["content"]
            result = schema.model_validate_json(content)
        except (httpx.HTTPError, KeyError, ValueError, ValidationError) as error:
            log.warning("AI answer was not usable: %s", type(error).__name__)
            return None
        self._remember(key, content)
        return result
