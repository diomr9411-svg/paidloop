import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { Empty, ErrorBox, Loading, StatusPill } from "../components";
import { Key, useT } from "../i18n";

const FILTERS: [string, Key][] = [
  ["all", "filterAll"],
  ["open", "filterOpen"],
  ["overdue", "filterOverdue"],
  ["on_plan", "filterOnPlan"],
  ["disputed", "filterOnHold"],
  ["draft", "filterDraft"],
  ["paid", "filterPaid"],
  ["cancelled", "filterCancelled"],
];

type View = { filter: string; q: string; sort: string; dir: string; page: number };

const START: View = { filter: "all", q: "", sort: "newest", dir: "desc", page: 1 };

// The choice lives in the address, so links can point to it and the back button restores it.
function readView(): View {
  const query = new URLSearchParams(window.location.hash.split("?")[1] || "");
  return {
    filter: query.get("filter") || START.filter,
    q: query.get("q") || START.q,
    sort: query.get("sort") || START.sort,
    dir: query.get("dir") === "asc" ? "asc" : START.dir,
    page: Math.max(Number(query.get("page")) || 1, 1),
  };
}

function viewQuery(view: View): string {
  const query = new URLSearchParams();
  if (view.filter !== START.filter) query.set("filter", view.filter);
  if (view.q) query.set("q", view.q);
  if (view.sort !== START.sort) query.set("sort", view.sort);
  if (view.dir !== START.dir) query.set("dir", view.dir);
  if (view.page !== START.page) query.set("page", String(view.page));
  return query.toString();
}

function SortHeader({ name, label, view, change, numeric }: { name: string; label: string; view: View; change: (c: Partial<View>) => void; numeric?: boolean }) {
  const { t } = useT();
  const active = view.sort === name;
  const ascending = active && view.dir === "asc";
  return (
    <th scope="col" className={numeric ? "num" : ""} aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}>
      <button
        className="sort"
        aria-label={t("sortBy", { name: label })}
        onClick={() => change({ sort: name, dir: active && !ascending ? "asc" : "desc", page: 1 })}
      >
        {label}
        <span aria-hidden="true">{active ? (ascending ? " ▲" : " ▼") : ""}</span>
      </button>
    </th>
  );
}

export function Invoices({ version }: { version: number }) {
  const { t, eur, day } = useT();
  const [view, setView] = useState<View>(readView);
  const [typed, setTyped] = useState(view.q);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  const change = (update: Partial<View>) => setView((current) => ({ ...current, ...update }));

  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith("#/invoices")) return;
      const next = readView();
      setView(next);
      setTyped(next.q);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Search after a short pause in typing, not on every key.
  useEffect(() => {
    if (typed === view.q) return;
    const timer = window.setTimeout(() => change({ q: typed.trim(), page: 1 }), 250);
    return () => window.clearTimeout(timer);
  }, [typed, view.q]);

  useEffect(() => {
    const query = viewQuery(view);
    window.history.replaceState(null, "", `#/invoices${query ? `?${query}` : ""}`);
    const ticket = ++latest.current;
    const params = new URLSearchParams({ filter: view.filter, sort: view.sort, dir: view.dir, page: String(view.page), size: "25" });
    if (view.q) params.set("q", view.q);
    api(`/api/invoices?${params}`)
      .then((body) => {
        if (ticket !== latest.current) return; // an older answer must not replace a newer one
        setData(body);
        setError("");
      })
      .catch((e) => ticket === latest.current && setError(e.message));
  }, [view, version, attempt]);

  if (error && !data) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!data) return <Loading />;

  const from = data.total === 0 ? 0 : (data.page - 1) * data.size + 1;
  const to = Math.min(data.page * data.size, data.total);
  const isFiltered = view.filter !== "all" || !!view.q;

  return (
    <>
      <div className="title-row">
        <h1>{t("invoices")}</h1>
        <a className="button primary" href="#/new">
          {t("newInvoice")}
        </a>
      </div>
      {error && <ErrorBox text={error} />}

      <div className="list-tools">
        <div className="filters" role="group" aria-label={t("filterBy")}>
          {FILTERS.map(([name, key]) => (
            <button key={name} className={`filter ${view.filter === name ? "selected" : ""}`} aria-pressed={view.filter === name} onClick={() => change({ filter: name, page: 1 })}>
              {t(key)} <span className="count">{data.counts[name] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="search">
          <input
            type="search"
            aria-label={t("searchInvoices")}
            placeholder={t("searchInvoices")}
            value={typed}
            maxLength={100}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      </div>

      {data.items.length === 0 ? (
        <div className="card">
          <Empty
            title={isFiltered ? t("noMatches") : t("noInvoices")}
            action={
              isFiltered ? (
                <button
                  onClick={() => {
                    setTyped("");
                    change({ filter: "all", q: "", page: 1 });
                  }}
                >
                  {t("clearFilters")}
                </button>
              ) : (
                <a className="button primary" href="#/new">
                  {t("newInvoice")}
                </a>
              )
            }
          />
        </div>
      ) : (
        <>
          <div className="card table-card">
            <table className="clickable">
              <thead>
                <tr>
                  <SortHeader name="number" label={t("number")} view={view} change={change} />
                  <SortHeader name="customer" label={t("customer")} view={view} change={change} />
                  <SortHeader name="due" label={t("due")} view={view} change={change} />
                  <th scope="col">{t("status")}</th>
                  <SortHeader name="amount" label={t("total")} view={view} change={change} numeric />
                  <th scope="col" className="num">
                    {t("open")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row: any) => {
                  const draft = !row.number;
                  const href = draft ? `#/new?draft=${row.id}` : `#/invoices/${row.id}`;
                  return (
                    <tr key={row.id} onClick={() => (window.location.hash = href)}>
                      <td>
                        <a href={href} onClick={(event) => event.stopPropagation()}>
                          {row.number || t("draftNumber", { id: row.id })}
                        </a>
                        {row.has_pending && (
                          <span className="pill warn small-pill" title={t("nowWaiting")}>
                            !
                          </span>
                        )}
                      </td>
                      <td>{row.customer?.name || "-"}</td>
                      <td className="nowrap">{day(row.due_date)}</td>
                      <td>
                        <StatusPill status={row.status} overdue={row.days_overdue} />
                      </td>
                      <td className="num">{eur(row.gross_cents)}</td>
                      <td className="num">{eur(row.open_cents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label={t("pagination")}>
            <span className="muted small" role="status">
              {t("pageOf", { from, to, total: data.total })}
            </span>
            <div className="button-row tight">
              <button disabled={data.page <= 1} onClick={() => change({ page: data.page - 1 })}>
                {t("previous")}
              </button>
              <button disabled={to >= data.total} onClick={() => change({ page: data.page + 1 })}>
                {t("next")}
              </button>
            </div>
          </nav>
        </>
      )}
    </>
  );
}
