import { canonicalStringify, compareOrdinal } from './canonical-json.mjs';

const PROTECTED_NAMES = Object.freeze([
  'Visual Studio Code', 'VS Code', 'GitHub', 'Microsoft', 'Node.js', 'TypeScript', 'JavaScript'
]);

function add(entries, type, value) {
  if (typeof value === 'string' && value.length > 0) entries.push({ type, value });
}

function addSpan(spans, type, value, start, end) {
  if (typeof value === 'string' && value.length > 0 && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start) {
    spans.push({ start, end, type, value });
  }
}

function collectRegex(entries, spans, type, source, expression, transform = match => match[0]) {
  for (const match of source.matchAll(expression)) {
    const value = transform(match);
    add(entries, type, value);
    addSpan(spans, type, value, match.index, match.index + value.length);
  }
}

function findMarkdownLinks(source) {
  const links = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '[' || (start > 0 && source[start - 1] === '\\')) continue;
    let closeLabel = start + 1;
    let labelDepth = 1;
    for (; closeLabel < source.length && labelDepth > 0; closeLabel += 1) {
      if (source[closeLabel] === '\\') closeLabel += 1;
      else if (source[closeLabel] === '[') labelDepth += 1;
      else if (source[closeLabel] === ']') labelDepth -= 1;
    }
    if (labelDepth !== 0 || source[closeLabel] !== '(') continue;
    const bodyStart = closeLabel + 1;
    let cursor = bodyStart;
    let depth = 1;
    let quote = '';
    for (; cursor < source.length && depth > 0; cursor += 1) {
      const character = source[cursor];
      if (character === '\\') cursor += 1;
      else if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth !== 0 || quote) continue;
    const body = source.slice(bodyStart, cursor - 1).trim();
    const titleMatch = body.match(/^(.*?)(?:\s+(["'])(.*?)\2)?$/s);
    const destination = titleMatch?.[1]?.trim() ?? '';
    const title = titleMatch?.[3] ?? '';
    if (destination) {
      const destinationStart = source.indexOf(destination, bodyStart);
      links.push({ destination, title, start: destinationStart, end: destinationStart + destination.length });
      start = cursor - 1;
    }
  }
  return links;
}

function extractCode(entries, spans, source) {
  const fencedRanges = [];
  const fence = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
  for (const match of source.matchAll(fence)) {
    const value = `${match[2]}${match[3]}\n${match[4]}\n${match[2]}`;
    add(entries, 'code-fence', value);
    addSpan(spans, 'code-fence', value, match.index + match[1].length, match.index + match[0].length);
    fencedRanges.push([match.index, match.index + match[0].length]);
  }
  const span = /(`+)([^\r\n]*?)\1/g;
  for (const match of source.matchAll(span)) {
    if (!fencedRanges.some(([start, end]) => match.index >= start && match.index < end)) {
      add(entries, 'code-span', match[0]);
      addSpan(spans, 'code-span', match[0], match.index, match.index + match[0].length);
    }
  }
}

function extractEscapes(entries, spans, source) {
  collectRegex(entries, spans, 'escape', source, /\r\n|[\r\n\t]/g);
  collectRegex(entries, spans, 'escape', source, /\\(?:[nrt\\{}]|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/g);
  collectRegex(entries, spans, 'escape', source, /\{\{|\}\}/g);
}

function extractMnemonics(entries, spans, source) {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '&') continue;
    let end = index + 1;
    while (source[end] === '&') end += 1;
    const run = source.slice(index, end);
    add(entries, 'mnemonic', run);
    addSpan(spans, 'mnemonic', run, index, end);
    index = end - 1;
  }
}

function extractLocked(entries, spans, source, context) {
  for (const comment of context) {
    for (const match of comment.matchAll(/\{Locked=(['"])(.*?)\1\}/g)) {
      const value = match[2];
      if (!value) throw new Error('protected-content extraction failed: empty locked fragment');
      // Upstream also uses Locked instructions for syntax the translator must
      // introduce around placeholders. Count the declaration itself rather
      // than assuming the declared fragment already occurs in the source.
      add(entries, 'locked', value);
      for (let start = source.indexOf(value); start !== -1; start = source.indexOf(value, start + Math.max(1, value.length))) {
        addSpan(spans, 'locked', value, start, start + value.length);
      }
    }
  }
}

export function foldProtectedEntries(entries) {
  const folded = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.type !== 'string' || typeof entry.value !== 'string' || entry.type.length === 0 || entry.value.length === 0) {
      throw new TypeError('protected entries require non-empty string type and value');
    }
    const identity = canonicalStringify([entry.type, entry.value]);
    const existing = folded.get(identity);
    if (existing) existing.count += Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1;
    else folded.set(identity, { type: entry.type, value: entry.value, count: Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1 });
  }
  return [...folded.values()].sort((left, right) => compareOrdinal(left.type, right.type) || compareOrdinal(left.value, right.value));
}

function extractProtected(source, context) {
  if (typeof source !== 'string') throw new TypeError('protected-content source must be a string');
  if (!Array.isArray(context) || context.some(item => typeof item !== 'string')) throw new TypeError('protected-content context must be a string array');
  const entries = [];
  const spans = [];

  extractCode(entries, spans, source);
  for (const link of findMarkdownLinks(source)) {
    const value = canonicalStringify([link.destination, link.title]);
    add(entries, 'markdown-link', value);
    addSpan(spans, 'markdown-link', value, link.start, link.end);
  }
  collectRegex(entries, spans, 'command-uri', source, /command:[A-Za-z0-9._-]+(?:\?[^\s)>'"]+)?/g);
  collectRegex(entries, spans, 'url', source, /https?:\/\/[^\s<>()\[\]"']+/g, match => match[0].replace(/[.,;:!?]+$/, ''));
  collectRegex(entries, spans, 'codicon', source, /\$\([A-Za-z0-9-]+(?:~[A-Za-z0-9-]+)?\)/g);
  collectRegex(entries, spans, 'placeholder', source, /\{(?:\d+|[A-Za-z_][A-Za-z0-9_.-]*)\}/g);
  collectRegex(entries, spans, 'placeholder', source, /%(?:\d+\$)?[-+#0 ']*\d*(?:\.\d+)?[bcdeEfgGiosuxX%]/g);
  collectRegex(entries, spans, 'keybinding', source, /\b(?:Ctrl|Control|Cmd|Command|Alt|Option|Shift|Meta|Win)(?:\+(?:[A-Za-z0-9]+|F\d+)){1,4}(?:\s+(?:Ctrl|Control|Cmd|Command|Alt|Option|Shift|Meta|Win)(?:\+(?:[A-Za-z0-9]+|F\d+)){1,4})?/gi);
  extractEscapes(entries, spans, source);
  extractMnemonics(entries, spans, source);
  extractLocked(entries, spans, source, context);
  for (const name of PROTECTED_NAMES) collectRegex(entries, spans, 'protected-name', source, new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g'));

  spans.sort((left, right) => left.start - right.start || left.end - right.end || compareOrdinal(left.type, right.type) || compareOrdinal(left.value, right.value));
  return { entries: foldProtectedEntries(entries), spans };
}

export function extractProtectedContent(source, context = []) {
  return extractProtected(source, context).entries;
}

export function extractProtectedSpans(source, context = []) {
  return extractProtected(source, context).spans;
}

export function maskProtectedRanges(source, spans = extractProtectedSpans(source)) {
  if (typeof source !== 'string') throw new TypeError('protected-content source must be a string');
  if (!Array.isArray(spans)) throw new TypeError('protected-content spans must be an array');
  // RegExp and string offsets are UTF-16 code-unit indexes in JavaScript.
  // split('') deliberately preserves that indexing when astral text appears
  // before a protected span.
  const masked = source.split('');
  for (const span of spans) {
    if (!Number.isInteger(span?.start) || !Number.isInteger(span?.end) || span.start < 0 || span.end < span.start || span.end > source.length) {
      throw new TypeError('protected-content span is outside the source');
    }
    for (let index = span.start; index < span.end; index += 1) if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  }
  return masked.join('');
}

export { PROTECTED_NAMES };
