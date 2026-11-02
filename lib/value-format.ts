/**
 * Value Format
 *
 * How CMS values (dates, numbers) are displayed on a rendered page: in the
 * site's timezone and the language of the page. Passed explicitly through
 * rendering, on the server and in the browser alike, so both produce the
 * same output.
 *
 * CLIENT-SAFE: pure helpers, no server-only imports.
 */

export interface ValueFormat {
  /** IANA timezone of the site, e.g. `Europe/Prague` */
  timezone: string;
  /** BCP 47 language tag of the page, e.g. `cs`; English (en-US) when absent */
  locale?: string;
}

export const DEFAULT_VALUE_FORMAT: ValueFormat = { timezone: 'UTC' };

/** Formatting locale used when none is given: the output Ycode has always produced */
export const DEFAULT_FORMAT_LOCALE = 'en-US';

/**
 * Intl locale for a locale code. Codes are stored lowercase (`zh-cn`), which
 * Intl canonicalizes; anything Intl rejects falls back to English.
 */
export function toIntlLocale(code: string | null | undefined): string {
  if (!code) return DEFAULT_FORMAT_LOCALE;
  try {
    return Intl.getCanonicalLocales(code)[0] ?? DEFAULT_FORMAT_LOCALE;
  } catch {
    return DEFAULT_FORMAT_LOCALE;
  }
}

/**
 * Language a page's values are formatted in: the page's locale, else the
 * site's default locale (same rule as the document's `lang`).
 */
export function resolveFormatLocale(
  currentLocale: { code: string } | null | undefined,
  availableLocales: Array<{ code: string; is_default: boolean }> | null | undefined,
): string | undefined {
  return currentLocale?.code ?? availableLocales?.find((locale) => locale.is_default)?.code;
}
