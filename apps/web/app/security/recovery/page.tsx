import { SignIn } from "@clerk/nextjs";
import { getT } from "../../../lib/i18n/server";
import { BrandMark } from "../../../components/brand-mark";

export default function RecoveryPage() {
  const { t } = getT();
  return (
    <main className="role-admin auth-page">
      <div className="auth-brand">
        <BrandMark />
        <span className="brand">Shtatat.al</span>
      </div>
      <div className="card stack auth-card">
        <h1 style={{ margin: 0 }}>{t("Password recovery")}</h1>
        <p className="muted">{t("Reset your password through the secure recovery steps below.")}</p>
        <SignIn routing="path" path="/sign-in" />
      </div>
    </main>
  );
}
