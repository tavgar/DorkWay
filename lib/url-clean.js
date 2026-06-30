// url-clean.js — URL normalisation, tracking-param stripping, hashing, path/filetype derivation.

// Tracking params stripped before hashing/storage so the same logical URL dedups cleanly.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_eid$/i,
  /^mc_cid$/i,
  /^igshid$/i,
  /^vero_/i,
  /^_hs/i,
  /^yclid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^spm$/i,
  /^_ga$/i,
  /^ved$/i,
  /^usg$/i,
  /^sa$/i
];

function isTracking(key) {
  return TRACKING_PARAMS.some((re) => re.test(key));
}

// Google sometimes wraps result hrefs as /url?q=<real>&... — unwrap them.
export function unwrapGoogleRedirect(rawHref, base = 'https://www.google.com') {
  try {
    const u = new URL(rawHref, base);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname)) {
      if (u.pathname === '/url' || u.pathname === '/imgres') {
        const real = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl');
        if (real) return real;
      }
    }
  } catch (_) {
    // fall through, return as-is
  }
  return rawHref;
}

/**
 * Clean a URL: unwrap Google redirects, strip tracking params, drop fragment.
 * Returns { url, queryParams, path, fileType } or null if unparseable.
 */
export function cleanUrl(rawHref, base = 'https://www.google.com') {
  const unwrapped = unwrapGoogleRedirect(rawHref, base);
  let u;
  try {
    u = new URL(unwrapped, base);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // Strip tracking params, keep the rest in stable (sorted) order.
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTracking(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const params = new URLSearchParams(kept);
  const queryParams = params.toString();

  u.search = queryParams ? `?${queryParams}` : '';
  u.hash = '';
  // Normalise: drop trailing slash on non-root paths for stabler dedup.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  const path = u.pathname || '/';
  return {
    url: u.toString(),
    queryParams,
    path,
    fileType: deriveFileType(path)
  };
}

const KNOWN_EXTENSIONS = new Set([
  'sql', 'csv', 'xls', 'xlsx', 'xml', 'json', 'log', 'txt', 'bak', 'dump',
  'pdf', 'env', 'conf', 'ini', 'zip', 'tar', 'gz', 'old', 'doc', 'docx',
  'ppt', 'pptx', 'yml', 'yaml', 'php', 'asp', 'aspx', 'jsp', 'db', 'sqlite',
  'pem', 'key', 'crt', 'cfg', 'md', 'html', 'htm', 'js', 'css'
]);

export function deriveFileType(path) {
  const last = path.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  const ext = last.slice(dot + 1).toLowerCase();
  // Only treat as a file type when it looks like a real extension.
  if (ext.length > 6 || !/^[a-z0-9]+$/.test(ext)) return '';
  if (KNOWN_EXTENSIONS.has(ext)) return ext;
  // Unknown but short alnum extension on a filename — still report it.
  return ext.length <= 4 ? ext : '';
}

/**
 * The leading directory segments of a path, used for the URL-directory facet.
 * A trailing filename is dropped so we group by directory rather than by file
 * (mirroring deriveFileType's notion of a file). Capped at `depth` segments, so
 * "/a/b/c/file.php" with the default depth becomes "/a/b".
 * @param {string} path  pathname, e.g. "/a/b/c/file.php"
 * @param {number} depth number of leading segments to keep (default 2)
 * @returns {string} e.g. "/a/b", or "" for a root path or bare filename
 */
export function deriveDirectory(path, depth = 2) {
  const segments = (path || '/').split('/').filter(Boolean);
  // Drop a trailing filename — it's a file, not a directory.
  if (segments.length && deriveFileType('/' + segments[segments.length - 1])) {
    segments.pop();
  }
  if (!segments.length) return '';
  return '/' + segments.slice(0, depth).join('/');
}

/** SHA-256 hex digest of a string, used as the dedup id. */
export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
