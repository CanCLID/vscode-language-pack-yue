const DENIED_SOURCE_INPUT = /(?:^|[^a-z0-9])(?:vscode-loc|zh[-_]?(?:hant|tw))(?:[^a-z0-9]|$)/i;

export function isDeniedSourceInput(value) {
  return typeof value !== 'string' || DENIED_SOURCE_INPUT.test(value);
}
