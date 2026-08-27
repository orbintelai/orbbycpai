import { neon } from "@neondatabase/serverless";

export const ADMIN_EMAILS = new Set(["tyler@yanaapp.com"]);
export const MONTHLY_ACCOUNT_FULL_REPORT_LIMIT = 10;
const IS_STAGING = process.env.ORB_ENV === "staging";
/** Staging defaults to 10 total shared units and no admin reserve unless explicitly configured. */
export const SHARED_MONTHLY_FULL_PROFILE_CEILING = Number(
  IS_STAGING
    ? (process.env.ORB_STAGING_MONTHLY_FULL_PROFILE_CEILING || 10)
    : (process.env.ORB_SHARED_MONTHLY_FULL_PROFILE_CEILING || 300)
);
export const ADMIN_MONTHLY_RESERVED_FULL_PROFILE_UNITS = Number(
  IS_STAGING
    ? (process.env.ORB_STAGING_ADMIN_MONTHLY_RESERVED_FULL_PROFILE_UNITS || 0)
    : (process.env.ORB_ADMIN_MONTHLY_RESERVED_FULL_PROFILE_UNITS || 20)
);
export const COST_RESERVATION_USD_PER_FULL_PROFILE = Number(process.env.ORB_COST_RESERVATION_USD_PER_FULL_PROFILE || 0.05);

export type CapacityPool = "shared" | "admin_reserve";

export interface CapacitySnapshot {
  calendarMonth: string;
  sharedUsed: number;
  sharedLimit: number;
  adminReserveUsed: number;
  adminReserveLimit: number;
  totalUsed: number;
  totalLimit: number;
  estimatedReservedCostUsd: number;
  dashboardAlert?: "50" | "80";
}

export class AccountLimitError extends Error {
  constructor() {
    super("You have used all 10 full beta reports for this calendar month.");
    this.name = "AccountLimitError";
  }
}

export class PlatformCapacityError extends Error {
  constructor() {
    super("Orb's beta analysis capacity is paused for this month. Please try again next month.");
    this.name = "PlatformCapacityError";
  }
}

function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function sqlClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for capacity reservations");
  return neon(databaseUrl);
}

async function ensurePeriodRows(userId: string, month: string): Promise<void> {
  const sql = sqlClient();
  await sql`INSERT INTO user_usage_periods (user_id, calendar_month) VALUES (${userId}, ${month}) ON CONFLICT (user_id, calendar_month) DO NOTHING`;
  await sql`INSERT INTO platform_usage_periods (calendar_month) VALUES (${month}) ON CONFLICT (calendar_month) DO NOTHING`;
}

async function releaseUserReservation(userId: string, month: string): Promise<void> {
  const sql = sqlClient();
  await sql`UPDATE user_usage_periods SET released_runs = released_runs + 1, updated_at = NOW() WHERE user_id = ${userId} AND calendar_month = ${month}`;
}

/**
 * Atomically admit one fresh full-profile unit. The shared pool is tried first
 * for every account. Admin users can fall back to the protected reserve after
 * shared beta capacity is exhausted. Admin still does not bypass the hard total.
 */
export async function reserveFullProfileUnit(input: { userId: string; email: string; countTowardAccountLimit?: boolean }): Promise<{ pool: CapacityPool; snapshot: CapacitySnapshot; accountCounted: boolean }> {
  const month = currentMonth();
  const isAdmin = ADMIN_EMAILS.has(input.email.toLowerCase());
  const accountCounted = !isAdmin && input.countTowardAccountLimit !== false;
  await ensurePeriodRows(input.userId, month);
  const sql = sqlClient();

  if (accountCounted) {
    const userRows = await sql`
      UPDATE user_usage_periods
      SET reserved_runs = reserved_runs + 1, updated_at = NOW()
      WHERE user_id = ${input.userId}
        AND calendar_month = ${month}
        AND (reserved_runs - released_runs) < ${MONTHLY_ACCOUNT_FULL_REPORT_LIMIT}
      RETURNING reserved_runs, released_runs
    `;
    if (userRows.length === 0) throw new AccountLimitError();
  }

  const sharedRows = await sql`
    UPDATE platform_usage_periods
    SET shared_reserved_runs = shared_reserved_runs + 1, updated_at = NOW()
    WHERE calendar_month = ${month}
      AND is_paused = false
      AND (shared_reserved_runs - shared_released_runs) < ${SHARED_MONTHLY_FULL_PROFILE_CEILING}
    RETURNING *
  `;

  let pool: CapacityPool = "shared";
  if (sharedRows.length === 0 && isAdmin) {
    const adminRows = await sql`
      UPDATE platform_usage_periods
      SET admin_reserved_runs = admin_reserved_runs + 1, updated_at = NOW()
      WHERE calendar_month = ${month}
        AND is_paused = false
        AND (admin_reserved_runs - admin_released_runs) < ${ADMIN_MONTHLY_RESERVED_FULL_PROFILE_UNITS}
      RETURNING *
    `;
    if (adminRows.length > 0) {
      pool = "admin_reserve";
      return { pool, snapshot: await capacitySnapshot(month), accountCounted };
    }
  }

  if (sharedRows.length === 0) {
    if (accountCounted) await releaseUserReservation(input.userId, month);
    throw new PlatformCapacityError();
  }

  return { pool, snapshot: await capacitySnapshot(month), accountCounted };
}

export async function releaseFullProfileUnit(input: { userId: string; email: string; pool: CapacityPool; accountCounted?: boolean }): Promise<void> {
  const month = currentMonth();
  const sql = sqlClient();
  if (input.accountCounted !== false && !ADMIN_EMAILS.has(input.email.toLowerCase())) await releaseUserReservation(input.userId, month);
  if (input.pool === "shared") {
    await sql`UPDATE platform_usage_periods SET shared_released_runs = shared_released_runs + 1, updated_at = NOW() WHERE calendar_month = ${month}`;
  } else {
    await sql`UPDATE platform_usage_periods SET admin_released_runs = admin_released_runs + 1, updated_at = NOW() WHERE calendar_month = ${month}`;
  }
}

export async function completeFullProfileUnit(input: { userId: string; email: string; pool: CapacityPool; accountCounted?: boolean }): Promise<CapacitySnapshot> {
  const month = currentMonth();
  const sql = sqlClient();
  if (input.accountCounted !== false && !ADMIN_EMAILS.has(input.email.toLowerCase())) {
    await sql`UPDATE user_usage_periods SET completed_runs = completed_runs + 1, updated_at = NOW() WHERE user_id = ${input.userId} AND calendar_month = ${month}`;
  }
  if (input.pool === "shared") {
    await sql`UPDATE platform_usage_periods SET shared_completed_runs = shared_completed_runs + 1, updated_at = NOW() WHERE calendar_month = ${month}`;
  } else {
    await sql`UPDATE platform_usage_periods SET admin_completed_runs = admin_completed_runs + 1, updated_at = NOW() WHERE calendar_month = ${month}`;
  }
  return capacitySnapshot(month);
}

/**
 * Reads current capacity and atomically flags each dashboard-only threshold once.
 */
export async function capacitySnapshot(month = currentMonth()): Promise<CapacitySnapshot> {
  const sql = sqlClient();
  await sql`INSERT INTO platform_usage_periods (calendar_month) VALUES (${month}) ON CONFLICT (calendar_month) DO NOTHING`;
  const rows = await sql`SELECT * FROM platform_usage_periods WHERE calendar_month = ${month}`;
  const row = rows[0];
  const sharedUsed = Number(row.shared_reserved_runs) - Number(row.shared_released_runs);
  const adminReserveUsed = Number(row.admin_reserved_runs) - Number(row.admin_released_runs);
  const totalLimit = SHARED_MONTHLY_FULL_PROFILE_CEILING + ADMIN_MONTHLY_RESERVED_FULL_PROFILE_UNITS;
  const totalUsed = sharedUsed + adminReserveUsed;
  const ratio = totalLimit === 0 ? 1 : totalUsed / totalLimit;
  let dashboardAlert: "50" | "80" | undefined;
  if (ratio >= 0.8 && !row.alerted_at_80) {
    const updated = await sql`UPDATE platform_usage_periods SET alerted_at_80 = true, updated_at = NOW() WHERE calendar_month = ${month} AND alerted_at_80 = false RETURNING calendar_month`;
    if (updated.length > 0) dashboardAlert = "80";
  } else if (ratio >= 0.5 && !row.alerted_at_50) {
    const updated = await sql`UPDATE platform_usage_periods SET alerted_at_50 = true, updated_at = NOW() WHERE calendar_month = ${month} AND alerted_at_50 = false RETURNING calendar_month`;
    if (updated.length > 0) dashboardAlert = "50";
  }
  return {
    calendarMonth: month,
    sharedUsed,
    sharedLimit: SHARED_MONTHLY_FULL_PROFILE_CEILING,
    adminReserveUsed,
    adminReserveLimit: ADMIN_MONTHLY_RESERVED_FULL_PROFILE_UNITS,
    totalUsed,
    totalLimit,
    estimatedReservedCostUsd: totalUsed * COST_RESERVATION_USD_PER_FULL_PROFILE,
    dashboardAlert,
  };
}
