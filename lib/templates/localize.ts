/**
 * Localized Template Texts
 *
 * Elements, pagination and error pages come with English placeholder texts.
 * On a site whose default language has a dictionary here, they are inserted
 * in that language instead. Inserted texts are ordinary content: further
 * languages are added through translations as usual.
 */

import type { Layer } from '@/types';

type Dictionary = Record<string, string>;

const DICTIONARIES: Record<string, Dictionary> = {
  cs: {
    // Content
    'Heading': 'Nadpis',
    'Heading 1': 'Nadpis 1',
    'Heading 2': 'Nadpis 2',
    'Heading 3': 'Nadpis 3',
    'Heading 4': 'Nadpis 4',
    'Heading 5': 'Nadpis 5',
    'Heading 6': 'Nadpis 6',
    'Block quote': 'Citace',
    'Item 1': 'Položka 1',
    'Item 2': 'Položka 2',
    'Item 3': 'Položka 3',
    'Item A': 'Položka A',
    'Item B': 'Položka B',
    'Item C': 'Položka C',
    'Text link': 'Textový odkaz',
    'Bold text': 'Tučný text',
    'Italic text': 'Kurzíva',
    'Image description': 'Popis obrázku',
    // Tables
    'Header': 'Záhlaví',
    'Header 1': 'Záhlaví 1',
    'Header 2': 'Záhlaví 2',
    'Header 3': 'Záhlaví 3',
    'Cell': 'Buňka',
    'Cell 1-1': 'Buňka 1-1',
    'Cell 1-2': 'Buňka 1-2',
    'Cell 1-3': 'Buňka 1-3',
    'Cell 2-1': 'Buňka 2-1',
    'Cell 2-2': 'Buňka 2-2',
    'Cell 2-3': 'Buňka 2-3',
    // Forms
    'Something went wrong! Try submitting form once again.': 'Něco se pokazilo. Zkuste formulář odeslat znovu.',
    'Successfully submitted.': 'Odesláno, děkujeme.',
    'Full name': 'Jméno a příjmení',
    'Full Name': 'Jméno a příjmení',
    'Email': 'E-mail',
    'Message': 'Zpráva',
    'Submit': 'Odeslat',
    'Label': 'Popisek',
    'Enter text...': 'Zadejte text…',
    'Select an option': 'Vyberte možnost',
    'Option 1': 'Možnost 1',
    'Option 2': 'Možnost 2',
    'Checkbox label': 'Popisek zaškrtávacího pole',
    'Radio label': 'Popisek přepínače',
    'Search...': 'Hledat…',
    'Search': 'Hledat',
    // Media and utilities
    'New York': 'Praha',
    'Slide': 'Snímek',
    'Slide 1': 'Snímek 1',
    'Slide 2': 'Snímek 2',
    'Slide 3': 'Snímek 3',
    'Add your slogan here': 'Sem napište svůj slogan',
    // Collection pagination ("Page {current} of {pages}", "Showing {shown} of {total}")
    'Previous': 'Předchozí',
    'Next': 'Další',
    'Load More': 'Načíst další',
    'Page ': 'Strana ',
    'Showing ': 'Zobrazeno ',
    ' of ': ' z ',
    // Error pages
    '401 - Password required': '401 – Vyžadováno heslo',
    '404 - Page not found': '404 – Stránka nenalezena',
    '500 - Server error': '500 – Chyba serveru',
    'Error 401 - Password required': 'Chyba 401 – Vyžadováno heslo',
    'Error 404 - Page not found': 'Chyba 404 – Stránka nenalezena',
    'Error 500 - Server error': 'Chyba 500 – Chyba serveru',
    'This page is password protected. Please enter the password to continue.': 'Tato stránka je chráněná heslem. Pro pokračování zadejte heslo.',
    'The page you are looking for could not be found.': 'Stránku, kterou hledáte, se nepodařilo najít.',
    'Password protected': 'Chráněno heslem',
    'To access this page, please enter the required password below.': 'Pro zobrazení této stránky zadejte heslo.',
    'Incorrect password. Please try again.': 'Nesprávné heslo. Zkuste to prosím znovu.',
    'Page not found': 'Stránka nenalezena',
    'The page you are looking for does not exist.': 'Stránka, kterou hledáte, neexistuje.',
    'Server error': 'Chyba serveru',
    'An unexpected error occurred. Please try again later.': 'Došlo k neočekávané chybě. Zkuste to prosím později.',
  },
};

/** Keys that hold visible texts in layers: Tiptap text nodes, plain text, placeholders, map location */
const TEXT_KEYS = new Set(['text', 'content', 'placeholder', 'search']);

function getDictionary(localeCode: string | null | undefined): Dictionary | null {
  if (!localeCode) return null;
  return DICTIONARIES[localeCode.toLowerCase().split('-')[0]] ?? null;
}

/**
 * Replace the known English texts in a value, in place of strings exactly
 * matching a dictionary entry. With `keys`, only strings under those keys.
 */
export function translateKnownStrings<T>(value: T, localeCode: string | null | undefined, keys?: Set<string>): T {
  const dictionary = getDictionary(localeCode);
  if (!dictionary) return value;

  const visit = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string') {
      return (!keys || (key !== null && keys.has(key))) && Object.hasOwn(dictionary, node) ? dictionary[node] : node;
    }
    if (Array.isArray(node)) return node.map((item) => visit(item, key));
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return node;
  };
  return visit(value, null) as T;
}

/** A newly inserted element or pagination in the site's default language */
export function localizeTemplateTexts<T extends Layer | null>(layer: T, localeCode: string | null | undefined): T {
  return layer ? translateKnownStrings(layer, localeCode, TEXT_KEYS) : layer;
}
