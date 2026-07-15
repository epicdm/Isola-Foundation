/**
 * Prisma client singleton for the Isola Next.js app.
 * Re-uses the global instance in development to avoid exhausting connections
 * on hot-reload. In production a new client is created once per process.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
