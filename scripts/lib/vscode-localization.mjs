import { canonicalHash, canonicalStringify, compareOrdinal } from './canonical-json.mjs';
import { extractProtectedContent } from './protected-content.mjs';

function fail(message) {
  throw new Error(`localization normalization failed: ${message}`);
}

function stringArray(value, label) {
  if (value === undefined) return [];
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) fail(`${label} must be a string or string array`);
  return [...items];
}

export function createInventoryUnit({ component, bundle, module, key, source, context = [] }) {
  for (const [label, value] of Object.entries({ component, bundle, module, key, source })) {
    if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  }
  const normalizedContext = stringArray(context, 'context');
  const protectedEntries = extractProtectedContent(source, normalizedContext);
  const id = canonicalStringify([bundle, module, key]);
  const sourceFingerprint = `sha256:${canonicalHash([source, normalizedContext, protectedEntries])}`;
  return { id, component, bundle, module, key, source, context: normalizedContext, protected: protectedEntries, sourceFingerprint };
}

export function normalizeCoreMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !metadata.keys || !metadata.messages) fail('core metadata shape is invalid');
  const keyModules = Object.keys(metadata.keys).sort(compareOrdinal);
  const messageModules = Object.keys(metadata.messages).sort(compareOrdinal);
  if (canonicalStringify(keyModules) !== canonicalStringify(messageModules)) fail('core key/message module sets differ');
  if (keyModules.length !== 1_800) fail(`core module count is ${keyModules.length}, expected 1800`);

  const byIdentity = new Map();
  let sourceOccurrences = 0;
  for (const module of keyModules) {
    const keys = metadata.keys[module];
    const messages = metadata.messages[module];
    if (!Array.isArray(keys) || !Array.isArray(messages) || keys.length !== messages.length) fail(`core key/message parity mismatch in ${module}`);
    for (let index = 0; index < keys.length; index += 1) {
      const rawKey = keys[index];
      let key;
      let context = [];
      if (typeof rawKey === 'string') key = rawKey;
      else if (rawKey && typeof rawKey === 'object' && !Array.isArray(rawKey) && Object.keys(rawKey).every(item => item === 'key' || item === 'comment')) {
        key = rawKey.key;
        context = stringArray(rawKey.comment, `core comment ${module}[${index}]`);
      } else fail(`unsupported core key shape in ${module}[${index}]`);
      const source = messages[index];
      sourceOccurrences += 1;
      const unit = createInventoryUnit({ component: 'core', bundle: 'vscode', module, key, source, context });
      const existing = byIdentity.get(unit.id);
      if (existing) {
        if (existing.source !== unit.source) fail(`conflicting duplicate core identity ${unit.id}`);
        const mergedContext = [...existing.context];
        for (const comment of unit.context) if (!mergedContext.includes(comment)) mergedContext.push(comment);
        byIdentity.set(unit.id, createInventoryUnit({ component: 'core', bundle: 'vscode', module, key, source, context: mergedContext }));
      } else byIdentity.set(unit.id, unit);
    }
  }
  if (sourceOccurrences !== 21_818) fail(`core source occurrence count is ${sourceOccurrences}, expected 21818`);
  return [...byIdentity.values()].sort((left, right) => compareOrdinal(left.id, right.id));
}

export function normalizePackageCatalog(catalog, { bundle, module = 'package.nls.json' }) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) fail(`package catalog for ${bundle} is invalid`);
  const units = [];
  for (const key of Object.keys(catalog).sort(compareOrdinal)) {
    const raw = catalog[key];
    let source;
    let context = [];
    if (typeof raw === 'string') source = raw;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(item => item === 'message' || item === 'comment')) {
      source = raw.message;
      context = stringArray(raw.comment, `package comment ${bundle}/${key}`);
    } else fail(`unsupported package catalog value for ${bundle}/${key}`);
    units.push(createInventoryUnit({ component: 'extension', bundle, module, key, source, context }));
  }
  return units;
}

function skipSpace(source, cursor) {
  while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  return cursor;
}

function readJsString(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') fail(`expected JavaScript string at offset ${start}`);
  let value = '';
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === quote) return { value, end: cursor + 1 };
    if (quote === '`' && character === '$' && source[cursor + 1] === '{') fail(`dynamic localization template at offset ${start} is unsupported`);
    if (character !== '\\') {
      value += character;
      continue;
    }
    cursor += 1;
    if (cursor >= source.length) fail(`unterminated JavaScript escape at offset ${start}`);
    const escaped = source[cursor];
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (source[cursor + 1] === '\n') cursor += 1;
      continue;
    }
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'", '`': '`' };
    if (Object.hasOwn(simple, escaped)) {
      value += simple[escaped];
      continue;
    }
    if (escaped === 'x') {
      const digits = source.slice(cursor + 1, cursor + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) fail(`invalid hexadecimal escape at offset ${cursor}`);
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      cursor += 2;
      continue;
    }
    if (escaped === 'u') {
      if (source[cursor + 1] === '{') {
        const close = source.indexOf('}', cursor + 2);
        const digits = close === -1 ? '' : source.slice(cursor + 2, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) fail(`invalid Unicode escape at offset ${cursor}`);
        value += String.fromCodePoint(Number.parseInt(digits, 16));
        cursor = close;
      } else {
        const digits = source.slice(cursor + 1, cursor + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail(`invalid Unicode escape at offset ${cursor}`);
        value += String.fromCodePoint(Number.parseInt(digits, 16));
        cursor += 4;
      }
      continue;
    }
    value += escaped;
  }
  fail(`unterminated JavaScript string at offset ${start}`);
}

function skipComment(source, cursor) {
  if (source[cursor] !== '/') return cursor;
  if (source[cursor + 1] === '/') {
    const end = source.indexOf('\n', cursor + 2);
    return end === -1 ? source.length : end + 1;
  }
  if (source[cursor + 1] === '*') {
    const end = source.indexOf('*/', cursor + 2);
    if (end === -1) fail(`unterminated block comment at offset ${cursor}`);
    return end + 2;
  }
  return cursor;
}

function skipRegexLiteral(source, cursor) {
  if (source[cursor] !== '/' || source[cursor + 1] === '/' || source[cursor + 1] === '*') return cursor;
  let previous = cursor - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
  const priorCharacter = source[previous] ?? '';
  const priorWord = source.slice(0, previous + 1).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? '';
  if (priorCharacter && !'([{:;,=!?&|+-*%^~<>'.includes(priorCharacter) && !['return', 'case', 'throw', 'else', 'yield', 'await'].includes(priorWord)) return cursor;
  let inClass = false;
  for (let index = cursor + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') index += 1;
    else if (character === '\n' || character === '\r') return cursor;
    else if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      index += 1;
      while (/[A-Za-z]/.test(source[index] ?? '')) index += 1;
      return index;
    }
  }
  return cursor;
}

function skipTemplateLiteral(source, start) {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') cursor += 1;
    else if (source[cursor] === '`') return cursor + 1;
    else if (source[cursor] === '$' && source[cursor + 1] === '{') cursor = findBalanced(source, cursor + 1, '{', '}');
  }
  fail(`unterminated JavaScript template at offset ${start}`);
}

function findBalanced(source, start, open, close) {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      cursor = readJsString(source, cursor).end - 1;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplateLiteral(source, cursor) - 1;
      continue;
    }
    const commentEnd = skipComment(source, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd - 1;
      continue;
    }
    const regexEnd = skipRegexLiteral(source, cursor);
    if (regexEnd !== cursor) {
      cursor = regexEnd - 1;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) return cursor;
  }
  fail(`unterminated ${open}${close} structure at offset ${start}`);
}

function splitTopLevel(source, start, end) {
  const parts = [];
  let partStart = start;
  const stack = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      cursor = readJsString(source, cursor).end - 1;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplateLiteral(source, cursor) - 1;
      continue;
    }
    const commentEnd = skipComment(source, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd - 1;
      continue;
    }
    const regexEnd = skipRegexLiteral(source, cursor);
    if (regexEnd !== cursor) {
      cursor = regexEnd - 1;
      continue;
    }
    if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) stack.pop();
    else if (character === ',' && stack.length === 0) {
      parts.push([partStart, cursor]);
      partStart = cursor + 1;
    }
  }
  parts.push([partStart, end]);
  return parts;
}

function topLevelColon(source, start, end) {
  const stack = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      cursor = readJsString(source, cursor).end - 1;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplateLiteral(source, cursor) - 1;
      continue;
    }
    const regexEnd = skipRegexLiteral(source, cursor);
    if (regexEnd !== cursor) {
      cursor = regexEnd - 1;
      continue;
    }
    if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) stack.pop();
    else if (character === ':' && stack.length === 0) return cursor;
  }
  return -1;
}

function parseStaticStringArray(source, start, end) {
  let cursor = skipSpace(source, start);
  if (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === '`') return [readJsString(source, cursor).value];
  if (source[cursor] !== '[') fail(`localization comment at offset ${start} is not static`);
  const close = findBalanced(source, cursor, '[', ']');
  if (skipSpace(source, close + 1) < end) fail(`localization comment at offset ${start} has unsupported trailing syntax`);
  const result = [];
  for (const [itemStart, itemEnd] of splitTopLevel(source, cursor + 1, close)) {
    const valueStart = skipSpace(source, itemStart);
    if (valueStart >= itemEnd) continue;
    const parsed = readJsString(source, valueStart);
    if (skipSpace(source, parsed.end) < itemEnd) fail(`localization comment item at offset ${valueStart} is not static`);
    result.push(parsed.value);
  }
  return result;
}

function parseMessageObject(source, start) {
  const close = findBalanced(source, start, '{', '}');
  let message;
  let context = [];
  const seen = new Set();
  for (const [partStart, partEnd] of splitTopLevel(source, start + 1, close)) {
    const trimmedStart = skipSpace(source, partStart);
    if (trimmedStart >= partEnd) continue;
    const colon = topLevelColon(source, trimmedStart, partEnd);
    if (colon === -1) fail(`localization message object property at offset ${trimmedStart} is unsupported`);
    const rawKey = source.slice(trimmedStart, colon).trim();
    let key;
    if (/^[A-Za-z_$][\w$]*$/.test(rawKey)) key = rawKey;
    else if (/^["'`]/.test(rawKey)) key = readJsString(source, trimmedStart).value;
    else fail(`localization message object key at offset ${trimmedStart} is unsupported`);
    if (seen.has(key)) fail(`duplicate localization message object property ${key}`);
    seen.add(key);
    const valueStart = skipSpace(source, colon + 1);
    if (key === 'message') {
      const parsed = readJsString(source, valueStart);
      if (skipSpace(source, parsed.end) < partEnd) fail(`localization message at offset ${valueStart} is not static`);
      message = parsed.value;
    } else if (key === 'comment') context = parseStaticStringArray(source, valueStart, partEnd);
    else if (key !== 'args') fail(`unsupported localization message object property ${key}`);
  }
  if (typeof message !== 'string' || message.length === 0) fail(`localization message object at offset ${start} has no static message`);
  return { message, context, end: close + 1 };
}

function unsupportedAccess(source, cursor) {
  if (source.startsWith('?.l10n', cursor)) return 'optional receiver access';
  if (source.startsWith('.l10n?.', cursor)) return 'optional method access';
  if (source.startsWith('l10n.t', cursor) && !/[\w$]/.test(source[cursor - 1] ?? '')) return 'aliased l10n access';
  if (source.startsWith('vscode', cursor) && !/[\w$]/.test(source[cursor - 1] ?? '')) {
    const after = skipSpace(source, cursor + 'vscode'.length);
    if (source[after] === '[') return 'dynamic vscode access';
  }
  if (source[cursor] === '[') {
    const keyStart = skipSpace(source, cursor + 1);
    if (source[keyStart] === '"' || source[keyStart] === "'") {
      const key = readJsString(source, keyStart);
      const close = skipSpace(source, key.end);
      if (key.value === 'l10n' && source[close] === ']') return 'computed l10n access';
    }
  }
  if (source.startsWith('.l10n', cursor) && !source.startsWith('.l10n.t', cursor)) {
    const after = skipSpace(source, cursor + '.l10n'.length);
    if (after === source.length || ';,)'.includes(source[after])) return 'aliased l10n namespace';
  }
  return '';
}

function scanCode(source, state, start = 0, stopAtBrace = false) {
  let braceDepth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      cursor = readJsString(source, cursor).end - 1;
      continue;
    }
    if (character === '`') {
      cursor = scanTemplate(source, state, cursor + 1);
      continue;
    }
    const commentEnd = skipComment(source, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd - 1;
      continue;
    }
    const regexEnd = skipRegexLiteral(source, cursor);
    if (regexEnd !== cursor) {
      cursor = regexEnd - 1;
      continue;
    }
    if (stopAtBrace && character === '{') braceDepth += 1;
    else if (stopAtBrace && character === '}') {
      if (braceDepth === 0) return cursor;
      braceDepth -= 1;
    }
    const unsupported = unsupportedAccess(source, cursor);
    if (unsupported) fail(`${unsupported} at offset ${cursor}`);
    if (!source.startsWith('.l10n.t', cursor)) continue;
    state.candidateCalls += 1;
    let callStart = skipSpace(source, cursor + '.l10n.t'.length);
    if (source[callStart] !== '(' && source[callStart] !== '`') fail(`unsupported vscode.l10n.t form at offset ${cursor}`);
    let message;
    let context = [];
    let end;
    if (source[callStart] === '`') {
      const parsed = readJsString(source, callStart);
      message = parsed.value;
      end = parsed.end;
    } else {
      const close = findBalanced(source, callStart, '(', ')');
      const first = skipSpace(source, callStart + 1);
      if (source[first] === '"' || source[first] === "'" || source[first] === '`') message = readJsString(source, first).value;
      else if (source[first] === '{') ({ message, context } = parseMessageObject(source, first));
      else fail(`unsupported vscode.l10n.t message at offset ${first}`);
      end = close + 1;
    }
    state.calls.push({ message, context, offset: cursor });
    state.consumedCalls += 1;
    cursor = end - 1;
  }
  if (stopAtBrace) fail(`unterminated template expression at offset ${start}`);
  return source.length;
}

function scanTemplate(source, state, start) {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '`') return cursor;
    if (source[cursor] === '$' && source[cursor + 1] === '{') cursor = scanCode(source, state, cursor + 2, true);
  }
  fail(`unterminated JavaScript template at offset ${start - 1}`);
}

export function extractVscodeLocalizationCalls(source, { bundle, module }) {
  if (typeof source !== 'string') fail(`JavaScript source for ${bundle}/${module} is invalid`);
  const state = { calls: [], candidateCalls: 0, consumedCalls: 0 };
  scanCode(source, state);
  const byKey = new Map();
  for (const call of state.calls) {
    const key = call.context.length ? `${call.message}/${call.context.join('')}` : call.message;
    const unit = createInventoryUnit({ component: 'extension', bundle, module, key, source: call.message, context: call.context });
    const existing = byKey.get(key);
    if (existing && canonicalStringify(existing) !== canonicalStringify(unit)) fail(`generated localization key collision in ${bundle}/${module}: ${key}`);
    if (!existing) byKey.set(key, unit);
  }
  return {
    candidateCalls: state.candidateCalls,
    consumedCalls: state.consumedCalls,
    foldedExactCalls: state.consumedCalls - byKey.size,
    units: [...byKey.values()].sort((left, right) => compareOrdinal(left.id, right.id))
  };
}
