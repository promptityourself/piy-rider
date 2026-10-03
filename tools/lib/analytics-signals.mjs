// analytics-signals — one detector for "what delivers analytics on this page",
// read by both the offline scan (source + built `dist/`) and the live probe.
//
// Same role as lib/cf-image.mjs: two checks look at the same HTML for the same
// strings, and when each carried its own regexes they drifted — the live probe
// knew about the Zaraz loader and the offline scan did not, and neither knew
// about Cloudflare Web Analytics at all. One table, both callers.
//
// Every pattern below was verified against Cloudflare's own docs (2026-08-03):
//   - the beacon is `https://static.cloudflareinsights.com/beacon.min.js`,
//     carrying either a `data-cf-beacon='{"token": "…"}'` attribute or a
//     `?token=…` query string (web-analytics/faq)
//   - the beacon reports to `/cdn-cgi/rum` on the site's own origin, which is
//     also what a proxied site's automatic install references
//     (fundamentals/reference/cdn-cgi-endpoint)
//   - Zaraz loads from `/cdn-cgi/zaraz/`

/**
 * Cloudflare Web Analytics — free, cookieless, no consent banner required.
 * The default analytics layer of the baseline.
 */
export const BEACON_SIGNALS = [
  [/static\.cloudflareinsights\.com\/beacon(?:\.min)?\.js/i, 'Web Analytics beacon (beacon.min.js)'],
  [/\bdata-cf-beacon\b/i,                                    'Web Analytics beacon (data-cf-beacon)'],
];

/**
 * The same product, seen from the other side: `/cdn-cgi/rum` is the endpoint the
 * beacon POSTs to, and it is on the site's own origin. A proxied site whose
 * automatic install is on references it without any beacon tag in the source.
 */
export const RUM_SIGNALS = [
  [/\/cdn-cgi\/rum\b/i, 'Web Analytics RUM endpoint (/cdn-cgi/rum)'],
];

/**
 * Cloudflare Zaraz — the tag manager. Loads Google Analytics (and others) at the
 * edge behind its own Consent Management Platform. Still fully supported; it is
 * simply no longer the thing a site has to set up before it measures anything.
 */
export const ZARAZ_SIGNALS = [
  [/\/cdn-cgi\/zaraz\//i, 'Zaraz loader (/cdn-cgi/zaraz/)'],
];

/**
 * A Google Analytics / Tag Manager snippet shipped by the site itself. Fires
 * outside any consent gate, which is the whole objection to it.
 *
 * No bare `G-…` id match: too false-positive-prone; the gtag.js loader and the
 * gtag() call cover GA4 between them.
 */
export const GA_SIGNALS = [
  [/googletagmanager\.com\/gtag\/js/i,             'gtag.js loader (GA4)'],
  [/googletagmanager\.com\/gtm\.js/i,              'gtm.js container loader'],
  [/google-analytics\.com\/(?:analytics|ga)\.js/i, 'legacy analytics.js'],
  [/\bgtag\s*\(/,                                  'gtag() call'],
  [/\bga\s*\(\s*['"]create['"]/,                   'legacy ga("create")'],
  [/['"]GTM-[A-Z0-9]{4,}['"]/,                     'GTM container id'],
  [/['"]UA-\d{4,}-\d+['"]/,                        'Universal Analytics id'],
];

/**
 * The subset of the above that is safe to look for in *served* HTML.
 *
 * A bare `gtag()` call must not be flagged live: when Zaraz delivers GA it
 * injects that bootstrap into the rendered page itself, so keying on the call
 * would flag every correctly-configured site. Only a loader fetched from a
 * Google origin proves the site went around the edge.
 */
export const GA_THIRD_PARTY_SIGNALS = GA_SIGNALS.slice(0, 3);

/** Distinct labels from `table` that appear in `text`. */
export function matchSignals(text, table) {
  const out = [];
  for (const [re, label] of table) if (re.test(text)) out.push(label);
  return out;
}

/** Does any pattern in `table` appear in `text`? */
export function hasSignal(text, table) {
  return table.some(([re]) => re.test(text));
}

/**
 * How many Web Analytics beacon <script> tags a page loads. Two is the shape
 * #41 describes: the layout's manual snippet plus Cloudflare's automatic setup
 * injecting its own at the edge — every visit counted twice. The edge-injected
 * tag carries a versioned path (`beacon.min.js/v31edd…`, seen 2026-10-03), so
 * the path is matched as a prefix. The attribute scan is the unambiguous form
 * (see lib/html.mjs): a quote is never matched by the bare-character branch.
 */
export function beaconScriptCount(html) {
  const tags = String(html ?? '').match(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? [];
  return tags.filter((t) => /static\.cloudflareinsights\.com\/beacon(?:\.min)?\.js/i.test(t)).length;
}
