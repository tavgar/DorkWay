// tags.js — auto-tag engine. Tags are derived from the path + query string on extraction.

const EXPOSED_FILE_TYPES = new Set([
  'sql', 'csv', 'xls', 'xlsx', 'xml', 'json', 'log', 'txt', 'bak', 'dump'
]);

// Each rule: a tag plus a predicate over a lowercased "path?query" haystack.
const RULES = [
  { tag: 'login', test: (h) => /(login|signin|sign-in|logon|auth|sso|oauth)/.test(h) },
  { tag: 'admin', test: (h) => /(admin|administrator|panel|dashboard|cpanel|wp-admin|webadmin|manage)/.test(h) },
  { tag: 'register', test: (h) => /(register|signup|sign-up|registration|join|create-account)/.test(h) },
  { tag: 'account', test: (h) => /(account|profile|\/user\/|\/users\/|member|\/me\/|my-account)/.test(h) },
  { tag: 'password', test: (h) => /(reset|forgot|recover|change-password|passwd|pwd-reset)/.test(h) },
  { tag: 'form', test: (h) => /(contact|feedback|\/form|register|subscribe|enquir|comment)/.test(h) },
  { tag: 'search', test: (h) => /(\/search|[?&](q|s|query|keyword|term)=)/.test(h) },
  { tag: 'api', test: (h) => /(\/api\/|\/v1\/|\/v2\/|\/v3\/|\/graphql|\/rest\/|swagger|openapi|\.wsdl)/.test(h) },
  { tag: 'upload', test: (h) => /(upload|import|attachment|fileupload|\/media\/)/.test(h) },
  { tag: 'payment', test: (h) => /(checkout|payment|\/cart|billing|invoice|\/order|paypal|stripe|\/pay\b)/.test(h) },
  { tag: 'backup', test: (h) => /(backup|dump|\.bak|\.old|\.zip|\.tar|\.gz|\.rar|\.7z|~$)/.test(h) },
  { tag: 'config', test: (h) => /(config|\.env|\.conf|\.ini|\.yml|\.yaml|\.cfg|settings|web\.config)/.test(h) },
  { tag: 'database', test: (h) => /(phpmyadmin|adminer|\.sql|\/db\b|database|dbadmin|mysql|pgadmin)/.test(h) },
  { tag: 'cms', test: (h) => /(wp-content|wp-includes|wp-json|wp-login|joomla|drupal|typo3|magento|\/sites\/default)/.test(h) },
  { tag: 'debug', test: (h) => /(debug|trace|stacktrace|phpinfo|test\.php|\/test\/|errors?\b|\.log)/.test(h) },
  { tag: 'redirect', test: (h) => /[?&](redirect|return|returnurl|next|continue|url|dest|destination|goto|callback)=/.test(h) },
  { tag: 'traversal', test: (h) => /[?&](file|path|page|doc|document|include|dir|folder|template|load)=/.test(h) },
  { tag: 'idor', test: (h) => /[?&](id|uid|user|user_id|account|order|order_id|invoice|num)=\d/.test(h) },
  { tag: 'git', test: (h) => /(\/\.git\/|\/\.gitignore|\/\.github\/|\/\.svn\/|\/\.hg\/)/.test(h) },
  { tag: 'sensitive', test: (h) => /(secret|private|internal|confidential|token|apikey|api_key|\bkey\b|credential|passwd)/.test(h) }
];

/**
 * Assign tags for a result.
 * @param {string} path  URL path
 * @param {string} queryParams  cleaned query string
 * @param {string} fileType  derived extension
 * @returns {string[]} sorted unique tags
 */
export function assignTags(path, queryParams, fileType) {
  const haystack = `${path || ''}?${queryParams || ''}`.toLowerCase();
  const tags = new Set();

  for (const { tag, test } of RULES) {
    if (test(haystack)) tags.add(tag);
  }
  if (fileType) {
    tags.add('file');
    if (EXPOSED_FILE_TYPES.has(fileType)) tags.add('exposed-file');
  }

  return [...tags].sort();
}

// Stable colour map for badges, consumed by the side panel CSS/JS.
export const TAG_COLORS = {
  login: '#3b82f6',
  admin: '#ef4444',
  register: '#6366f1',
  account: '#0891b2',
  password: '#f43f5e',
  form: '#14b8a6',
  search: '#64748b',
  api: '#8b5cf6',
  upload: '#f59e0b',
  payment: '#d97706',
  backup: '#dc2626',
  config: '#10b981',
  database: '#7c3aed',
  cms: '#2563eb',
  debug: '#a16207',
  redirect: '#db2777',
  traversal: '#9333ea',
  idor: '#c026d3',
  'exposed-file': '#e11d48',
  git: '#6b7280',
  sensitive: '#be123c',
  file: '#0ea5e9'
};
