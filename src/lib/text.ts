const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** HTML to readable plain text. Handles Greenhouse's double-escaped HTML too. */
export function htmlToText(html: string): string {
  let s = html.includes('&lt;') ? decodeEntities(html) : html;
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>|<\/(p|div|ul|ol|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}(?=• )/g, '\n') // list items sit directly under the line before them
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Same job posted on two sources gets the same fingerprint. */
export function fingerprint(company: string, title: string, location: string): string {
  const city = normalize(location).split(' ')[0] ?? '';
  return [normalize(company).replace(/\b(inc|ltd|llc|pvt|private|limited|technologies|labs)\b/g, '').trim(), normalize(title), city].join('|');
}

/** ISO timestamp, or null when the input is not a valid date. */
export function toIso(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
