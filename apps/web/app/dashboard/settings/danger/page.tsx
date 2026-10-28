"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState, type FormEvent } from "react";
import { LoadingSpinner, PageLoading } from "../../../../components/loading-spinner";
import { useToast } from "../../../../components/toaster";
import { apiFetch, type DataResetPreview, type DataResetResult, type MeResponse } from "../../../../lib/api";
import { useI18n } from "../../../../components/i18n-provider";
import { HelpTip } from "../../../../components/help-tip";

/** What Super Admin types, as well as their username and password (the API checks it too). */
const RESET_PHRASE = "DELETE ALL TEST DATA";

/**
 * Super Admin: actions that can't be undone, kept on their own page away
 * from everyday settings so they're never pressed by mistake. For now,
 * deleting all test data before real users start.
 */
export default function DangerZonePage() {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [reset, setReset] = useState<DataResetPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  async function load() {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const profile = await apiFetch<MeResponse>("/users/me", token);
    setMe(profile);
    if (profile.role === "SUPER_ADMIN") setReset(await apiFetch<DataResetPreview>("/users/data-reset", token));
  }

  useEffect(() => {
    load().catch((err: Error) => {
      setFailed(true);
      toast.error(err.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    setOpen(false);
    setPhrase("");
    setUsername("");
    setPassword("");
  }

  async function onReset(event: FormEvent) {
    event.preventDefault();
    setResetting(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const done = await apiFetch<DataResetResult>("/users/data-reset", token, { method: "POST", body: JSON.stringify({ phrase, username, password }) });
      close();
      toast.success(tn(done.accounts, "Deleted {count} account and all the test data. The app is ready for real users.", "Deleted {count} accounts and all the test data. The app is ready for real users."));
      await load();
    } catch (err) {
      setPassword("");
      toast.error(err instanceof Error ? err.message : t("Couldn't delete the data"));
    } finally {
      setResetting(false);
    }
  }

  if (!me) return failed ? null : <PageLoading label="Loading" />;
  if (me.role !== "SUPER_ADMIN") return <p className="muted">{t("Only Super Admin can open this page.")}</p>;

  const ready = phrase.trim().toUpperCase() === RESET_PHRASE && username.trim().toLowerCase() === me.username.toLowerCase() && password.length > 0;
  return (
    <div className="stack danger-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Danger zone")}</h1>
          <p className="muted report-subtitle">{t("Actions that can't be undone, kept apart from everyday settings.")}</p>
        </div>
      </div>
      {reset ? (
        <section className="card stack data-reset">
          <h2 style={{ margin: 0 }}>{t("Delete all test data")}<HelpTip text="For when you go live. Everything made while testing goes, so real users start from a clean app. Only you can do it, and you confirm it with a phrase, your username and your password." /></h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("Deletes every Owner, Manager and Player with their sign-ins, and everything they did: bets, balances, the ledger, commissions, notifications and the audit log. Your Super Admin account, prices, margins, leagues and matches stay. This can't be undone.")}
          </p>
          {reset.enabled ? (
            <p style={{ margin: 0 }}>
              <strong>{tn(reset.accounts, "Right now: {count} account", "Right now: {count} accounts")}</strong>
              {" · "}
              {tn(reset.bets, "{count} bet", "{count} bets")}
              {" · "}
              {tn(reset.ledgerEntries, "{count} ledger entry", "{count} ledger entries")}
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("This is turned off on this server.")}</p>
          )}
          <div>
            <button type="button" className="danger-button" onClick={() => setOpen(true)} disabled={!reset.enabled}>
              {t("Delete all test data")}
            </button>
          </div>
        </section>
      ) : null}
      {open && reset ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !resetting && close()}>
          <section className="modal card" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <div className="modal-header">
              <h2 id="reset-title">{t("Delete all test data?")}</h2>
              <button type="button" className="modal-close secondary" onClick={close} disabled={resetting} aria-label={t("Close")}>×</button>
            </div>
            <p>
              {tn(
                reset.accounts,
                "{count} account, with its sign-in, bets, balance and history, will be deleted for good. Only your Super Admin account stays.",
                "{count} accounts, with their sign-ins, bets, balances and history, will be deleted for good. Only your Super Admin account stays.",
              )}
            </p>
            <form className="stack" onSubmit={onReset}>
              <label>
                {t("Type {phrase} to confirm", { phrase: RESET_PHRASE })}
                <input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
              </label>
              <label>
                {t("Your username, {name}", { name: me.username })}
                <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />
              </label>
              <label>
                {t("Your password")}
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={close} disabled={resetting}>{t("Cancel")}</button>
                <button type="submit" className="danger-button" disabled={resetting || !ready}>
                  {resetting ? <LoadingSpinner label="Deleting all test data" size="small" /> : t("Delete everything")}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
