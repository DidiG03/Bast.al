"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "../../../components/i18n-provider";
import { NamedIcon, type IconName } from "../../../components/icons";
import { PageLoading } from "../../../components/loading-spinner";
import { TeamSettingsModal } from "../../../components/team-settings";
import { useToast } from "../../../components/toaster";
import { apiFetch, type MeResponse } from "../../../lib/api";
import { msg } from "../../../lib/i18n/core";

type Item = { title: string; text: string; icon: IconName; href?: string; open?: "team" };

/**
 * Things set once and changed rarely, each as a big card that says what it
 * does: prices, the Casino switch, team rules, and your own account.
 */
const ITEMS: Record<MeResponse["role"], Item[]> = {
  OWNER: [
    { title: msg("Prices"), text: msg("Your team's margin on every match, and your own price on any pick."), icon: "odds", href: "/dashboard/odds" },
    { title: msg("Casino"), text: msg("Turn the Casino on or off for your team, and see how it's doing."), icon: "casino", href: "/dashboard/casino" },
    { title: msg("Team rules"), text: msg("When you're told a balance is low, and how much a manager can send without your OK."), icon: "sliders", open: "team" },
    { title: msg("My account"), text: msg("Your password, the devices you're signed in on, and the language."), icon: "user", href: "/dashboard/security" },
  ],
  MANAGER: [{ title: msg("My account"), text: msg("Your password, the devices you're signed in on, and the language."), icon: "user", href: "/dashboard/security" }],
  SUPER_ADMIN: [
    { title: msg("Prices"), text: msg("The base margin, leagues, and every team's prices."), icon: "odds", href: "/dashboard/odds" },
    { title: msg("Casino"), text: msg("Turn the Casino on or off for the site and each team."), icon: "casino", href: "/dashboard/casino" },
    { title: msg("My account"), text: msg("Your password, the devices you're signed in on, and the language."), icon: "user", href: "/dashboard/security" },
  ],
  PLAYER: [],
};

export default function SettingsPage() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      setMe(await apiFetch<MeResponse>("/users/me", token));
    })().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <PageLoading label="Loading" />;

  return (
    <div className="stack">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Settings")}</h1>
          <p className="muted report-subtitle">{t("Things you set once and change now and then.")}</p>
        </div>
      </div>
      <div className="settings-grid">
        {ITEMS[me.role].map((item) => {
          const body = (
            <>
              <span className="settings-card-icon" aria-hidden="true">
                <NamedIcon name={item.icon} className="settings-card-svg" />
              </span>
              <span className="settings-card-text">
                <strong>{t(item.title)}</strong>
                <span className="muted">{t(item.text)}</span>
              </span>
              <NamedIcon name="chevron" className="settings-card-chevron" />
            </>
          );
          return item.href ? (
            <Link key={item.title} href={item.href} className="card settings-card">{body}</Link>
          ) : (
            <button key={item.title} type="button" className="card settings-card" onClick={() => setTeamOpen(true)}>{body}</button>
          );
        })}
      </div>
      {teamOpen ? (
        <TeamSettingsModal
          onClose={() => setTeamOpen(false)}
          onSaved={(message) => {
            setTeamOpen(false);
            toast.success(message);
          }}
        />
      ) : null}
    </div>
  );
}
