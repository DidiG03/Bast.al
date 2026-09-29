import { SignIn } from "@clerk/nextjs";
import { getT } from "../../../lib/i18n/server";

export default function RecoveryPage() {
  const { t } = getT();
  return (
    <main className="role-admin auth-page">
      <div className="auth-brand">
        <span className="sidebar-logo" aria-hidden="true">B</span>
        <span className="brand">Bast.al</span>
      </div>
      <div className="card stack auth-card">
        <h1 style={{ margin: 0 }}>{t("Password recovery")}</h1>
        <p className="muted">{t("Reset your password through the secure recovery steps below.")}</p>
        <SignIn routing="path" path="/sign-in" />
      </div>
    </main>
  );
}
