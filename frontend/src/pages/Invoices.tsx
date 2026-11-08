import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { Key, useT } from "../i18n";
import { ErrorBox } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button, ButtonLink } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { Loading, Rereading } from "../ui/Loading";
import { Page, PageHeader } from "../ui/PageHeader";
import { SearchField } from "../ui/SearchField";
import { FilterTabs } from "../ui/Tabs";
import type { PageProps } from "../widgets/page";
import { StatusBadge } from "../widgets/StatusBadge";

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

const SORTS: [string, Key][] = [
  ["newest", "sortNewest"],
  ["number", "sortNumber"],
  ["customer", "sortCustomer"],
  ["due", "sortDue"],
  ["amount", "sortAmount"],
];

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
      <Button
        tone="ghost"
        size="sm"
        className={ascending ? "sort asc" : "sort"}
        iconEnd={active ? "chevron-down" : undefined}
        aria-label={t("sortBy", { name: label })}
        onClick={() => change({ sort: name, dir: active && !ascending ? "asc" : "desc", page: 1 })}
      >
        {label}
      </Button>
    </th>
  );
}

export function Invoices({ version }: PageProps) {
  const { t, eur, day } = useT();
  const [view, setView] = useState<View>(readView);
  const [typed, setTyped] = useState(view.q);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const [fetching, setFetching] = useState(false);
  const search = useRef<HTMLInputElement>(null);

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
    if (typed.trim() === view.q) return;
    const timer = window.setTimeout(() => change({ q: typed.trim(), page: 1 }), 250);
    return () => window.clearTimeout(timer);
  }, [typed, view.q]);

  useEffect(() => {
    const query = viewQuery(view);
    window.history.replaceState(null, "", `#/invoices${query ? `?${query}` : ""}`);
    const ticket = ++latest.current;
    setFetching(true);
    const params = new URLSearchParams({ filter: view.filter, sort: view.sort, dir: view.dir, page: String(view.page), size: "25" });
    if (view.q) params.set("q", view.q);
    api(`/api/invoices?${params}`)
      .then((body) => {
        if (ticket !== latest.current) return; // an older answer must not replace a newer one
        setData(body);
        setError("");
      })
      .catch((e) => ticket === latest.current && setError(e.message))
      .finally(() => ticket === latest.current && setFetching(false));
  }, [view, version, attempt]);

  // Typing "/" anywhere on the page jumps to the search box, unless a field already has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as HTMLElement).closest("input, textarea, select, dialog")) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error && !data) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!data) return <Loading shape="list" title={t("invoices")} />;

  const from = data.total === 0 ? 0 : (data.page - 1) * data.size + 1;
  const to = Math.min(data.page * data.size, data.total);
  const isFiltered = view.filter !== "all" || !!view.q;
  const pages = Math.ceil(data.total / data.size);

  return (
    <Page template="list">
      <PageHeader
        title={t("invoices")}
        actions={
          <ButtonLink tone="primary" icon="file-plus" href="#/new">
            {t("newInvoice")}
          </ButtonLink>
        }
      />
      {error && <ErrorBox text={error} />}

      <section className="card flush list-card" aria-label={t("invoices")}>
        <div className="list-toolbar">
          <FilterTabs
            label={t("filterBy")}
            value={view.filter}
            onChange={(filter) => change({ filter, page: 1 })}
            options={FILTERS.map(([name, key]) => ({ value: name, label: t(key), count: data.counts[name] ?? 0 }))}
          />
          <div className="list-toolbar-tools">
            <SearchField id="invoice-search" ref={search} label={t("searchInvoices")} placeholder={t("searchPlaceholder")} value={typed} onChange={setTyped} />
            <label className="sort-select">
              <span className="sr-only">{t("sortLabel")}</span>
              <select
                value={`${view.sort}:${view.dir}`}
                onChange={(event) => {
                  const [sort, dir] = event.target.value.split(":");
                  change({ sort, dir, page: 1 });
                }}
              >
                {SORTS.map(([name, key]) => (
                  <option key={name} value={`${name}:${name === "newest" ? "desc" : "asc"}`}>
                    {t("sortLabel")}: {t(key)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <Rereading active={fetching}>
          {data.items.length === 0 ? (
            <div className="card-pad">
              <EmptyState
                icon={isFiltered ? "search-x" : "receipt-text"}
                title={isFiltered ? t("noMatches") : t("noInvoices")}
                hint={isFiltered ? t("noMatchesHint") : t("noInvoicesHint")}
                action={
                  isFiltered ? (
                    <Button
                      icon="x"
                      onClick={() => {
                        setTyped("");
                        change({ filter: "all", q: "", page: 1 });
                      }}
                    >
                      {t("clearFilters")}
                    </Button>
                  ) : (
                    <ButtonLink tone="primary" icon="file-plus" href="#/new">
                      {t("newInvoice")}
                    </ButtonLink>
                  )
                }
              />
            </div>
          ) : (
            <table className="rtable sortable clickable">
              <thead>
                <tr>
                  <SortHeader name="customer" label={t("customer")} view={view} change={change} />
                  <SortHeader name="number" label={t("number")} view={view} change={change} />
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
                    // The whole row is a bigger mouse target; keyboard users open the same invoice through the link in its first cell.
                    <tr key={row.id} onClick={() => (window.location.hash = href)}>
                      <td className="lead" data-label="">
                        <span className="cell-line">
                          <a href={href} onClick={(event) => event.stopPropagation()}>
                            {row.customer?.name || t("draftUnnamed")}
                          </a>
                          {row.has_pending && (
                            <Badge tone="info" icon="inbox">
                              {t("waitingShort")}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className="muted nowrap id" data-label={t("number")}>
                        {row.number || t("draftNumber", { id: row.id })}
                      </td>
                      <td className="nowrap" data-label={t("due")}>
                        {day(row.due_date)}
                      </td>
                      <td data-label={t("status")}>
                        <StatusBadge status={row.status} overdue={row.days_overdue} />
                      </td>
                      <td className="num" data-label={t("total")}>
                        {eur(row.gross_cents)}
                      </td>
                      <td className="num strong" data-label={t("open")}>
                        {eur(row.open_cents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Rereading>

        {data.items.length > 0 && (
          <nav className="list-foot" aria-label={t("pagination")}>
            <span className="muted small" role="status">
              {t("pageOf", { from, to, total: data.total })}
            </span>
            {pages > 1 && (
              <div className="button-row">
                <Button size="sm" icon="chevron-left" disabled={data.page <= 1} onClick={() => change({ page: data.page - 1 })}>
                  {t("previous")}
                </Button>
                <Button size="sm" iconEnd="chevron-right" disabled={to >= data.total} onClick={() => change({ page: data.page + 1 })}>
                  {t("next")}
                </Button>
              </div>
            )}
          </nav>
        )}
      </section>
      <p className="status-line hide-phone">
        <Icon name="keyboard" size="sm" />
        {t("searchShortcutHint")}
      </p>
    </Page>
  );
}
