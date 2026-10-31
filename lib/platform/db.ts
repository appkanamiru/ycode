/**
 * Platform Database Pool
 *
 * Shared by Better Auth and the platform lookups (memberships, domains).
 * Stored on globalThis so the pool survives Next.js HMR in dev mode.
 */

import { Pool } from 'pg';

const globalForPlatform = globalThis as unknown as { __platformPool?: Pool };

export function getPlatformPool(): Pool {
  if (!globalForPlatform.__platformPool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for the platform layer');
    }

    globalForPlatform.__platformPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PLATFORM_POOL_MAX) || 5,
    });
  }

  return globalForPlatform.__platformPool;
}
