import { Prisma, PrismaClient } from '@prisma/client';

// BigInt paise serialise as JSON numbers. Safe: ₹90 trillion fits in 2^53 paise.
BigInt.prototype.toJSON = function () {
  return Number(this);
};

// Decimal (numeric) columns serialise as plain numbers — rates and day counts only, never money.
Prisma.Decimal.prototype.toJSON = function () {
  return this.toNumber();
};

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export { Prisma };
