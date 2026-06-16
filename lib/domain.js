// domain.js — registrable-domain + subdomain extraction.
//
// This is a pragmatic Public Suffix List implementation covering the multi-label
// suffixes you actually meet during recon. It is intentionally self-contained so the
// extension needs no build step. To get exhaustive PSL coverage, swap parseHost() for
// the `tldts` package (tldts.parse(host) -> { domain, subdomain }) and bundle its dist.

// Multi-label public suffixes (everything after the registrable label).
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'gov.in', 'ac.in', 'res.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'k12.tr',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'co.id', 'or.id', 'go.id', 'ac.id', 'web.id',
  'co.kr', 'or.kr', 'go.kr', 'ac.kr', 're.kr',
  'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'com.ng', 'org.ng', 'gov.ng', 'edu.ng',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'com.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'co.ke', 'or.ke', 'go.ke', 'ac.ke',
  // Common service/CDN suffixes where the "domain" is really the user's site.
  'github.io', 'gitlab.io', 'web.app', 'firebaseapp.com', 'pages.dev',
  'herokuapp.com', 'netlify.app', 'vercel.app', 'amazonaws.com', 's3.amazonaws.com',
  'azurewebsites.net', 'cloudfront.net', 'blob.core.windows.net'
]);

/**
 * Parse a hostname into { rootDomain, subdomain }.
 * api.dev.target.co.uk -> { rootDomain: 'target.co.uk', subdomain: 'api.dev' }
 * www stripped from the subdomain. IPs returned as-is with no subdomain.
 */
export function parseHost(hostname) {
  if (!hostname) return { rootDomain: '', subdomain: '' };
  let host = hostname.toLowerCase().replace(/\.$/, '');

  // IPv4/IPv6 — no registrable-domain concept.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return { rootDomain: host, subdomain: '' };
  }

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 1) return { rootDomain: host, subdomain: '' };

  // Find the longest matching multi-label suffix.
  let suffixLen = 1; // default: last label is the TLD
  for (let take = Math.min(3, labels.length - 1); take >= 2; take--) {
    const candidate = labels.slice(-take).join('.');
    if (MULTI_SUFFIXES.has(candidate)) {
      suffixLen = take;
      break;
    }
  }

  const rootLabels = labels.slice(-(suffixLen + 1));
  const rootDomain = rootLabels.join('.');
  let subLabels = labels.slice(0, labels.length - rootLabels.length);
  if (subLabels[0] === 'www') subLabels = subLabels.slice(1);
  const subdomain = subLabels.join('.');

  return { rootDomain, subdomain };
}

/** Strip a known multi/single suffix to return the bare registrable label (e.g. "target"). */
export function bareName(rootDomain) {
  if (!rootDomain) return '';
  const labels = rootDomain.split('.');
  return labels[0] || rootDomain;
}
