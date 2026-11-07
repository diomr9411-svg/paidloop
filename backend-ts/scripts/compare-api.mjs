// Compares the shape of the answers (not the values) of two running servers: the earlier Python one and this one.
// Run: node scripts/compare-api.mjs http://127.0.0.1:8000 http://127.0.0.1:8001
const [oldBase, newBase] = process.argv.slice(2);
if (!oldBase || !newBase) throw new Error("Usage: node scripts/compare-api.mjs <old server> <new server>");

function shape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key], depth + 1)]));
  return typeof value;
}

/** null matches anything, and an empty list matches any list */
function same(a, b, path, problems) {
  if (a === "null" || b === "null") return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) same(a[0], b[0], path + "[]", problems);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!(key in a)) problems.push(`${path}.${key}: only in the new server`);
      else if (!(key in b)) problems.push(`${path}.${key}: only in the old server`);
      else same(a[key], b[key], `${path}.${key}`, problems);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

async function get(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 40), type: response.headers.get("content-type") }; }
  return { status: response.status, body };
}

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tokens = {};
for (const [name, base] of [["old", oldBase], ["new", newBase]]) {
  const list = (await get(base, "/api/invoices?size=100")).body.items;
  const open = list.find((row) => row.status === "issued");
  tokens[name] = { id: open.id, token: (await get(base, `/api/invoices/${open.id}`)).body.public_token, paid: list.find((row) => row.status === "paid")?.id };
}

const checks = [
  ["/api/health"], ["/api/business"], ["/api/customers"], ["/api/dashboard"], ["/api/invoices?size=100"], ["/api/invoices?filter=overdue&q=caf&sort=customer&dir=asc"],
  ["/api/approvals"], ["/api/audit?limit=5"], ["/api/audit/verify"], ["/api/ledger"], ["/api/demo/clock"],
  ["/api/invoices/{id}"], ["/api/invoices/{paid}"], ["/api/pay/{token}"],
  ["/api/invoices?size=100000"], ["/api/invoices/999999"], ["/api/nothing"], ["/api/pay/short"],
  ["/api/capture/text", json({ text: "3,5 Std Badreparatur bei Bäckerei Muster GmbH je 60 Euro, Material 89,90 €, am 05.11.2026" })],
  ["/api/capture/text", json({ text: "" })],
  ["/api/customers", json({ name: "Vergleich GmbH", email: "v@example.com" })],
  ["/api/invoices", json({ customer_id: null, lines: [{ description: "Arbeit", quantity: 2, unit: "HUR", unit_price_eur: 50, vat_percent: 19 }] })],
  ["/api/invoices", json({ lines: [{ description: "x", quantity: -1, unit_price_eur: 5 }] })],
];

let problems = 0;
for (const [template, init] of checks) {
  const results = {};
  for (const [name, base] of [["old", oldBase], ["new", newBase]]) {
    const path = template.replace("{id}", tokens[name].id).replace("{paid}", tokens[name].paid).replace("{token}", tokens[name].token);
    results[name] = await get(base, path, init);
  }
  const found = [];
  if (results.old.status !== results.new.status) found.push(`status ${results.old.status} vs ${results.new.status}`);
  same(shape(results.old.body), shape(results.new.body), "", found);
  const label = `${init ? "POST" : "GET "} ${template}`;
  if (found.length) {
    problems += found.length;
    console.log(`FAIL ${label}`);
    for (const problem of found.slice(0, 8)) console.log(`     ${problem}`);
  } else console.log(`ok   ${label}`);
}
console.log(problems ? `\n${problems} differences` : "\nSame shapes everywhere");
process.exit(problems ? 1 : 0);
