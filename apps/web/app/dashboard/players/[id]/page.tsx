import { redirect } from "next/navigation";

/** A Player's page moved to People, with everything about them in one place. */
export default function PlayerActivityPage({ params }: { params: { id: string } }) {
  redirect(`/dashboard/people/${params.id}`);
}
