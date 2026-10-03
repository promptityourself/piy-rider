// Edit this one file to brand the site.
//
// Everything below feeds the <head> meta, the JSON-LD, the design page and the
// media kit. Nothing else needs touching to make this site yours — which is the
// point: one file to change, not fourteen.

export const config = {
  // --- content media: an R2 bucket behind a custom domain --------------------
  // Photos in posts never enter git. They live in one R2 bucket per site,
  // served from `media.<your domain>`, and every page requests them through
  // Cloudflare's transform URL (/cdn-cgi/image/width=…,format=auto/…) so the
  // edge produces each size on demand and nothing is resized at build.
  //
  // Both null until the bucket exists (CLAUDE.md § Operator steps). Until then,
  // a post's `cover` is a local file under src/assets/ and Astro resizes it at
  // build — the right lane for a handful of chrome images, the wrong one for a
  // growing library of photos. `npm run media` moves a file to R2 and prints
  // the frontmatter to paste.
  mediaDomain: null,   // e.g. 'media.example.com' — the custom domain on the bucket
  mediaBucket: null,   // e.g. 'example-media'    — the R2 bucket name, for npm run media

  brand: {
    // --- who you are --------------------------------------------------------
    siteName: 'Example Site',
    siteUrl: 'https://example.com',
    tagline: 'A small site about something worth writing down.',

    // The address the contact form delivers to. This must be a *verified
    // destination* in Cloudflare Email Service — see CLAUDE.md § Operator steps.
    contactEmail: 'hello@example.com',

    // Optional, and they make richer social cards. Without authorName the
    // JSON-LD attributes posts to the site as an Organization, which is correct
    // — so leaving it is a choice, not an omission.
    authorName: 'Example',
    authorUrl: 'https://example.com',

    // Null, and not a placeholder, on purpose. A social card carrying an
    // invented handle credits whoever actually owns it on X — your posts,
    // someone else's account. No handle is strictly better than a wrong one,
    // and the audit will remind you with a 💡 until you set yours.
    twitterSite: null,
    twitterCreator: null,

    logoUrl: '/logo.svg',

    // --- Cloudflare Web Analytics ------------------------------------------
    // Free, cookieless, no consent banner. Paste the site token from
    // Cloudflare dashboard → Web Analytics → your site, and the beacon in
    // RootLayout.astro starts reporting.
    //
    // Null here on purpose: this is a reference site with no domain, and a
    // made-up token would look configured while measuring nothing. The audit
    // reports it as "wired but the token is unset", which is the truth.
    //
    // Pick ONE install. Automatic setup (the dashboard default) injects the
    // beacon at the edge, and it does rewrite a Worker-served site like this
    // one — measured 2026-10-03 on a Workers + Static Assets deploy, static and
    // on-demand routes and the 404 alike (#41). With it on, leave this null.
    // Set a token only with automatic setup OFF: both at once loads two
    // beacons and counts every visit twice.
    cloudflareAnalyticsToken: null,
  },
};
