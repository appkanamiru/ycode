import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAgentSecretSettingKey } from '@/lib/agent/config';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getAllSettings, getSettingByKey, setSetting, setSettings } from '@/lib/repositories/settingsRepository';

/** Large generated values left out of the "all settings" listing unless asked for by key. */
const LARGE_SETTING_KEYS = new Set(['draft_css', 'published_css']);

/** On the platform the badge shows until the site has its own domain; it is not a setting */
const PLATFORM_BADGE_ERROR = 'ycode_badge cannot be changed on this platform: the "Made in" badge shows until the site is served on its own domain, and disappears once a verified custom domain is made primary.';

function getSettingKeysDoc(): string {
  const badgeDoc = isMultiTenant()
    ? '- ycode_badge: read-only here; the badge shows until a verified custom domain is primary'
    : '- ycode_badge: boolean, show the Ycode badge on the published site';
  return SETTING_KEYS_DOC.replace('{{ycode_badge}}', badgeDoc);
}

function badgeChangeError() {
  return { content: [{ type: 'text' as const, text: `Error: ${PLATFORM_BADGE_ERROR}` }], isError: true };
}

const SETTING_KEYS_DOC = `Supported keys (the same ones Settings > General writes):
- site_name: string
- favicon_asset_id: asset ID (from upload_asset) used as the favicon
- web_clip_asset_id: asset ID used as the Apple touch / web clip icon
- global_canonical_url: string, e.g. "https://example.com"
- custom_code_head / custom_code_body: HTML injected on every page
- ga_measurement_id: Google Analytics ID, e.g. "G-XXXXXXX"
- google_site_verification: Search Console verification token
- robots_txt, llms_txt, security_txt: file contents
{{ycode_badge}}
- timezone: IANA timezone, e.g. "Europe/Vilnius"
Redirects are managed with the redirect tools, not here.`;

const settingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()),
]);

export function registerSettingsTools(server: McpServer) {
  server.tool(
    'get_settings',
    `Get all site settings or a specific setting by key. The full listing omits the large generated draft_css and published_css values — request them by key if needed.

${getSettingKeysDoc()}`,
    {
      key: z.string().optional().describe('Specific setting key to retrieve. Omit to get all settings.'),
    },
    async ({ key }) => {
      if (key) {
        const value = isAgentSecretSettingKey(key) ? '[redacted]' : await getSettingByKey(key);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ key, value }, null, 2),
          }],
        };
      }

      const settings = await getAllSettings();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(settings
            .filter((s) => !LARGE_SETTING_KEYS.has(s.key))
            .map((s) => ({
              key: s.key,
              value: isAgentSecretSettingKey(s.key) ? '[redacted]' : s.value,
            })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_setting',
    `Set a site setting value. Creates the setting if it does not exist, updates it otherwise. To set the favicon, upload the image with upload_asset and set favicon_asset_id to the returned asset ID.

${getSettingKeysDoc()}`,
    {
      key: z.string().describe('Setting key (e.g. "site_name", "favicon_asset_id")'),
      value: settingValueSchema.describe('Setting value (string, number, boolean, or object)'),
    },
    async ({ key, value }) => {
      if (key === 'ycode_badge' && isMultiTenant()) return badgeChangeError();
      const setting = await setSetting(key, value);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Setting "${key}" saved`, setting }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_settings_batch',
    'Set multiple site settings at once. Pass null as value to delete a setting. See set_setting for the supported keys.',
    {
      settings: z.record(z.string(), settingValueSchema.nullable()).describe('Object of key-value pairs to set. Use null to delete a key.'),
    },
    async ({ settings }) => {
      if ('ycode_badge' in settings && isMultiTenant()) return badgeChangeError();
      const count = await setSettings(settings);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Updated ${count} setting(s)`, count }, null, 2),
        }],
      };
    },
  );
}
