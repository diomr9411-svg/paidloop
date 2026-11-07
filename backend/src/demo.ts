// Made-up demo data with one-click reset. All names, addresses and tax IDs here are fictional.
import { randomBytes } from "node:crypto";
import { addDays, realToday } from "./dates";
import { Db } from "./db";
import * as invoices from "./invoices";
import { InvoiceError, LineInput } from "./invoices";
import { t } from "./i18n";
import { PayPalApi } from "./paypal";
import { createCustomer, Customer, Invoice } from "./repo";

const EXAMPLE_EMAIL = "customer@example.com";

async function issue(db: Db, paypal: PayPalApi, customer: Customer, lines: LineInput[], issuedDaysAgo: number, paymentDays: number, propertyWork: boolean): Promise<Invoice> {
  const on = addDays(realToday(), -issuedDaysAgo);
  const draft = invoices.saveDraft(db, null, {
    customer_id: customer.id, lines, issue_date: on, service_date: addDays(on, -2), due_date: addDays(on, paymentDays), property_work: propertyWork,
  });
  const result = invoices.runCheck(db, draft);
  if (!result.can_issue) throw new InvoiceError(t(`Demo invoice failed the check: ${result.issues.map((i) => i.rule_id).join(", ")}`));
  return invoices.issue(db, draft, paypal);
}

const line = (description: string, quantity_milli: number, unit: string, unit_price_cents: number): LineInput => ({
  description, quantity_milli, unit, unit_price_cents, vat_bp: 1900,
});

/** Clear everything and create the demo story. PayPal keeps old sandbox invoices, so numbers get a new suffix. */
export async function reset(db: Db, paypal: PayPalApi, buyerEmail: string): Promise<void> {
  db.dropAll(); // also picks up new columns after an update
  db.insert("business", {
    name: "Beispiel Elektro GmbH", street: "Musterstraße 1", postcode: "32657", city: "Lemgo", country: "DE", vat_id: "DE000000000",
    email: "owner@example.com", small_business: false, vat_method: "soll", paypal_suffix: randomBytes(3).toString("hex").toUpperCase(),
  });

  const email = buyerEmail || EXAMPLE_EMAIL;
  const bakery = createCustomer(db, { email, name: "Bäckerei Muster GmbH", street: "Musterweg 2", postcode: "32756", city: "Detmold", is_business: true, language: "de", history_paid_count: 9, history_avg_days_late: 1 });
  const cafe = createCustomer(db, { email, name: "Café Beispiel UG", street: "Beispielplatz 5", postcode: "32052", city: "Herford", is_business: true, language: "de", history_paid_count: 6, history_avg_days_late: 18, history_unpaid_count: 1 });
  const priv = createCustomer(db, { email, name: "Anna Beispiel", street: "Testallee 7", postcode: "32760", city: "Detmold", is_business: false, language: "de" });
  const studio = createCustomer(db, { email, name: "Sample Studio Ltd", street: "Example Road 3", postcode: "33602", city: "Bielefeld", is_business: true, language: "en", history_paid_count: 4, history_avg_days_late: 2 });

  const paid = await issue(db, paypal, studio, [line("Office wiring check", 3000, "HUR", 7000)], 25, 14, false);
  await paypal.recordPayment(paid.paypal_id!, paid.gross_cents, addDays(realToday(), -9), "Demo payment");
  await invoices.sync(db, paid, paypal);

  await issue(db, paypal, bakery, [line("Reparatur Ofenanschluss", 2500, "HUR", 7000), line("Material", 1000, "H87", 8990)], 5, 14, true);
  await issue(db, paypal, cafe, [line("Küchenbeleuchtung erneuert", 6000, "HUR", 6500), line("LED-Panels", 4000, "H87", 8900)], 20, 14, true);
  await issue(db, paypal, priv, [line("Reparatur Elektrik im Bad", 4000, "HUR", 6500), line("Material", 1000, "H87", 12000)], 16, 14, true);
}
