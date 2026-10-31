/**
 * Settings navigation items for the settings sidebar.
 * Extracted for reuse and to allow cloud overlay to filter items.
 */

export interface SettingsNavItem {
  id: string;
  label: string;
  path: string;
  /** Hidden in multi-tenant mode, where it concerns the whole platform */
  singleSiteOnly?: boolean;
}

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { id: 'general', label: 'General', path: '/ycode/settings/general' },
  { id: 'agent', label: 'Agent', path: '/ycode/settings/agent' },
  { id: 'users', label: 'Users', path: '/ycode/settings/users' },
  { id: 'redirects', label: 'Redirects', path: '/ycode/settings/redirects' },
  { id: 'security', label: 'Security', path: '/ycode/settings/security' },
  { id: 'email', label: 'Email', path: '/ycode/settings/email' },
  { id: 'templates', label: 'Templates', path: '/ycode/settings/templates', singleSiteOnly: true },
  { id: 'updates', label: 'Updates', path: '/ycode/settings/updates', singleSiteOnly: true },
];
