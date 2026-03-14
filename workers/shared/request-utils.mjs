function normalizeIpCandidate(value) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  if (!normalized) return '';

  const firstHop = normalized.split(',')[0].trim();
  if (!firstHop) return '';

  return firstHop.replace(/^\[(.*)\]$/, '$1').trim();
}

export function clientIp(request) {
  const directIp = normalizeIpCandidate(request.headers.get('CF-Connecting-IP'));
  if (directIp) return directIp;

  const forwardedIp = normalizeIpCandidate(request.headers.get('x-forwarded-for'));
  return forwardedIp || 'unknown-ip';
}
