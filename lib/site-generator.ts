/**
 * The builder that published sites name as their generator (meta tag, source
 * stamp and the "Made in …" badge): SITE_GENERATOR_NAME and SITE_GENERATOR_URL,
 * Ycode by default. Free of server imports, so client components can use it.
 */

export interface SiteGenerator {
  name: string;
  url: string | null;
}

export function getSiteGenerator(): SiteGenerator {
  const name = process.env.SITE_GENERATOR_NAME?.trim();
  if (!name) return { name: 'Ycode', url: 'ycode.com' };
  return { name, url: process.env.SITE_GENERATOR_URL?.trim() || null };
}
