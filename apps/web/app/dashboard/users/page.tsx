import { redirect } from "next/navigation";

/**
 * Everyone now looks after their people on the People pages. Old links and
 * notifications still point here: one about a person opens their page.
 */
export default function UsersPage({ searchParams }: { searchParams: { userId?: string | string[] } }) {
  const userId = Array.isArray(searchParams.userId) ? searchParams.userId[0] : searchParams.userId;
  redirect(userId ? `/dashboard/people/${encodeURIComponent(userId)}` : "/dashboard/people");
}
