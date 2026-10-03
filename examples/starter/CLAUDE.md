# This site — how it is built, and how to keep it that way

This file ships with the site. It is here so that anyone picking the project up
— you, a collaborator, an agent — makes the same choices the site was built on,
instead of a new set every time.

## New here? Start with these three files

1. **`scripts/og.config.mjs`** — the site's name, URL, tagline, contact address
   and analytics token. Editing this one file rebrands the whole site. Nothing
   else needs touching to make it yours.
2. **`src/layouts/RootLayout.astro`** — the shell every page renders inside:
   `<head>`, header, footer, the analytics beacon. If something appears on every
   page, it is here.
3. **`src/data/blog/hello-world.md`** — a post. Adding another markdown file
   next to it is the entire publishing workflow.

After that: `src/pages/` is one file per route, and `src/styles/global.css` is
the whole design system (rendered live at `/design`).

One more file worth knowing about: **`src/data/sources.json`** ships empty and
renders nothing. If any of this site's words came from someone else's work, name
the works there — `components/Sources.astro` renders a "Where this comes from"
block from it, in the layout, so every page carries the credit. The auditor fails
the build if that file names a work the built pages never mention.

## The rules this site is built on

**Prefer boring and readable over clever.** Someone will read this in a year with
no context, and that someone may be you. A plain `<form method="POST">` that
works with JavaScript disabled beats a clever fetch-and-render. Every file here
should be understandable on its own.

**Prefer Cloudflare.** Not out of loyalty — because using one platform for
hosting, mail, analytics and abuse protection means one account, one bill, one
set of docs, and no integrations to keep alive:

| Need | Use | Why |
|---|---|---|
| Hosting | Cloudflare Workers + Static Assets | The build output is files; the one dynamic route rides along |
| Contact form | Email Service (`send_email` binding) | Free to a verified address, and no API key to store |
| Analytics | Web Analytics | Free, cookieless — so no consent banner to build |
| Spam | Turnstile | When the honeypot stops being enough |
| Large media | R2 | If images outgrow the repo |

Reach outside this list when there is a real reason, and write the reason down.

**Static by default.** Every route is prerendered except
`src/pages/api/contact.ts`. That single `prerender = false` is the only reason
an adapter is installed. Before adding a second one, check whether the thing
genuinely has to run per-request — most things don't.

**Say what is true.** Don't add a tracking script "for later", don't put a fake
token in a config, don't claim the site is deployed before it is. An unset
`cloudflareAnalyticsToken` is honest; a made-up one looks configured and
measures nothing.

**No dependency without a reason you could defend.** Every package is a thing
that can break, need updating, or change hands. The site ships with seven, and
each one earns it.

## Operator steps — the things nobody can do from the code

Three tasks, once each. Until they are done the site works, the contact form
fails closed, and post photos live next to their posts instead of in a bucket.

1. **Cloudflare Web Analytics.** Dashboard → Web Analytics → add this site, copy
   the site token into `scripts/og.config.mjs`. Free, cookieless, no banner.
   Note that Cloudflare's *automatic* injection only rewrites proxied static
   responses — this site is served by a Worker, so the `<script>` in
   `RootLayout.astro` is how the beacon gets there. Auto-install will silently do
   nothing while still showing the site as set up.
2. **Cloudflare Email Service.** Onboard the sending domain, then verify the
   destination address in `wrangler.jsonc` → `send_email[0].destination_address`.
   Sending to a verified destination is free on any plan.
3. **A media bucket.** Photos in posts never enter git; they go to one R2 bucket
   behind a custom domain, and Cloudflare resizes them at the edge. Create the
   bucket and attach a subdomain of the site's own domain to it:
   ```bash
   npx wrangler r2 bucket create <site>-media
   npx wrangler r2 bucket domain add <site>-media --domain media.<your domain> --zone-id <zone id>
   ```
   then set `mediaBucket` and `mediaDomain` in `scripts/og.config.mjs`. From then
   on `npm run media -- <file> blog/<post id>/<name>.jpg` uploads a photo and
   prints the `cover:` block for its frontmatter. Until the bucket exists, a
   `cover:` that points at a file next to the post still works — Astro resizes
   it at build, which is fine for a few images and wrong for a library of them.
   `wrangler r2 object list <site>-media` is the inventory; there is no manifest.

## Working on it

```bash
npm run dev       # local dev server
npm run build     # build to dist/
npm run preview   # wrangler dev — the real Worker, with _headers applied
npm run check     # astro check (types)
npm run deploy    # build + wrangler deploy
```

`astro dev` and `astro preview` do **not** apply `public/_headers`, so cache
behaviour there tells you nothing. Judge it on `npm run preview` or the deployed
site.

## Before you ship a change

Run the auditor — `/piy-rider:audit` in Claude Code, or from a checkout of the
tool:

```bash
git clone --depth 1 https://github.com/promptityourself/piy-rider.git /tmp/piy-rider
node /tmp/piy-rider/tools/audit.mjs --strict
```

**`0 🔧 / 0 🛑` is the acceptance test.** The `💡` are to be read, not counted —
they are advisory, they never fail a run, and their number moves whenever a
house-style check lands, so a number written here would be wrong within the
week. On a freshly scaffolded site they should all be things you have not done
yet rather than things that are wrong:

- the analytics beacon reporting its token is unset (until step 1 above);
- the missing Twitter/X handles, yours to set or to leave — an invented handle
  credits a stranger's account;
- `/contact/thanks/` linked from nowhere, which is true and correct: it is
  reached by the form's redirect, not by a link.

Read any others on their merits. What each rule is and why lives in the tool:
`node /tmp/piy-rider/tools/audit.mjs --rules --json`.
