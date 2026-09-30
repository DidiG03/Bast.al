import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { Logger } from "@nestjs/common";

/**
 * Brings the database up to the Prisma schema before the API starts
 * (`prisma db push`), so a deploy that adds a table or column never runs
 * against a database without it. Turn it off with DB_PUSH_ON_START=false.
 *
 * Changes that would lose data (dropping a column or table, a new unique
 * constraint over duplicates) are refused by Prisma; then this logs what's
 * blocking and the API starts anyway, since the database is ahead of the code
 * rather than behind it. Anything else that goes wrong is logged the same way.
 */
export function syncSchema() {
  const logger = new Logger("SchemaSync");
  if (process.env.DB_PUSH_ON_START === "false") return;
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL isn't set, so the database schema wasn't checked");
    return;
  }
  // dist/main.js sits next to prisma/ in the repo (apps/api) and in the Docker image (/app).
  const schema = join(__dirname, "..", "prisma", "schema.prisma");
  if (!existsSync(schema)) {
    logger.warn(`No Prisma schema at ${schema}, so the database schema wasn't checked`);
    return;
  }
  let cli: string;
  try {
    cli = require.resolve("prisma/build/index.js");
  } catch {
    logger.error("The prisma package isn't installed, so the database schema wasn't checked");
    return;
  }
  try {
    const output = execFileSync(process.execPath, [cli, "db", "push", "--skip-generate", `--schema=${schema}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
    logger.log(/already in sync/i.test(output) ? "The database already matches the schema" : "The database was brought up to the schema");
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    const detail = `${failed.stderr ?? ""}${failed.stdout ?? ""}`.trim() || failed.message || String(error);
    logger.error(`Couldn't bring the database up to the schema, so some pages may fail until it's fixed (run \`npx prisma db push\` by hand to see why):\n${detail.slice(-2000)}`);
  }
}
