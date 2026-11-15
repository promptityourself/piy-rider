// Cloudflare Image-Transformation URL helpers, shared by the offline (built HTML)
// and live (rendered HTML) image checks so both flag the same param anti-patterns.
//
// A transform URL is /cdn-cgi/image/<comma-separated-options>/<source>. We flag:
//   - explicit non-auto format (format=webp/avif/jpeg/…): no AVIF negotiation, and
//     onerror=redirect then serves the raw source to clients that don't accept it
//   - missing quality=: Cloudflare defaults to 85; an explicit cap (e.g. 80) is
//     usually a large win on photographic content
// Aliases per Cloudflare docs: format|f, quality|q.


// The options segment between /cdn-cgi/image/ and the source path, or null.
export function transformOptions(src) {
  return src.match(/\/cdn-cgi\/image\/([^/]+)\//)?.[1] ?? null;
}

// What the transform reads FROM: everything after the options segment, or null.
// `/cdn-cgi/image/width=800,format=auto/images/hero.jpg` → `/images/hero.jpg`.
// The source may be a remote URL rather than a path — that is Cloudflare's own
// syntax and the caller decides what to do with one.
export function transformSource(src) {
  const m = src.match(/\/cdn-cgi\/image\/[^/]+(\/.*)$/);
  return m ? m[1] : null;
}

// { explicitFormat: <fmt|null>, missingQuality: <bool> }, or null if not a transform URL.
export function transformSmells(src) {
  const opts = transformOptions(src);
  if (opts == null) return null;
  const fmt = opts.match(/(?:^|,)(?:format|f)=([^,]+)/i)?.[1]?.toLowerCase();
  const hasQuality = /(?:^|,)(?:quality|q)=/i.test(opts);
  return {
    explicitFormat: fmt && fmt !== 'auto' ? fmt : null,
    missingQuality: !hasQuality,
  };
}

// Did the transform actually RUN?
//
// A `/cdn-cgi/image/` URL is a *request* for Cloudflare to transform something.
// Whether it did is only visible in the response, and the difference is not
// subtle — measured 2026-09-03 against a real site:
//
//   /cdn-cgi/image/width=800,format=auto,quality=80/…/hero-coastal.webp
//     200, content-type: image/webp, content-length: 71366
//     cf-resized: internal=ok/m q=0 n=372+145 c=22+37 v=2026.9.0 l=71366 …
//   the same file with the prefix removed
//     200, content-type: image/webp, content-length: 258874, NO cf-resized
//
// So `cf-resized` is the signal, and its absence on a 200 means the bytes came
// through untransformed. Transformations are a PER-ZONE toggle that has to be
// switched on (dashboard → Images → Transformations → pick the zone), so a site
// can emit perfectly-shaped transform URLs and serve none of them — which is
// exactly what this cannot be allowed to report as ✅.
//
// On failure the header carries `err=<code>` instead, and the codes are
// documented and actionable:
// https://developers.cloudflare.com/images/reference/troubleshooting/
export const CF_RESIZE_ERRORS = {
  9401: 'the transform options are missing or invalid',
  9403: 'a request loop — the Worker fetched its own URL, or the image path overlaps the Worker path',
  9404: 'the source image does not exist on the origin, or the URL is wrong',
  9406: 'the source URL is non-HTTPS, or has spaces or unescaped Unicode',
  9408: 'the origin returned 4xx and may be denying access to the image',
  9412: 'the origin returned a non-image — usually an HTML error or login page',
  9413: 'the image is over the 100-megapixel limit',
  9420: 'the origin redirected to an invalid URL',
  9422: 'the usage limit was reached — over 5,000 unique transformations needs an Images paid plan',
  9520: 'the image format is not supported',
  9523: 'the resizing service could not resize it — usually an invalid image format',
  9524: 'the resizing service could not resize it — a Worker intercepted the image, or this is a pages.dev URL (use a custom domain)',
};

/**
 * What a response says about whether Cloudflare transformed it.
 *
 * `{ transformed: true }`                    — cf-resized present, no error
 * `{ transformed: false, why }`              — it did not, and why in one line
 *
 * `headers` is a Headers (or anything with .get). Callers only ask this of URLs
 * that are already known to be transform URLs.
 */
export function transformApplied(headers, contentType = '') {
  const cf = headers?.get?.('cf-resized') ?? null;
  if (cf == null) {
    return { transformed: false, why: 'the response carries no cf-resized header, so Cloudflare did not transform it — the original bytes were served' };
  }
  const code = cf.match(/\berr=(\d+)/)?.[1] ?? null;
  if (code) {
    const known = CF_RESIZE_ERRORS[code];
    return { transformed: false, why: `cf-resized reports err=${code}${known ? ` — ${known}` : ''}` };
  }
  if (contentType && !/^image\//i.test(contentType)) {
    return { transformed: false, why: `served as ${contentType}, which is not an image` };
  }
  return { transformed: true };
}
