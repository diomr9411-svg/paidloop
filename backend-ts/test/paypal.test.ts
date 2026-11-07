import { describe, expect, it } from "vitest";
import { PaymentRequest, PayPalClient, PayPalError, parseQr, SimulatedPayPal } from "../src/paypal";
import { Secret } from "../src/settings";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function makeClient(handler: Handler): PayPalClient {
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "tok", expires_in: 3600 });
    return handler(url, init);
  }) as typeof fetch;
  return new PayPalClient({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: new Secret("secret"), fetch: fakeFetch, sleep: async () => undefined });
}

const REQUEST: PaymentRequest = {
  number: "RE-1", issue_date: "2026-11-07", due_date: "2026-11-21", note: "Note", recipient_name: "Kunde", recipient_email: "k@example.com",
  lines: [{ name: "Arbeit", quantity: "4", unit_price_cents: 6500, vat_percent: "19", hours: true }],
};

describe("PayPal client against a fake server", () => {
  it("create invoice sends the correct body", async () => {
    let seen: any;
    let requestId: string | undefined;
    const client = makeClient((_url, init) => {
      seen = JSON.parse(String(init.body));
      requestId = (init.headers as Record<string, string>)["PayPal-Request-Id"];
      return Response.json({ id: "INV2-1" }, { status: 201 });
    });
    expect(await client.createInvoice(REQUEST)).toBe("INV2-1");
    expect(seen.items[0].unit_amount.value).toBe("65.00");
    expect(seen.items[0].unit_of_measure).toBe("HOURS");
    expect(seen.items[0].tax.percent).toBe("19");
    expect(seen.detail.currency_code).toBe("EUR");
    expect(requestId).toBeTruthy();
  });

  it("a duplicate number finds the existing invoice instead of failing", async () => {
    const client = makeClient((url) =>
      url.pathname === "/v2/invoicing/invoices"
        ? Response.json({ details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }] }, { status: 422 })
        : Response.json({ items: [{ id: "INV2-EXISTING" }] }),
    );
    expect(await client.createInvoice(REQUEST)).toBe("INV2-EXISTING");
  });

  it("server errors are retried with the same request id", async () => {
    const ids: (string | undefined)[] = [];
    const client = makeClient((_url, init) => {
      ids.push((init.headers as Record<string, string>)["PayPal-Request-Id"]);
      return ids.length < 3 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
    });
    await client.remind("INV2-1", "Subject", "Note");
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("errors never contain keys", async () => {
    const client = makeClient(() => Response.json({ message: "Bad", details: [{ issue: "X", description: "Nope" }] }, { status: 400 }));
    const error = await client.send("INV2-1").catch((e) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect(error.issue).toBe("X");
    expect(String(error.message)).not.toContain("secret");
    expect(JSON.stringify(new Secret("secret"))).not.toContain("secret");
  });

  it("an expired token is refreshed once", async () => {
    let calls = 0;
    const client = makeClient(() => (++calls === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 204 })));
    await client.send("INV2-1");
    expect(calls).toBe(2);
  });

  it("the state is parsed from the real PayPal shape", async () => {
    const body = {
      id: "INV2-1", status: "PARTIALLY_PAID", due_amount: { currency_code: "EUR", value: "352.20" },
      detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#INV2-1" } },
      payments: {
        paid_amount: { currency_code: "EUR", value: "100.00" },
        transactions: [{ payment_id: "EXTR-1", payment_date: "2026-11-07", method: "BANK_TRANSFER", amount: { currency_code: "EUR", value: "100.00" } }],
      },
    };
    const state = await makeClient(() => Response.json(body)).get("INV2-1");
    expect(state.paid_cents).toBe(10000);
    expect(state.due_cents).toBe(35220);
    expect(state.transactions[0].external_id).toBe("EXTR-1");
    expect(state.transactions[0].paid_on).toBe("2026-11-07");
    expect(state.pay_link!.startsWith("https://www.sandbox.paypal.com")).toBe(true);
  });

  it("the QR png is read from a multipart body", () => {
    const text = '--abc\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\niVBORw0KGgo=\r\n--abc--';
    expect(parseQr("multipart/form-data; boundary=abc", text)!.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it("a webhook without signature headers is refused", async () => {
    const client = makeClient(() => Response.json({ verification_status: "SUCCESS" }));
    expect(await client.verifyWebhook("WH-1", {}, { id: "1" })).toBe(false);
    expect(await client.verifyWebhook("", { "paypal-auth-algo": "x" }, { id: "1" })).toBe(false);
  });

  it("refuses to run when the keys are wrong", async () => {
    const client = new PayPalClient({
      baseUrl: "https://api-m.sandbox.paypal.com", clientId: "x", clientSecret: new Secret("y"),
      fetch: (async () => new Response("no", { status: 401 })) as typeof fetch,
    });
    await expect(client.get("INV2-1")).rejects.toThrow("PayPal refused the sandbox keys");
  });
});

describe("simulator", () => {
  it("matches the real status flow", async () => {
    const sim = new SimulatedPayPal();
    const key = await sim.createInvoice(REQUEST);
    expect(await sim.createInvoice(REQUEST)).toBe(key);
    await sim.send(key);
    expect((await sim.get(key)).status).toBe("SENT");
    expect((await sim.get(key)).due_cents).toBe(30940);
    sim.pay(key, 10000);
    expect((await sim.get(key)).status).toBe("PARTIALLY_PAID");
    sim.pay(key);
    const state = await sim.get(key);
    expect(state.status).toBe("PAID");
    expect(state.due_cents).toBe(0);
    expect(state.transactions).toHaveLength(2);
  });
});
