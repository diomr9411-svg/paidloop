// Navigation is data: every screen once, with its address, page file, template, title and menu entry.
// The menu, the page titles, the loading shape and the browser walk all read this list.
// `npm run check:ui` fails if a page file has no route here, or a route points to a missing page.
import type { Key } from "./i18n";
import type { IconName } from "./ui/icon-names";
import type { Shape } from "./ui/Loading";
import type { Template } from "./ui/PageHeader";

export interface Route {
  id: string;
  /** The address. `{id}` and `{token}` stand for a record; `example` is a real address for the walk. */
  hash: string;
  page: string;
  template: Template;
  title: Key;
  nav?: { label: Key; icon: IconName; key: string };
  /** The menu link that stays current on this route (a record under a list). */
  under?: string;
  hidden?: boolean;
}

export const ROUTES: Route[] = [
  { id: "home", hash: "#/", page: "Dashboard", template: "dashboard", title: "navHome", nav: { label: "navHome", icon: "house", key: "h" } },
  { id: "new", hash: "#/new", page: "NewInvoice", template: "wizard", title: "navNew", nav: { label: "navNew", icon: "file-plus", key: "n" } },
  { id: "invoices", hash: "#/invoices", page: "Invoices", template: "list", title: "navInvoices", nav: { label: "navInvoices", icon: "receipt-text", key: "i" } },
  { id: "invoice", hash: "#/invoices/{id}", page: "InvoiceDetail", template: "detail", title: "navInvoices", under: "invoices" },
  { id: "approvals", hash: "#/approvals", page: "Approvals", template: "list", title: "navApprovals", nav: { label: "navApprovals", icon: "inbox", key: "a" } },
  { id: "audit", hash: "#/audit", page: "Audit", template: "list", title: "navAudit", nav: { label: "navAudit", icon: "shield-check", key: "" } },
  { id: "settings", hash: "#/settings", page: "Settings", template: "settings", title: "navSettings", nav: { label: "navSettings", icon: "settings", key: "" } },
  { id: "pay", hash: "#/pay/{token}", page: "PayPage", template: "customer", title: "invoiceFrom", hidden: true },
  { id: "design", hash: "#/design", page: "Design", template: "catalogue", title: "designTitle", hidden: true },
];

export const NAV = ROUTES.filter((route) => route.nav);

/** Finds the route for an address. Unknown addresses go Home. */
export function findRoute(hash: string): { route: Route; param: string } {
  const path = (hash || "#/").split("?")[0];
  for (const route of ROUTES) {
    const pattern = new RegExp("^" + route.hash.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(id|token)\}/, "([\\w-]+)") + "/?$");
    const match = path.match(pattern);
    if (match) return { route, param: match[1] || "" };
  }
  // A deeper address under a known one (e.g. #/settings/connections) belongs to it.
  const parent = ROUTES.find((route) => route.hash !== "#/" && !route.hash.includes("{") && path.startsWith(route.hash + "/"));
  return { route: parent || ROUTES[0], param: "" };
}

export const SHAPE: Record<Template, Shape> = {
  dashboard: "dashboard",
  list: "list",
  detail: "detail",
  wizard: "form",
  settings: "form",
  customer: "cards",
  catalogue: "cards",
};
