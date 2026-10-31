/**
 * PostgREST Syntax Parsing
 *
 * Parses the string mini-languages that supabase-js forwards to PostgREST:
 * select lists (`'id, name, page_layers!inner(content_hash)'`) and logic
 * trees (`.or('is_active.eq.true,refresh_grace_until.gt.2024-01-01')`).
 *
 * Only the subset used by Ycode is supported. Anything else throws, so an
 * unsupported query fails loudly instead of silently returning wrong data.
 */

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'is'
  | 'in';

export type Condition =
  | { type: 'filter'; column: string; operator: FilterOperator; value: unknown; negate: boolean }
  | { type: 'and' | 'or'; conditions: Condition[]; negate: boolean };

export type SelectItem =
  | { type: 'star' }
  | { type: 'column'; name: string }
  | { type: 'embed'; relation: string; inner: boolean; items: SelectItem[] };

const FILTER_OPERATORS = new Set<string>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `relation(...)`, `relation!inner(...)` or `relation!left(...)` (left is the default) */
const EMBED = /^([A-Za-z_][A-Za-z0-9_]*)(?:!(inner|left))?\(([\s\S]*)\)$/;

export function isFilterOperator(value: string): value is FilterOperator {
  return FILTER_OPERATORS.has(value);
}

/**
 * Split on commas that are not nested inside parentheses or double quotes.
 */
export function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '\\' && inQuotes && i + 1 < input.length) {
      current += char + input[i + 1];
      i++;
      continue;
    }
    if (char === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += char;
  }

  if (depth !== 0 || inQuotes) {
    throw new Error(`Unbalanced parentheses or quotes in "${input}"`);
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Parse a select list, e.g. `'*, page_layers!inner(content_hash)'`.
 */
export function parseSelect(columns: string): SelectItem[] {
  return splitTopLevel(columns).map((item) => {
    if (item === '*') return { type: 'star' };

    const embed = item.match(EMBED);
    if (embed) {
      const items = parseSelect(embed[3]);
      if (items.some((child) => child.type === 'embed')) {
        throw new Error(`Nested embeds are not supported: "${item}"`);
      }
      return { type: 'embed', relation: embed[1], inner: embed[2] === 'inner', items };
    }

    if (!IDENTIFIER.test(item)) {
      throw new Error(`Unsupported select item: "${item}"`);
    }
    return { type: 'column', name: item };
  });
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/**
 * Convert a PostgREST filter value string into a JS value for the operator.
 * `is` accepts null/true/false/unknown, `in` accepts `(a,b,"c,d")`.
 */
export function parseFilterValue(operator: FilterOperator, raw: string): unknown {
  if (operator === 'is') {
    const keyword = raw.toLowerCase();
    if (keyword === 'null') return null;
    if (keyword === 'true') return true;
    if (keyword === 'false') return false;
    if (keyword === 'unknown') return 'unknown';
    throw new Error(`Invalid value for "is": "${raw}"`);
  }

  if (operator === 'in') {
    if (!raw.startsWith('(') || !raw.endsWith(')')) {
      throw new Error(`Invalid value for "in": "${raw}"`);
    }
    return splitTopLevel(raw.slice(1, -1)).map(unquote);
  }

  return unquote(raw);
}

function parseCondition(expression: string): Condition {
  let rest = expression;
  let negate = false;

  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }

  const group = rest.match(/^(and|or)\(([\s\S]*)\)$/);
  if (group) {
    return {
      type: group[1] as 'and' | 'or',
      conditions: splitTopLevel(group[2]).map(parseCondition),
      negate,
    };
  }

  const columnEnd = rest.indexOf('.');
  if (columnEnd <= 0) throw new Error(`Invalid filter expression: "${expression}"`);
  const column = rest.slice(0, columnEnd);
  rest = rest.slice(columnEnd + 1);

  if (rest.startsWith('not.')) {
    negate = !negate;
    rest = rest.slice(4);
  }

  const operatorEnd = rest.indexOf('.');
  const operator = operatorEnd === -1 ? rest : rest.slice(0, operatorEnd);
  if (!isFilterOperator(operator)) {
    throw new Error(`Unsupported filter operator "${operator}" in "${expression}"`);
  }

  const rawValue = operatorEnd === -1 ? '' : rest.slice(operatorEnd + 1);
  return { type: 'filter', column, operator, value: parseFilterValue(operator, rawValue), negate };
}

/**
 * Parse the argument of `.or()`, e.g.
 * `'refresh_expires_at.lt.2024-01-01,and(is_active.eq.false,refresh_grace_until.lt.2024-01-01)'`.
 */
export function parseOrFilter(filters: string): { type: 'or'; conditions: Condition[]; negate: boolean } {
  return { type: 'or', conditions: splitTopLevel(filters).map(parseCondition), negate: false };
}

export interface ColumnPath {
  column: string;
  json: Array<{ arrow: '->' | '->>'; key: string }>;
}

/**
 * Parse a column reference that may use JSON arrows, e.g. `metadata->>ip`.
 */
export function parseColumnPath(reference: string): ColumnPath {
  const [column, ...segments] = reference.split(/(->>?)/);
  if (!IDENTIFIER.test(column)) {
    throw new Error(`Invalid column reference: "${reference}"`);
  }

  const json: ColumnPath['json'] = [];
  for (let i = 0; i < segments.length; i += 2) {
    const key = segments[i + 1];
    if (!key) throw new Error(`Invalid JSON path in "${reference}"`);
    json.push({ arrow: segments[i] as '->' | '->>', key });
  }

  return { column, json };
}
