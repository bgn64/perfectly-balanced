import { headers } from "next/headers";
import { auth } from "../../server/auth";
import { Workspace } from "../workspace";

export const dynamic = "force-dynamic";
export default async function Page() {
  const session = await auth().api.getSession({ headers: await headers() });
  return <Workspace user={session ? { id: session.user.id, email: session.user.email } : null} />;
}
