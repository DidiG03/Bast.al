"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BettingLimitsCard } from "../../../../components/betting-limits-card";
import { PlayerActivityView } from "../../../../components/player-activity-view";
import { useRealtime } from "../../../../components/realtime-provider";
import { apiFetch, type PlayerActivity } from "../../../../lib/api";
import { formatMoney } from "../../../../lib/format";

export default function PlayerActivityPage() {
  const { id } = useParams<{ id: string }>();
  const { getToken } = useAuth();
  const [data, setData] = useState<PlayerActivity | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      setData(await apiFetch<PlayerActivity>(`/players/${id}/activity`, token));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this player's activity");
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "resync") load().catch(() => undefined);
  });

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{data?.player.username ?? "Player activity"}</h1>
          {data ? (
            <p className="muted report-subtitle">
              Player{data.player.parent ? ` under ${data.player.parent.username}` : ""} · Balance {formatMoney(data.player.balance)}
              {data.player.status === "SUSPENDED" ? " · Suspended" : ""}
            </p>
          ) : null}
        </div>
        <Link href="/dashboard/users" className="back-link">Back to Users</Link>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {data ? <BettingLimitsCard playerId={id} /> : null}
      {data ? <PlayerActivityView data={data} /> : null}
    </div>
  );
}
