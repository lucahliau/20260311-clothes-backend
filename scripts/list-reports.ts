/**
 * Review user-filed abuse reports (App Store guideline 1.2 moderation duty).
 *
 *   npx tsx scripts/list-reports.ts                 # open reports
 *   npx tsx scripts/list-reports.ts --all           # every report
 *   npx tsx scripts/list-reports.ts --resolve <id>  # mark a report reviewed
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const args = process.argv.slice(2);

  const resolveIdx = args.indexOf("--resolve");
  if (resolveIdx !== -1) {
    const id = args[resolveIdx + 1];
    if (!id) {
      console.error("Usage: npx tsx scripts/list-reports.ts --resolve <reportId>");
      process.exitCode = 1;
      return;
    }
    const report = await prisma.userReport.update({
      where: { id },
      data: { status: "reviewed" },
    });
    console.log(`Report ${report.id} marked reviewed.`);
    return;
  }

  const all = args.includes("--all");
  const reports = await prisma.userReport.findMany({
    where: all ? {} : { status: "open" },
    orderBy: { createdAt: "desc" },
    include: {
      reporter: { select: { username: true, email: true } },
      reportedUser: { select: { id: true, username: true, email: true } },
    },
  });

  if (reports.length === 0) {
    console.log(all ? "No reports." : "No open reports.");
    return;
  }

  for (const r of reports) {
    console.log(
      [
        `[${r.status}] ${r.createdAt.toISOString()}  id=${r.id}`,
        `  reported: @${r.reportedUser.username} (${r.reportedUser.id})`,
        `  by:       @${r.reporter.username}`,
        `  reason:   ${r.reason}${r.details ? ` — ${r.details}` : ""}`,
      ].join("\n"),
    );
  }
  console.log(`\n${reports.length} report(s). Resolve with --resolve <id>.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
