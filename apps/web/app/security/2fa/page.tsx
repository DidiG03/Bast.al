import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UserProfilePanel } from "../../../components/user-profile-panel";
import { type MeResponse } from "../../../lib/api";
import { serverApiFetch } from "../../../lib/api-server";
import { getT } from "../../../lib/i18n/server";

export default async function TwoFactorPage() {
  const { t } = getT();
  const { getToken, userId } = await auth();
  if (!userId) redirect("/sign-in");
  const token = await getToken();
  if (!token) redirect("/sign-in");

  let me: MeResponse | null = null;
  try {
    me = await serverApiFetch<MeResponse>("/users/me", token);
  } catch {
    redirect("/dashboard");
  }

  if (me.mfaSatisfied) {
    redirect("/dashboard");
  }

  return (
    <main className="role-admin auth-page">
      <div className="auth-brand">
        <span className="sidebar-logo" aria-hidden="true">B</span>
        <span className="brand">Bast.al</span>
      </div>
      <div className="card stack auth-card auth-card-wide">
        <h1 style={{ margin: 0 }}>{t("Two-step verification required")}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {t("Your account needs two-step verification before you can open the dashboard. Add an authenticator app in the Security section below.")}
        </p>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          {t("Note: Clerk's two-step verification needs its Pro plan. On the Hobby plan, keep MFA_ENFORCEMENT_ENABLED=false until you upgrade, or this step can't be completed.")}
        </p>
        <UserProfilePanel />
        <Link href="/dashboard">{t("Continue to the dashboard")}</Link>
      </div>
    </main>
  );
}
