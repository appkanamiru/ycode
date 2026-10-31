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
import { translateKnownStrings } from '@/lib/templates/localize';

export const SITE_DEFAULTS = {
  /** Default language of the site's pages */
  locale: { code: 'cs', label: 'Czech' },
  settings: {
    timezone: 'Europe/Prague',
    ycode_badge: false,
    // The site's own name is set when it is created (setNewSiteName)
    site_description: '',
  } as Record<string, unknown>,
};

/** Name a freshly provisioned site after the name it was created with */
export async function setNewSiteName(db: Knex, tenantId: string, name: string): Promise<void> {
  await db('settings')
    .insert({ tenant_id: tenantId, key: 'site_name', value: JSON.stringify(name) })
    .onConflict(['tenant_id', 'key'])
    .merge({ value: JSON.stringify(name), updated_at: db.fn.now() });
}

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

    await translateErrorPages(trx, code);
  });
}

/** Error pages (password, not found, server error) in the default language */
async function translateErrorPages(trx: Knex.Transaction, localeCode: string): Promise<void> {
  const pages = await trx('pages')
    .where({ tenant_id: TEMPLATE_TENANT_ID })
    .whereNotNull('error_page')
    .select('id', 'is_published', 'name', 'settings');

  for (const page of pages) {
    const name = translateKnownStrings(page.name, localeCode);
    const settings = translateKnownStrings(page.settings, localeCode);
    if (name !== page.name || JSON.stringify(settings) !== JSON.stringify(page.settings)) {
      await trx('pages')
        .where({ tenant_id: TEMPLATE_TENANT_ID, id: page.id, is_published: page.is_published })
        .update({ name, settings: JSON.stringify(settings) });
    }

    const pageLayers = await trx('page_layers')
      .where({ tenant_id: TEMPLATE_TENANT_ID, page_id: page.id, is_published: page.is_published })
      .select('id', 'layers');
    for (const row of pageLayers) {
      const layers = translateKnownStrings(row.layers, localeCode);
      if (JSON.stringify(layers) !== JSON.stringify(row.layers)) {
        await trx('page_layers')
          .where({ tenant_id: TEMPLATE_TENANT_ID, id: row.id, is_published: page.is_published })
          .update({ layers: JSON.stringify(layers) });
      }
    }
  }
}
