"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { apiFetch, type SecurityOverview } from "../../../lib/api";

export default function SecurityPage() {
  const { getToken } = useAuth();
  const [data, setData] = useState<SecurityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const token = await getToken();
    if (!token) throw new Error("Not signed in");
    setData(await apiFetch<SecurityOverview>("/users/me/security", token));
  }

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string) {
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      await apiFetch(`/users/me/sessions/${id}/revoke`, token, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke session");
    }
  }

  async function revokeOthers() {
      try {
        const token = await getToken();
        if (!token) throw new Error("Not signed in");
        await apiFetch("/users/me/sessions/revoke-others", token, { method: "POST" });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not revoke other sessions");
    }
  }

  if (!data) {
    return error ? <p className="error">{error}</p> : <div className="loading-state"><LoadingSpinner label="Loading security" /><span className="muted">Loading security…</span></div>;
  }

  return (
    <div className="stack security-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>Security</h1>
          <p className="muted report-subtitle">Manage active devices and review recent account activity.</p>
        </div>
      </div>
      <section className="card stack">
        <div className="tree-header"><h2>Active devices</h2><div className="row"><span className="muted">{data.sessions.length} sessions</span><button type="button" className="secondary" onClick={revokeOthers}>Sign out other devices</button></div></div>
        {data.sessions.length === 0 ? <p className="muted">No active sessions found.</p> : data.sessions.map((session) => (
          <div className="security-row" key={session.id}>
            <div><strong>{session.status}</strong><span className="muted">Last active {new Date(session.lastActiveAt).toLocaleString()}</span></div>
            <button type="button" className="secondary" onClick={() => revoke(session.id)}>Revoke</button>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Login history</h2>
        {data.loginHistory.length === 0 ? <p className="muted">No successful logins recorded yet.</p> : data.loginHistory.map((entry) => (
          <div className="security-row" key={entry.id}>
            <div><strong>{entry.device ?? "Unknown device"} · {entry.browser ?? "Unknown browser"}</strong><span className="muted">{entry.ipAddress ?? "Unknown IP"} · {entry.location ?? "Unknown location"} · Last seen {new Date(entry.lastSeenAt).toLocaleString()}</span></div>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Login history and alerts</h2>
        {data.activity.length === 0 ? <p className="muted">No recorded login activity.</p> : data.activity.map((entry) => (
          <div className="security-row" key={entry.id}>
            <div>
              <strong>{entry.action === "auth.failure" ? "Suspicious login attempt" : "Successful login"}</strong>
              <span className="muted">{entry.ipAddress ?? "Unknown IP"} · {new Date(entry.createdAt).toLocaleString()}</span>
            </div>
          </div>
        ))}
      </section>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Password</h2>
        <p className="muted">Use the account profile to change your password or start a password reset.</p>
        <a className="button-link" href="/security/recovery">Open password recovery</a>
      </section>
    </div>
  );
}
