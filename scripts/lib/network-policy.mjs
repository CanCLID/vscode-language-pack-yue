export const NETWORK_HOSTS = Object.freeze({
  githubApi: Object.freeze(['api.github.com']),
  vscodeArtifact: Object.freeze(['update.code.visualstudio.com', 'vscode.download.prss.microsoft.com']),
  marketplace: Object.freeze(['marketplace.visualstudio.com']),
  marketplaceCdnSuffixes: Object.freeze(['vsassets.io', 'visualstudio.com', 'prss.microsoft.com'])
});

export function validateHttpsUrl(value, { exactHosts = [], suffixHosts = [], label = 'network URL' } = {}) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (url.port && url.port !== '443') throw new Error(`${label} uses an unexpected port`);
  const hostname = url.hostname.toLowerCase();
  const exact = exactHosts.some(host => hostname === host.toLowerCase());
  const suffixed = suffixHosts.some(host => {
    const suffix = host.toLowerCase();
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!exact && !suffixed) throw new Error(`${label} host is not allowlisted`);
  return url;
}
