"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import {
  apiFetch,
  type AuditResponse,
  type MeResponse,
} from "../../../lib/api";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { HelpTip } from "../../../components/help-tip";
import { useToast } from "../../../components/toaster";
import { useI18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { dayTextToInput, endOfDateInput, fromDateInput } from "../../../lib/time";
import { auditDetails, auditLabel, auditParties } from "../../../lib/audit";

const roles = ["", "SUPER_ADMIN", "OWNER", "MANAGER", "PLAYER"] as const;
const ROLE_NAMES: Record<string, string> = { "": msg("All roles"), SUPER_ADMIN: msg("Super Admin"), OWNER: msg("Owner"), MANAGER: msg("Manager"), PLAYER: msg("Player") };

export function AuditLog() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, ts, date } = i18n;
  const dateLabel = (value: string) => date(value, { dateStyle: "medium", timeStyle: "short" });
  const [me, setMe] = useState<MeResponse | null>(null);
  const [result, setResult] = useState<AuditResponse | null>(null);
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [action, setAction] = useState("");
  const [role, setRole] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  const toast = useToast();

  async function load(nextPage = page) {
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    try {
      const profile = await apiFetch<MeResponse>("/users/me", token);
      setMe(profile);
      if (profile.role === "PLAYER") return;
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: "50",
      });
      if (actor.trim()) params.set("actor", actor.trim());
      if (target.trim()) params.set("target", target.trim());
      if (action.trim()) params.set("action", action.trim());
      if (role) params.set("role", role);
      // Dates are typed day/month/year; one that isn't a date is left out, and said so.
      const fromDay = from.trim() ? dayTextToInput(from) : null;
      const toDay = to.trim() ? dayTextToInput(to) : null;
      if ((from.trim() && !fromDay) || (to.trim() && !toDay)) toast.warning(t("Type dates as dd/mm/yyyy, for example 26/10/2026."));
      if (fromDay) params.set("from", fromDateInput(fromDay)?.toISOString() ?? "");
      if (toDay) params.set("to", endOfDateInput(toDay)?.toISOString() ?? "");
      setResult(
        await apiFetch<AuditResponse>(
          `/users/audit?${params.toString()}`,
          token,
        ),
      );
      setPage(nextPage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not load audit log"));
    } finally {
      setBusy(false);
    }
  }

  // The loader intentionally uses the current filter state and runs once on mount.
  useEffect(() => {
    load(1).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (me?.role === "PLAYER")
    return <p className="muted">{t("Audit logs are restricted to Super Admins, Owners and Managers.")}</p>;

  return (
    <div className="stack audit-log-component">
      <form
        className="card audit-filters"
        onSubmit={(event) => {
          event.preventDefault();
          load(1).catch(() => undefined);
        }}
      >
        <label>
          {t("Done by")}
          <input
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            placeholder={t("Username or ID")}
          />
        </label>
        <label>
          {t("Done to")}
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={t("Username or ID")}
          />
        </label>
        <label>
          {t("Action")}
          <input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder={t("e.g. user.update")}
          />
        </label>
        <label>
          {t("Role")}
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {t(ROLE_NAMES[value])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("From")}
          <input
            type="text"
            inputMode="numeric"
            placeholder={t("dd/mm/yyyy")}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            aria-invalid={from.trim() !== "" && !dayTextToInput(from)}
          />
        </label>
        <label>
          {t("To")}
          <input
            type="text"
            inputMode="numeric"
            placeholder={t("dd/mm/yyyy")}
            value={to}
            onChange={(event) => setTo(event.target.value)}
            aria-invalid={to.trim() !== "" && !dayTextToInput(to)}
          />
        </label>
        <div className="audit-filter-actions">
          <button type="submit" disabled={busy}>
            {t("Apply filters")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setActor("");
              setTarget("");
              setAction("");
              setRole("");
              setFrom("");
              setTo("");
              load(1).catch(() => undefined);
            }}
          >
            {t("Clear")}
          </button>
        </div>
      </form>
      <section className="card audit-table-card">
        <div className="tree-header">
          <span>
            {result ? t("{count} entries", { count: result.total }) : t("Audit entries")}
            <HelpTip text="A record of everything that happened: who did it, to whom, and when. Nobody can change or delete it. Use the filters above to find something, then press Apply filters." />
          </span>
          {busy ? (
            <LoadingSpinner label="Loading audit log" size="small" />
          ) : null}
        </div>
        <div className="audit-list">
          {!result && busy ? (
            <div className="loading-state">
              <LoadingSpinner label="Loading audit log" />
            </div>
          ) : result?.items.length ? (
            result.items.map((entry) => (
              <article className="audit-row" key={entry.id}>
                <div>
                  <strong>{auditLabel(entry.action, i18n)}</strong>
                  <span className="muted">{auditParties(entry, i18n)}</span>
                  {auditDetails(entry, i18n) ? <span className="audit-detail">{auditDetails(entry, i18n)}</span> : null}
                </div>
                <div>
                  <time className="muted" dateTime={entry.createdAt}>
                    {dateLabel(entry.createdAt)}
                  </time>
                  <span className="muted">{entry.actor?.role ? t(ROLE_NAMES[entry.actor.role] ?? entry.actor.role) : t("System")}</span>
                </div>
              </article>
            ))
          ) : (
            <p className="muted">
              {t("No audit entries match these filters.")}
            </p>
          )}
        </div>
        {result && result.pages > 1 ? (
          <div className="audit-pagination">
            <button
              className="secondary"
              disabled={page <= 1 || busy}
              onClick={() => load(page - 1)}
            >
              {t("Previous")}
            </button>
            <span className="muted">
              {t("Page {page} of {pages}", { page, pages: result.pages })}
            </span>
            <button
              className="secondary"
              disabled={page >= result.pages || busy}
              onClick={() => load(page + 1)}
            >
              {t("Next")}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
