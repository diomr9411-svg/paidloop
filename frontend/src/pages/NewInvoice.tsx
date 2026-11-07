import { useEffect, useRef, useState } from "react";

import { addDays, api, eur, post, put } from "../api";

type Line = { description: string; quantity: string; unit: string; price: string; vat: string };
type CustomerForm = { id: number | null; name: string; street: string; postcode: string; city: string; email: string; is_business: boolean; language: string };

const EMPTY_CUSTOMER: CustomerForm = { id: null, name: "", street: "", postcode: "", city: "", email: "", is_business: true, language: "de" };
const EXAMPLE = "4 hours bathroom repair at Bäckerei Muster GmbH at 65 euro, 120 euro material, on 05.11.2026";

function toNumber(text: string): number {
  const value = String(text).trim();
  const normal = value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;
  return Number(normal) || 0;
}

export function NewInvoice({ refresh }: { refresh: () => void }) {
  const [note, setNote] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [capture, setCapture] = useState<any>(null);
  const [unsure, setUnsure] = useState<string[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [customer, setCustomer] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [lines, setLines] = useState<Line[]>([]);
  const [dates, setDates] = useState({ issue: "", service: "", due: "" });
  const [propertyWork, setPropertyWork] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<any[]>("/api/customers").then(setCustomers).catch(() => undefined);
  }, []);

  function fill(result: any) {
    const data = result.extracted;
    setCapture(result);
    setUnsure(result.unsure);
    setCheck(null);
    setDraftId(null);
    setPropertyWork(result.property_work);
    const vat = String(result.default_vat_percent);
    setLines(
      data.lines.length
        ? data.lines.map((line: any) => ({
            description: line.description,
            quantity: String(line.quantity),
            unit: line.unit === "hours" ? "HUR" : "H87",
            price: line.unit_price_eur == null ? "" : String(line.unit_price_eur),
            vat,
          }))
        : [{ description: "", quantity: "1", unit: "H87", price: "", vat }],
    );
    setDates({
      issue: result.today,
      service: data.service_date || "",
      due: addDays(result.today, result.payment_days),
    });
    if (result.known_customer) {
      setCustomer({ ...result.known_customer });
      setUnsure((u) => u.filter((f: string) => f !== "customer_is_business" && f !== "customer_name"));
    } else {
      setCustomer({
        ...EMPTY_CUSTOMER,
        name: data.customer_name,
        street: data.customer_street,
        postcode: data.customer_postcode,
        city: data.customer_city,
        email: data.customer_email,
        is_business: data.customer_is_business ?? true,
      });
    }
  }

  async function read() {
    if (!note.trim()) {
      setError("Please write or upload a job note first.");
      return;
    }
    setReading(true);
    setError("");
    try {
      fill(await post("/api/capture/text", { text: note }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function upload(file: File) {
    setReading(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await api("/api/capture/file", { method: "POST", body: form });
      setNote(result.source_text);
      fill(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function changed() {
    setCheck(null);
  }

  function setLine(index: number, change: Partial<Line>) {
    setLines((all) => all.map((line, i) => (i === index ? { ...line, ...change } : line)));
    const field = Object.keys(change)[0] === "price" ? "unit_price" : Object.keys(change)[0];
    setUnsure((u) => u.filter((f) => f !== `lines.${index}.${field}`));
    changed();
  }

  function setCustomerField(change: Partial<CustomerForm>) {
    setCustomer((c) => ({ ...c, ...change }));
    if ("name" in change) setUnsure((u) => u.filter((f) => f !== "customer_name"));
    if ("is_business" in change) setUnsure((u) => u.filter((f) => f !== "customer_is_business"));
    changed();
  }

  const lineNet = (line: Line) => Math.round(toNumber(line.quantity) * toNumber(line.price) * 100);
  const net = lines.reduce((sum, line) => sum + lineNet(line), 0);

  async function saveAndCheck() {
    setBusy(true);
    setError("");
    try {
      if (!customer.name.trim()) throw new Error("Please enter the customer's name.");
      const customerBody = {
        name: customer.name,
        street: customer.street,
        postcode: customer.postcode,
        city: customer.city,
        email: customer.email,
        is_business: customer.is_business,
        language: customer.language,
      };
      const savedCustomer = customer.id
        ? await put(`/api/customers/${customer.id}`, customerBody)
        : await post("/api/customers", customerBody);
      setCustomer((c) => ({ ...c, id: savedCustomer.id }));
      const body = {
        customer_id: savedCustomer.id,
        lines: lines.map((line) => ({
          description: line.description,
          quantity: toNumber(line.quantity),
          unit: line.unit,
          unit_price_eur: toNumber(line.price),
          vat_percent: toNumber(line.vat),
        })),
        issue_date: dates.issue || null,
        service_date: dates.service || null,
        due_date: dates.due || null,
        property_work: propertyWork,
        source_text: capture?.source_text || "",
        capture_source: capture?.source || "manual",
      };
      const draft = draftId ? await put(`/api/invoices/${draftId}`, body) : await post("/api/invoices", body);
      setDraftId(draft.id);
      setCheck(await post(`/api/invoices/${draft.id}/check`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    setBusy(true);
    setError("");
    try {
      const issued = await post(`/api/invoices/${draftId}/issue`);
      refresh();
      window.location.hash = `#/invoices/${issued.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const flag = (field: string) => (unsure.includes(field) ? "unsure" : "");

  return (
    <>
      <h1>New invoice</h1>
      <section className="card">
        <h2>1. Your job note</h2>
        <p className="muted">Type it as it comes, or upload a PDF or a photo. Your files stay on this computer.</p>
        <textarea
          rows={3}
          value={note}
          maxLength={4000}
          placeholder={EXAMPLE}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="button-row">
          <button className="primary" disabled={reading} onClick={read}>
            {reading ? "Reading..." : "Read note"}
          </button>
          <button disabled={reading} onClick={() => fileInput.current?.click()}>
            Upload PDF or photo
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <button className="link" disabled={reading} onClick={() => setNote(EXAMPLE)}>
            Use an example
          </button>
          {reading && <span className="muted small">Clear notes are instant. For messy ones the AI runs on this laptop, which can take a minute or two.</span>}
        </div>
      </section>

      {error && <div className="alert error">{error}</div>}

      {capture && (
        <section className="card">
          <div className="title-row">
            <h2>2. Check the details</h2>
            <span className="chip">{capture.source === "ai" ? "Read by local AI" : "Read by fixed rules"}</span>
          </div>
          {capture.warnings?.map((text: string) => (
            <div className="alert warn" key={text}>
              ! {text}
            </div>
          ))}
          {unsure.length > 0 && <p className="note-unsure">! Fields in yellow were missing or not found in your note. Please check them.</p>}

          <h3>Customer</h3>
          <label className="wide">
            Choose an existing customer
            <select
              value={customer.id ?? ""}
              onChange={(e) => {
                const chosen = customers.find((c) => c.id === Number(e.target.value));
                setCustomer(chosen ? { ...chosen } : { ...EMPTY_CUSTOMER, name: customer.name });
                setUnsure((u) => u.filter((f) => f !== "customer_name" && f !== "customer_is_business"));
                changed();
              }}
            >
              <option value="">New customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            <label className={flag("customer_name")}>
              Name
              <input value={customer.name} onChange={(e) => setCustomerField({ name: e.target.value })} />
            </label>
            <label>
              Email (for the PayPal request)
              <input type="email" value={customer.email} onChange={(e) => setCustomerField({ email: e.target.value })} />
            </label>
            <label>
              Street
              <input value={customer.street} onChange={(e) => setCustomerField({ street: e.target.value })} />
            </label>
            <div className="form-pair">
              <label>
                Postcode
                <input value={customer.postcode} onChange={(e) => setCustomerField({ postcode: e.target.value })} />
              </label>
              <label>
                City
                <input value={customer.city} onChange={(e) => setCustomerField({ city: e.target.value })} />
              </label>
            </div>
            <label className={flag("customer_is_business")}>
              Customer type
              <select value={customer.is_business ? "b" : "p"} onChange={(e) => setCustomerField({ is_business: e.target.value === "b" })}>
                <option value="b">Business</option>
                <option value="p">Private person</option>
              </select>
            </label>
            <label>
              Customer's language
              <select value={customer.language} onChange={(e) => setCustomerField({ language: e.target.value })}>
                <option value="de">German</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>

          <h3>Work and material</h3>
          <div className="lines">
            {lines.map((line, index) => (
              <div className="line" key={index}>
                <label className={`grow ${flag(`lines.${index}.description`)}`}>
                  What
                  <input value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} />
                </label>
                <label className={flag(`lines.${index}.quantity`)}>
                  Qty
                  <input inputMode="decimal" value={line.quantity} onChange={(e) => setLine(index, { quantity: e.target.value })} />
                </label>
                <label>
                  Unit
                  <select value={line.unit} onChange={(e) => setLine(index, { unit: e.target.value })}>
                    <option value="HUR">hours</option>
                    <option value="H87">pieces</option>
                  </select>
                </label>
                <label className={flag(`lines.${index}.unit_price`)}>
                  Net price (EUR)
                  <input inputMode="decimal" value={line.price} onChange={(e) => setLine(index, { price: e.target.value })} />
                </label>
                <label>
                  VAT %
                  <select value={line.vat} onChange={(e) => setLine(index, { vat: e.target.value })}>
                    <option value="19">19</option>
                    <option value="7">7</option>
                    <option value="0">0</option>
                  </select>
                </label>
                <div className="line-total">{eur(lineNet(line))}</div>
                <button
                  className="link"
                  aria-label="Remove this item"
                  onClick={() => {
                    setLines((all) => all.filter((_, i) => i !== index));
                    changed();
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="button-row spread">
            <button
              onClick={() => {
                setLines((all) => [...all, { description: "", quantity: "1", unit: "H87", price: "", vat: lines[0]?.vat || "19" }]);
                changed();
              }}
            >
              Add item
            </button>
            <strong>Net total: {eur(net)}</strong>
          </div>

          <h3>Dates</h3>
          <div className="form-grid three">
            <label>
              Invoice date
              <input type="date" value={dates.issue} onChange={(e) => (setDates({ ...dates, issue: e.target.value }), changed())} />
            </label>
            <label className={flag("service_date")}>
              Work done on
              <input
                type="date"
                value={dates.service}
                onChange={(e) => {
                  setDates({ ...dates, service: e.target.value });
                  setUnsure((u) => u.filter((f) => f !== "service_date"));
                  changed();
                }}
              />
            </label>
            <label>
              Payment due
              <input type="date" value={dates.due} onChange={(e) => (setDates({ ...dates, due: e.target.value }), changed())} />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={propertyWork}
              onChange={(e) => {
                setPropertyWork(e.target.checked);
                changed();
              }}
            />
            This is work on a building or land (matters for private customers)
          </label>

          <div className="button-row">
            <button className="primary" disabled={busy || lines.length === 0} onClick={saveAndCheck}>
              {busy && !check ? "Checking..." : "Check invoice"}
            </button>
          </div>
        </section>
      )}

      {check && (
        <section className="card">
          <h2>3. Legal check</h2>
          {check.issues.length === 0 && <p>✓ No problems found.</p>}
          <ul className="issues">
            {check.issues.map((issue: any) => (
              <li key={`${issue.rule_id}-${issue.field}`} className={issue.severity}>
                <span className="issue-tag">{issue.severity === "error" ? "! Must fix" : issue.severity === "warning" ? "! Look" : "i Note"}</span>
                <div>
                  <strong>{issue.message}</strong>
                  <div className="small">{issue.fix}</div>
                  <div className="muted small">{issue.law}</div>
                </div>
              </li>
            ))}
          </ul>
          {check.notes_to_print.length > 0 && (
            <div className="printed-notes">
              <strong>These notes will be printed on the invoice:</strong>
              <ul className="plain">
                {check.notes_to_print.map((text: string) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          )}
          {check.can_issue ? (
            <div className="button-row">
              <button className="primary big" disabled={busy} onClick={issue}>
                {busy ? "Creating e-invoice and PayPal request..." : "Issue invoice"}
              </button>
              <span className="muted small">Creates the e-invoice, checks it against the official rules, and creates the PayPal request.</span>
            </div>
          ) : (
            <p className="note-unsure">! Fix the items above, then click "Check invoice" again.</p>
          )}
        </section>
      )}
    </>
  );
}
