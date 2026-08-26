import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { generations, subscriptions, userUsagePeriods } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { ADMIN_EMAILS, capacitySnapshot } from "@/lib/usage/circuitBreaker";
import DashboardClient from "./DashboardClient";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id as string;
  const email = (session.user.email || "").toLowerCase();
  const isAdmin = ADMIN_EMAILS.has(email);
  const month = currentMonth();

  const [userGenerations, userSubscription, usageRows, capacity] = await Promise.all([
    db.select().from(generations).where(eq(generations.userId, userId)).orderBy(desc(generations.createdAt)).limit(50),
    db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1),
    db.select().from(userUsagePeriods).where(and(eq(userUsagePeriods.userId, userId), eq(userUsagePeriods.calendarMonth, month))).limit(1),
    isAdmin ? capacitySnapshot().catch((error) => { console.error("[dashboard] capacity snapshot unavailable", error); return null; }) : Promise.resolve(null),
  ]);

  const subscription = userSubscription[0] ?? null;
  const usage = usageRows[0];
  const user = {
    name: session.user.name || session.user.email || "User",
    email: session.user.email || "",
    initials: (session.user.name || session.user.email || "U").split(" ").map((word: string) => word[0]).join("").toUpperCase().slice(0, 2),
  };

  return <DashboardClient
    user={user}
    generations={userGenerations.map((generation) => ({
      id: generation.id,
      brandUrl: generation.brandUrl,
      status: generation.status,
      createdAt: generation.createdAt.toISOString(),
      brandProfile: (generation.brandProfile as Record<string, unknown> | null) ?? {},
      errorMessage: generation.errorMessage ?? null,
    }))}
    stats={{
      completedRuns: userGenerations.filter((generation) => generation.status === "complete").length,
      totalGenerations: userGenerations.length,
      generationsUsed: usage?.completedRuns ?? 0,
      generationsLimit: 10,
      tier: isAdmin ? "admin" : (subscription?.tier ?? "free"),
      capacity,
    }}
  />;
}
