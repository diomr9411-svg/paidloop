import { CSSProperties, useState } from "react";

import { useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { Badge, Dot } from "../ui/Badge";
import { BarRows } from "../ui/BarRows";
import { Button, ButtonLink } from "../ui/Button";
import { SectionCard } from "../ui/Card";
import { ConfirmButton } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { Checkbox, Field, FieldGrid, Switch } from "../ui/Field";
import { Icon, IconTile, InitialsTile } from "../ui/Icon";
import { ICON_NAMES } from "../ui/icon-names";
import { Page, PageHeader } from "../ui/PageHeader";
import { SearchField } from "../ui/SearchField";
import { StatTile } from "../ui/StatTile";
import { Stepper } from "../ui/Stepper";
import { FilterTabs, Segmented } from "../ui/Tabs";
import { useToast } from "../ui/Toast";
import { Tooltip } from "../ui/Tooltip";
import { ActorBadge } from "../widgets/events";
import type { PageProps } from "../widgets/page";
import { StatusBadge } from "../widgets/StatusBadge";

const ROLES = [
  "canvas", "surface", "raised", "sunken", "paper", "band", "brand-surface", "line", "line-strong",
  "text", "text-muted", "link", "primary", "primary-hover", "selected-bg", "tile-bg",
  "info-bg", "good-bg", "warn-bg", "bad-bg", "good-mark", "warn-mark", "bad-mark", "bar", "track",
];
const TYPE = ["3xl", "2xl", "xl", "lg", "sm", "meta", "xs", "2xs"];

/** The design catalogue: every token and every part in each state, in the current theme and density. Not in the menu. */
export function Design(_props: PageProps) {
  const { t, eur } = useT();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [choice, setChoice] = useState<"a" | "b" | "c">("a");
  const [on, setOn] = useState(true);
  return (
    <Page template="catalogue">
      <PageHeader title={t("designTitle")} info={t("designIntro")} />

      <SectionCard title={t("designColours")} icon="sun">
        <ul className="swatches">
          {ROLES.map((role) => (
            <li key={role} className="swatch" style={{ "--swatch": `var(--${role})` } as CSSProperties}>
              <span className="swatch-chip" />
              <code>--{role}</code>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={t("designType")} icon="file-text">
        <ul className="type-samples">
          {TYPE.map((size) => (
            <li key={size} className={`type-${size}`}>
              <code>--text-{size}</code> {t("homeTitle")} 1.234,50 €
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={t("designButtons")} icon="check">
        <div className="button-row">
          <Button tone="primary" icon="file-plus">
            {t("newInvoice")}
          </Button>
          <Button icon="download">{t("downloadPdf")}</Button>
          <Button tone="ghost" icon="pencil">
            {t("editDetails")}
          </Button>
          <Button tone="danger" icon="trash">
            {t("deleteDraft")}
          </Button>
          <Button tone="link">{t("useExample")}</Button>
        </div>
        <div className="button-row">
          <Button tone="primary" size="lg" icon="send">
            {t("issueInvoice")}
          </Button>
          <Button size="sm" icon="refresh-cw">
            {t("retry")}
          </Button>
          <Button tone="primary" busy pending={t("saving")}>
            {t("save")}
          </Button>
          <Button disabled>{t("save")}</Button>
          <Button tone="ghost" icon="x" iconOnly>
            {t("close")}
          </Button>
          <ButtonLink href="#/design" iconEnd="arrow-right">
            {t("queueOpen")}
          </ButtonLink>
        </div>
      </SectionCard>

      <SectionCard title={t("designBadges")} icon="list-checks">
        <div className="badge-row">
          <Badge>{t("filterDraft")}</Badge>
          <Badge tone="info" icon="clock">
            {t("filterOpen")}
          </Badge>
          <Badge tone="good" icon="circle-check">
            {t("filterPaid")}
          </Badge>
          <Badge tone="warn" icon="triangle-exclamation-point">
            {t("daysLate", { n: 7 })}
          </Badge>
          <Badge tone="bad" icon="circle-x">
            {t("mustFix")}
          </Badge>
          <StatusBadge status="on_plan" />
          <StatusBadge status="cancelled" />
          <ActorBadge actor="ai" />
          <ActorBadge actor="owner" />
          <span className="dot-sample">
            <Dot tone="good" /> PayPal
          </span>
          <InitialsTile name="Bäckerei Muster GmbH" />
          <IconTile name="wallet" />
          <IconTile name="triangle-exclamation-point" tone="warn" />
        </div>
      </SectionCard>

      <SectionCard title={t("designFields")} icon="pencil">
        <FieldGrid>
          <Field id="design-name" label={t("customerName")} help={t("customerNameHint")} emphasis>
            <input defaultValue="Café Beispiel UG" />
          </Field>
          <Field id="design-email" label={t("email")} note={t("secretKeep", { hint: "1234" })}>
            <input type="email" defaultValue="cafe@example.com" />
          </Field>
          <Field id="design-error" label={t("netPrice")} error={t("amountAboveZero")}>
            <input defaultValue="0" />
          </Field>
          <Field id="design-unsure" label={t("workDate")} unsure>
            <input type="date" defaultValue="2026-11-05" />
          </Field>
          <Field id="design-select" label={t("customerType")}>
            <select defaultValue="b">
              <option value="b">{t("typeBusiness")}</option>
              <option value="p">{t("typePrivate")}</option>
            </select>
          </Field>
          <Field id="design-disabled" label={t("aiAddress")}>
            <input disabled defaultValue="http://localhost:11434" />
          </Field>
        </FieldGrid>
        <Switch id="design-switch" label={t("aiUse")} help={t("aiUseHint")} checked={on} onChange={(event) => setOn(event.target.checked)} />
        <Checkbox id="design-check" label={t("propertyWork")} />
        <SearchField id="design-search" label={t("searchInvoices")} value={search} onChange={setSearch} />
        <Segmented
          label={t("theme")}
          value={choice}
          onChange={setChoice}
          options={[
            { value: "a", label: t("themeAuto"), icon: "monitor" },
            { value: "b", label: t("themeLight"), icon: "sun" },
            { value: "c", label: t("themeDark"), icon: "moon" },
          ]}
        />
        <FilterTabs
          label={t("filterBy")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "all", label: t("filterAll"), count: 4 },
            { value: "open", label: t("filterOpen"), count: 3 },
            { value: "paid", label: t("filterPaid"), count: 1 },
          ]}
        />
      </SectionCard>

      <SectionCard title={t("designAlerts")} icon="info">
        <Alert tone="info">{t("draftRestored")}</Alert>
        <Alert tone="good">{t("checkOk")}</Alert>
        <Alert tone="warn" title={t("connectPaypal")} action={<Button size="sm">{t("connectPaypal")}</Button>}>
          {t("connectPaypalHint")}
        </Alert>
        <Alert tone="bad">{t("checkRefused")}</Alert>
        <ErrorBox text={t("paypalProblem")} onRetry={() => undefined} />
      </SectionCard>

      <div className="tiles">
        <StatTile label={t("waitingToBePaid")} value={eur(165517)} note={t("invoiceCount", { n: 3 })} icon="hourglass" href="#/design" />
        <StatTile label={t("overdue")} value={eur(133994)} note={t("invoiceCount", { n: 2 })} icon="triangle-exclamation-point" tone="warn" />
        <StatTile label={t("onPlanTile")} value={eur(0)} note={t("onPlanNote")} icon="calendar-clock" />
        <StatTile label={t("onHoldTile")} value={eur(0)} note={t("onHoldNote")} icon="circle-pause" />
      </div>

      <div className="columns">
        <SectionCard title={t("whenMoney")} icon="calendar">
          <BarRows
            label={t("moneyByDate")}
            rows={[
              { key: "a", label: t("next7"), value: 45220, display: eur(45220), hint: t("next7Hint") },
              { key: "b", label: t("next30"), value: 31523, display: eur(31523), hint: t("next30Hint") },
              { key: "c", label: t("later"), value: 0, display: eur(0), hint: t("laterHint") },
              { key: "d", label: t("atRisk"), value: 88774, display: eur(88774), hint: t("atRiskHint"), risk: true },
            ]}
          />
        </SectionCard>
        <SectionCard title={t("designStates")} icon="list-checks">
          <Stepper steps={[t("stepNote"), t("stepDetails"), t("stepCheck"), t("stepDone")]} current={1} label={t("stepsLabel")} />
          <EmptyState icon="inbox" tone="good" title={t("nothingWaiting")} hint={t("nothingWaitingHint")} action={<Button icon="sparkles">{t("runAgent")}</Button>} />
        </SectionCard>
      </div>

      <SectionCard title={t("designOverlays")} icon="sliders-horizontal">
        <div className="button-row">
          <ConfirmButton label={t("cancelInvoice")} icon="ban" title={t("cancelTitle", { number: "RE-2026-0003" })} body={t("cancelHint")} confirmLabel={t("cancelConfirm")} onConfirm={() => undefined} />
          <Button icon="circle-check" onClick={() => toast(t("saved"))}>
            {t("designToast")}
          </Button>
          <Tooltip text={t("next7Hint")}>
            <Button tone="ghost" icon="info">
              {t("designTooltip")}
            </Button>
          </Tooltip>
        </div>
      </SectionCard>

      <SectionCard title={t("designIcons")} icon="sparkles" subtitle={t("designIconsHint", { n: ICON_NAMES.length })}>
        <ul className="icon-grid">
          {ICON_NAMES.map((name) => (
            <li key={name}>
              <Icon name={name} size="lg" />
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </SectionCard>
    </Page>
  );
}
