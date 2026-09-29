import { NamedIcon, type IconName } from "../../../components/icons";
import { SignInForm } from "../../../components/sign-in-form";
import { ThemeToggle } from "../../../components/theme-toggle";
import { LanguageToggle } from "../../../components/language-toggle";
import { msg } from "../../../lib/i18n/core";
import { getT } from "../../../lib/i18n/server";

const POINTS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: "users", title: msg("Your team only"), text: msg("Everyone sees the accounts under them, nothing else.") },
  { icon: "commissions", title: msg("Settled every week"), text: msg("Profit, commission and what each person owes, worked out for you.") },
  { icon: "audit", title: msg("Every change on record"), text: msg("Balance moves and settings changes land in the audit log.") },
];

export default function SignInPage() {
  const { t } = getT();
  return (
    <main className="role-admin auth-page auth-split">
      <section className="auth-form-side">
        <header className="auth-top">
          <div className="auth-brand">
            <span className="sidebar-logo" aria-hidden="true">B</span>
            <span className="brand">Bast.al</span>
          </div>
          <span className="auth-top-actions">
            <LanguageToggle />
            <ThemeToggle />
          </span>
        </header>
        <div className="auth-form-body">
          <SignInForm />
        </div>
        <p className="auth-footnote">{t("There is no public sign-up. Your Manager, Owner or Super Admin creates your account.")}</p>
      </section>
      <aside className="auth-aside" aria-hidden="true">
        <div className="auth-aside-inner">
          <p className="auth-aside-lead">{t("The back office for your betting team.")}</p>
          <ul className="auth-points">
            {POINTS.map((point) => (
              <li key={point.title}>
                <span className="auth-point-icon">
                  <NamedIcon name={point.icon} />
                </span>
                <div>
                  <strong>{t(point.title)}</strong>
                  <span>{t(point.text)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}
