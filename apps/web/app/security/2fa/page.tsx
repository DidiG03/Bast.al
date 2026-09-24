import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UserProfilePanel } from "../../../components/user-profile-panel";
import { apiFetch, type MeResponse } from "../../../lib/api";

export default async function TwoFactorPage() {
  const { getToken, userId } = await auth();
  if (!userId) redirect("/sign-in");
  const token = await getToken();
  if (!token) redirect("/sign-in");

  let me: MeResponse | null = null;
  try {
    me = await apiFetch<MeResponse>("/users/me", token);
  } catch {
    redirect("/dashboard");
  }

  if (me.mfaSatisfied) {
    redirect("/dashboard");
  }

  return (
    <main className="stack" style={{ alignItems: "center", paddingTop: "2rem" }}>
      <div className="brand">Bast.al</div>
      <div className="card stack" style={{ maxWidth: 720, width: "100%" }}>
        <h1 style={{ margin: 0 }}>Two-factor authentication required</h1>
        <p className="muted" style={{ margin: 0 }}>
          Role <strong>{me.role}</strong> must enable TOTP before accessing the dashboard. Use the
          Security section below to enroll an authenticator app.
        </p>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Note: Clerk MFA requires a Pro plan. On Hobby, keep{" "}
          <code>MFA_ENFORCEMENT_ENABLED=false</code> until you upgrade, or this gate cannot be
          satisfied.
        </p>
        <UserProfilePanel />
        <Link href="/dashboard">Continue to dashboard</Link>
      </div>
    </main>
  );
}
