"""Tamper-evident audit trail. Changing any old row breaks every hash after it.

This helps with traceability, but it is not a GoBD certification.
"""

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from paidloop.models import AuditEvent

GENESIS = "0" * 64


def _digest(prev_hash: str, at: str, actor: str, action: str, invoice_id: int | None, data: str) -> str:
    payload = json.dumps([prev_hash, at, actor, action, invoice_id, data], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def record(session: Session, actor: str, action: str, invoice_id: int | None = None, /, **data: object) -> AuditEvent:
    session.flush()
    # Take the database write lock before reading the last row. Without this, two writers could
    # read the same last row, and the chain would look broken even though nobody changed anything.
    session.execute(text("INSERT OR REPLACE INTO app_state (key, value) VALUES ('audit_lock', '1')"))
    last = session.scalar(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(1))
    prev_hash = last.hash if last else GENESIS
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    body = json.dumps(data, ensure_ascii=False, sort_keys=True, default=str)
    event = AuditEvent(
        at=at,
        actor=actor,
        action=action,
        invoice_id=invoice_id,
        data=body,
        prev_hash=prev_hash,
        hash=_digest(prev_hash, at, actor, action, invoice_id, body),
    )
    session.add(event)
    session.flush()
    return event


def verify(session: Session) -> dict[str, object]:
    prev_hash = GENESIS
    count = 0
    for event in session.scalars(select(AuditEvent).order_by(AuditEvent.id)):
        expected = _digest(prev_hash, event.at, event.actor, event.action, event.invoice_id, event.data)
        if event.prev_hash != prev_hash or event.hash != expected:
            return {"ok": False, "broken_at": event.id, "checked": count}
        prev_hash = event.hash
        count += 1
    return {"ok": True, "broken_at": None, "checked": count}
