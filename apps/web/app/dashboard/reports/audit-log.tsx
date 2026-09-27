"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import {
  apiFetch,
  type AuditResponse,
  type MeResponse,
} from "../../../lib/api";
import { LoadingSpinner } from "../../../components/loading-spinner";

const roles = ["", "SUPER_ADMIN", "OWNER", "MANAGER", "PLAYER"] as const;

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function AuditLog() {
  const { getToken } = useAuth();
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
  const [error, setError] = useState<string | null>(null);

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
      if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
      setResult(
        await apiFetch<AuditResponse>(
          `/users/audit?${params.toString()}`,
          token,
        ),
      );
      setPage(nextPage);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load audit log");
    } finally {
      setBusy(false);
    }
  }

  // The loader intentionally uses the current filter state and runs once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    load(1).catch(() => undefined);
  }, []);

  if (me?.role === "PLAYER")
    return <p className="muted">Audit logs are restricted to Super Admins, Owners and Managers.</p>;

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
          Actor
          <input
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            placeholder="Username or ID"
          />
        </label>
        <label>
          Target
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="Username or ID"
          />
        </label>
        <label>
          Action
          <input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="e.g. user.update"
          />
        </label>
        <label>
          Role
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {value || "All roles"}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <div className="audit-filter-actions">
          <button type="submit" disabled={busy}>
            Apply filters
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
            Clear
          </button>
        </div>
      </form>
      {error ? (
        <div className="error-toast" role="alert">
          {error}
        </div>
      ) : null}
      <section className="card audit-table-card">
        <div className="tree-header">
          <span>{result ? `${result.total} entries` : "Audit entries"}</span>
          {busy ? (
            <LoadingSpinner label="Loading audit log" size="small" />
          ) : null}
        </div>
        <div className="audit-list">
          {result?.items.length ? (
            result.items.map((entry) => (
              <article className="audit-row" key={entry.id}>
                <div>
                  <strong>{entry.action.replaceAll(".", " ")}</strong>
                  <span className="muted">
                    {entry.actor?.username ?? "System"}
                    {entry.target ? ` → ${entry.target.username}` : ""}
                  </span>
                </div>
                <div>
                  <time className="muted" dateTime={entry.createdAt}>
                    {dateLabel(entry.createdAt)}
                  </time>
                  <span className="muted">{entry.actor?.role ?? "System"}</span>
                </div>
              </article>
            ))
          ) : (
            <p className="muted">
              {busy ? "Loading…" : "No audit entries match these filters."}
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
              Previous
            </button>
            <span className="muted">
              Page {page} of {result.pages}
            </span>
            <button
              className="secondary"
              disabled={page >= result.pages || busy}
              onClick={() => load(page + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
