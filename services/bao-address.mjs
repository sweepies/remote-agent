export function validateAddress(address) {
  try {
    if (typeof address !== 'string' || !/^https:\/\/[^/?#@\s\\]+\/?$/.test(address)) throw new Error();
    const url = new URL(address);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error('OpenBao address must be an absolute HTTPS URL without path, query, fragment or credentials (no value logged)'); }
}
