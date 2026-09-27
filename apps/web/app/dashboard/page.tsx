import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { apiFetch, type MeResponse } from "../../lib/api";

export default async function DashboardPage() {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const me = await apiFetch<MeResponse>("/users/me", token);

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Dashboard</h1>
      <div className="card stack">
        <p style={{ margin: 0 }}>
          Signed in as <strong>{me.username}</strong>
        </p>
        {me.role !== "SUPER_ADMIN" ? (
          <p style={{ margin: 0 }}>
            Account balance: <strong>${Number(me.balance).toFixed(2)}</strong>
          </p>
        ) : null}
        {(me.role === "OWNER" || me.role === "MANAGER") ? (
          <p style={{ margin: 0 }}>
            Commission rate: <strong>{Number(me.commissionRate)}%</strong>
          </p>
        ) : null}
      </div>
    </div>
  );
}
