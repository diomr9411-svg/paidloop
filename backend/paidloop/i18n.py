"""Two languages for everything the app says. A Text is English, and it also carries the German."""

from __future__ import annotations

LANGUAGES = {"en", "de"}


class Text(str):
    """Works as a normal English string, and text.get("de") gives the German."""

    de: str

    def __new__(cls, en: str, de: str | None = None) -> "Text":
        value = super().__new__(cls, en)
        value.de = de if de is not None else en
        return value

    def get(self, language: str) -> str:
        return self.de if language == "de" else str(self)


def pick(value: object, language: str) -> str:
    return value.get(language) if isinstance(value, Text) else str(value)


def language_from_header(value: str | None) -> str:
    """Accepts 'de', 'en' or a browser value such as 'de-DE,de;q=0.9'."""
    code = (value or "").split(",")[0].split("-")[0].strip().lower()
    return code if code in LANGUAGES else "en"


class LocalizedError(Exception):
    """A problem the person can understand and fix, in their own language."""

    def __init__(self, text: "Text | str", status: int = 422) -> None:
        self.text = text if isinstance(text, Text) else Text(str(text))
        self.status = status
        super().__init__(str(self.text))

    def message(self, language: str) -> str:
        return self.text.get(language)
