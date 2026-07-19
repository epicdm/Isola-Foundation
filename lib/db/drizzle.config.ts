import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Scope drizzle-kit to ONLY the two Replit-auth tables it owns. Without this,
  // `drizzle-kit push` diffs the ENTIRE database against this schema and
  // proposes dropping/renaming every Prisma-managed table (incl.
  // _prisma_migrations, ApprovalRequest, ...) — the destructive "rename?" prompt.
  // Prisma tables are managed solely by `prisma migrate deploy`; drizzle-kit
  // must never touch them.
  tablesFilter: ["users", "sessions"],
});
