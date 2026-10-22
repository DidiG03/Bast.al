import { NamedIcon, type IconName } from "../../../components/icons";
import { SignInForm } from "../../../components/sign-in-form";
import { ThemeToggle } from "../../../components/theme-toggle";
import { LanguageToggle } from "../../../components/language-toggle";
import { msg } from "../../../lib/i18n/core";
import { getT } from "../../../lib/i18n/server";
import { BrandMark } from "../../../components/brand-mark";

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
            <BrandMark />
            <span className="brand">Shtatat.al</span>
          </div>
          <span className="auth-top-actions">
            <LanguageToggle />
            <ThemeToggle />
          </span>
        </header>
        <div className="auth-form-body">
          <SignInForm />
        </div>
      </section>
      <aside className="auth-aside" aria-hidden="true" />
    </main>
  );
}
