/**
 * Defaults for New Sites
 *
 * New sites are copies of the template tenant (see tenant-provisioning), so
 * the platform's defaults are written into the template's rows on every
 * migration run, after migrations have seeded them. Existing sites keep
 * their own settings.
 */

import type { Knex } from 'knex';

import { TEMPLATE_TENANT_ID } from '@/lib/database/tenancy';

export const SITE_DEFAULTS = {
  /** Default language of the site's pages */
  locale: { code: 'cs', label: 'Czech' },
  settings: {
    timezone: 'Europe/Prague',
    ycode_badge: false,
  } as Record<string, unknown>,
};

export async function applySiteDefaults(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    const { code, label } = SITE_DEFAULTS.locale;
    const existing = await trx('locales').where({ tenant_id: TEMPLATE_TENANT_ID, code }).first();
    if (!existing) {
      await trx('locales')
        .where({ tenant_id: TEMPLATE_TENANT_ID, is_default: true })
        .update({ code, label, updated_at: trx.fn.now() });
    }

    for (const [key, value] of Object.entries(SITE_DEFAULTS.settings)) {
      await trx('settings')
        .insert({ tenant_id: TEMPLATE_TENANT_ID, key, value: JSON.stringify(value) })
        .onConflict(['tenant_id', 'key'])
        .merge({ value: JSON.stringify(value), updated_at: trx.fn.now() });
    }
  });
}
