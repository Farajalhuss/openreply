import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

/**
 * Read-only stats feed for an external dashboard.
 *
 * Consumed server-to-server (the Saif Voice Cloudflare worker calls this and
 * caches the result), never from a browser: the bearer token would be visible.
 *
 * Link clicks are filtered to real people. Instagram/Facebook fetch every URL
 * they see to build a link-preview card, so `facebookexternalhit` alone
 * accounted for ~90% of raw click rows and would report a CTR above 100%.
 */

const BOT_AGENT_PATTERNS = [
  "facebookexternalhit",
  "meta-externalagent",
  "instagram",
  "bot",
  "crawler",
  "spider",
  "preview",
  "curl",
  "wget",
  "python-requests",
  "headlesschrome",
];

const DAILY_DAYS = 14;

type CampaignRow = {
  automationId: string;
  name: string;
  keywords: string[];
  isActive: boolean;
  sent: bigint;
  failed: bigint;
};

type ClickRow = { automationId: string; clicks: bigint };
type DailyRow = { day: Date; sent: bigint; clicks: bigint };

function ctr(sent: number, clicks: number): number {
  if (sent <= 0) return 0;
  return Math.round((clicks / sent) * 1000) / 10;
}

export async function GET(request: NextRequest) {
  const expected = process.env.EXTERNAL_STATS_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "NOT_CONFIGURED" },
      { status: 503 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const username = request.nextUrl.searchParams.get("account");
  if (!username) {
    return NextResponse.json(
      { ok: false, error: "MISSING_ACCOUNT" },
      { status: 400 }
    );
  }

  const account = await prisma.instagramAccount.findFirst({
    where: { username },
    select: { id: true, username: true },
  });
  if (!account) {
    return NextResponse.json({ ok: false, error: "UNKNOWN_ACCOUNT" }, { status: 404 });
  }

  // ILIKE ANY(...) keeps the bot list in one place instead of a chain of ORs.
  const botPatterns = BOT_AGENT_PATTERNS.map((p) => `%${p}%`);

  const [campaigns, clicks, daily] = await Promise.all([
    prisma.$queryRaw<CampaignRow[]>`
      SELECT a.id AS "automationId",
             a.name,
             a.keywords,
             a."isActive",
             COUNT(l.id) FILTER (WHERE l.status = 'SENT')   AS sent,
             COUNT(l.id) FILTER (WHERE l.status = 'FAILED') AS failed
      FROM "Automation" a
      LEFT JOIN "DmLog" l ON l."automationId" = a.id
      WHERE a."instagramAccountId" = ${account.id}
      GROUP BY a.id, a.name, a.keywords, a."isActive"
      ORDER BY a.name
    `,
    prisma.$queryRaw<ClickRow[]>`
      SELECT c."automationId", COUNT(*) AS clicks
      FROM "LinkClick" c
      WHERE c."instagramAccountId" = ${account.id}
        AND COALESCE(c."userAgent", '') NOT ILIKE ALL (${botPatterns}::text[])
      GROUP BY c."automationId"
    `,
    prisma.$queryRaw<DailyRow[]>`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - ${DAILY_DAYS - 1}::int),
          CURRENT_DATE,
          '1 day'
        )::date AS day
      )
      SELECT d.day,
             (SELECT COUNT(*) FROM "DmLog" l
               WHERE l."instagramAccountId" = ${account.id}
                 AND l.status = 'SENT'
                 AND l."createdAt"::date = d.day) AS sent,
             (SELECT COUNT(*) FROM "LinkClick" c
               WHERE c."instagramAccountId" = ${account.id}
                 AND COALESCE(c."userAgent", '') NOT ILIKE ALL (${botPatterns}::text[])
                 AND c."createdAt"::date = d.day) AS clicks
      FROM days d
      ORDER BY d.day
    `,
  ]);

  const clicksByCampaign = new Map(
    clicks.map((row) => [row.automationId, Number(row.clicks)])
  );

  const campaignStats = campaigns.map((row) => {
    const sent = Number(row.sent);
    const campaignClicks = clicksByCampaign.get(row.automationId) ?? 0;
    return {
      name: row.name,
      keywords: row.keywords,
      active: row.isActive,
      sent,
      failed: Number(row.failed),
      clicks: campaignClicks,
      ctr: ctr(sent, campaignClicks),
    };
  });

  const totalSent = campaignStats.reduce((sum, c) => sum + c.sent, 0);
  const totalClicks = campaignStats.reduce((sum, c) => sum + c.clicks, 0);

  return NextResponse.json(
    {
      ok: true,
      account: account.username,
      generatedAt: new Date().toISOString(),
      totals: {
        sent: totalSent,
        clicks: totalClicks,
        ctr: ctr(totalSent, totalClicks),
        campaigns: campaignStats.length,
        activeCampaigns: campaignStats.filter((c) => c.active).length,
      },
      campaigns: campaignStats,
      daily: daily.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        sent: Number(row.sent),
        clicks: Number(row.clicks),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
