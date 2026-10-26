import { redirect } from "next/navigation";

/** The bet slip lives at /dashboard/bet. /bet is the address people type. */
export default function BetRedirect() {
  redirect("/dashboard/bet");
}
