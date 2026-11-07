// Tamper-evident audit trail. Changing any old row breaks every hash after it.
// This helps with traceability, but it is not a GoBD certification.
import { createHash } from "node:crypto";
import { Db, Row } from "./db";

export const GENESIS = "0".repeat(64);

function digest(prevHash: string, at: string, actor: string, action: string, invoiceId: number | null, data: string): string {
  return createHash("sha256").update(JSON.stringify([prevHash, at, actor, action, invoiceId, data]), "utf8").digest("hex");
}

/** JSON with keys sorted at every level, so the same data always gives the same text. */
export function sortedJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Row)[key])]));
    return item;
  };
  return JSON.stringify(sort(value));
}

export function record(db: Db, actor: string, action: string, invoiceId: number | null = null, data: Row = {}): Row {
  // One step: reading the last row and adding the next must not be split by another writer
  return db.transaction(() => {
    const prevHash = db.scalar<string>("SELECT hash FROM audit_event ORDER BY id DESC LIMIT 1") ?? GENESIS;
    const at = new Date().toISOString().slice(0, 19) + "+00:00";
    const body = sortedJson(data);
    const hash = digest(prevHash, at, actor, action, invoiceId, body);
    const id = db.insert("audit_event", { at, actor, action, invoice_id: invoiceId, data: body, prev_hash: prevHash, hash });
    return { id, at, actor, action, invoice_id: invoiceId, data: body, prev_hash: prevHash, hash };
  });
}

export interface AuditCheck {
  ok: boolean;
  broken_at: number | null;
  checked: number;
}

export function verify(db: Db): AuditCheck {
  let prevHash = GENESIS;
  let count = 0;
  // Only the columns the check needs, read one row at a time
  const rows = db.raw.prepare("SELECT id, at, actor, action, invoice_id, data, prev_hash, hash FROM audit_event ORDER BY id").iterate() as IterableIterator<Row>;
  for (const row of rows) {
    if (row.prev_hash !== prevHash || row.hash !== digest(prevHash, row.at, row.actor, row.action, row.invoice_id, row.data)) {
      return { ok: false, broken_at: row.id, checked: count };
    }
    prevHash = row.hash;
    count += 1;
  }
  return { ok: true, broken_at: null, checked: count };
}
