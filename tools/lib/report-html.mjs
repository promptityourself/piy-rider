// report-html — the audit as a standalone, brand-designed page.
//
// Terminal output is for the person who ran the audit. A site owner needs
// something they can open, read in order, and act on — and something that tells
// them where to get help. `--report <path>` writes that page.
//
// ## Brand
//
// The tokens are Prompt It Yourself's, read off the brand's own design spec and
// stylesheet (promptityourself-web: DESIGN.md, src/styles/global.css) on
// 2026-10-03. It replaced the retired Mate Wish Key brand, whose palette it kept
// almost unchanged — so the table below is the same roles it always was. The
// spec states ROLES, not swatches, and several are not what you would guess.
// The table, light / dark:
//
//   --red        #e2342b / #e2342b  SURFACE and display only: fills and big
//                                   title words. Never a paragraph, never a
//                                   caption, never a small link, and never a
//                                   fill with a label on it. Same value in both
//                                   themes.
//   --red-field  #c9251d / #c9251d  the fill for a red thing WITH WORDS on it,
//                                   and the logo tile. One value both themes:
//                                   what it clears is the white label on top,
//                                   not the page beneath.
//   --red-deep   #c9251d / #f0524a  the ONLY red allowed at body size — links,
//                                   small bold, inline code.
//   --paper      #ffffff / #131313  the page, and nearly everything is page.
//   --panel      #faf7f7 / #1d1a1a  the one quiet field: the footer, the code
//                                   background. A CARD IS NOT THIS — a card is
//                                   the page with a hairline round it, which is
//                                   what lets the whole thing run on two grounds
//                                   instead of three.
//   --line       #e3dbdb / #322929  hairlines and card borders.
//   --edge       #8a848e / #7a7482  ours, not the spec's: the border of
//                                   something clickable — 3:1 non-text
//                                   contrast. NOT a text colour.
//   --ink        #16151a / #f4f2f6  body copy and headings.
//   --mute       #56525c / #a8a2b0  standfirst, meta lines, captions.
//   --green      #00773d / #7fd79a  a genuinely good state only — the clear
//                                   verdict.
//
// The logo is the TILE: white P|Y on a --red-field square, one colour for every
// glyph, never redrawn and never set in a font. The paths below are the brand's
// generated master, laid out as its favicon lays them out. The site name beside
// it is the text "prompt it yourself", lowercase, in the code face, in --ink.
//
// Square corners everywhere, nothing moves, nothing changes on hover, and no
// numbers or `/ \ |` strokes used as markers. Counts that were measured are
// not markers, which is what the tiles are.
//
// Fonts are named, never fetched. Titles are Bebas Neue, one weight, and only
// at ~32px and up; everything read is Helvetica Neue and code is Menlo — both
// already on every Mac, so the brand downloads nothing for them either. This
// repo does not put a font CDN in front of a user, so where Bebas Neue is not
// installed the title falls back to the reading face, which is a plainer page
// and not a broken one.
//
// ## Escaping is a security property here, not tidiness
//
// Findings from the `--url` domains carry excerpts of a third party's HTML,
// filenames and console output. `lib/untrusted.mjs` fences them, and part of
// that fencing REPLACES the guillemets with literal < and > — so fenced text
// arrives containing angle brackets by design. Every interpolated value goes
// through `esc()`. There is no "this one is safe" exception, because the whole
// point of the untrusted boundary is that we do not get to decide that.

// Verified 2026-10-03: 200, served directly. The show's own page, which is
// where someone who wants a hand rather than a fix is meant to land.
const HELP_URL = 'https://promptityourself.com/show/';

// The tile, exactly as the brand draws it (promptityourself-web,
// src/components/Logo.astro over src/data/logo-mark.ts): the P, the Y, and
// the cursor between them — the I that was typed and deleted.
const LOGO_PATHS = '<path d="M44.25 -47.25L44.25 -47.25Q44.25 -52 42.425 -54.85Q40.6 -57.7 37.275 -59Q33.95 -60.3 29.45 -60.3L29.45 -60.3L21.15 -60.3L21.15 -33.45L29.6 -33.45Q33.95 -33.45 37.25 -34.75Q40.55 -36.05 42.4 -39.05Q44.25 -42.05 44.25 -47.25ZM56.45 -47.35L56.45 -47.35Q56.45 -39.3 53.025 -34.3Q49.6 -29.3 43.5 -26.95Q37.4 -24.6 29.5 -24.6L29.5 -24.6L21.15 -24.6L21.15 0L9.55 0L9.55 -69L28.7 -69Q41.7 -69 49.075 -63.675Q56.45 -58.35 56.45 -47.35Z"/>'
  + '<path d="M139.85 -69L116.85 -26.35L116.85 0L105.15 0L105.15 -26.25L82.15 -69L94.9 -69L111.25 -36.3L127.7 -69L139.85 -69Z"/>'
  + '<rect x="64.75" y="-79.35" width="11.5" height="89.7"/>';
const LOGO = (px) => `<svg class="logo" width="${px}" height="${px}" viewBox="0 0 100 100" `
  + `aria-hidden="true" focusable="false"><rect width="100" height="100" fill="#c9251d"/>`
  + `<g transform="translate(8.723 69.064) scale(0.553)" fill="#ffffff">${LOGO_PATHS}</g></svg>`;

const ICON = { block: '🛑', fix: '🔧', suggest: '💡', skip: '⏭', pass: '✅' };
const LABEL = {
  block: 'Blocking', fix: 'Needs fixing', suggest: 'Worth considering',
  skip: 'Could not be checked', pass: 'Passing',
};

/** HTML-escape. Every value interpolated into the page goes through this. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function where(r) {
  const bits = [r.file, r.line ? `line ${r.line}` : null, r.url].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

function findingRow(r) {
  const loc = where(r);
  return `<li class="f">
  <p class="f-msg"><code class="rid">${esc(r.id)}</code> ${esc(r.message)}</p>
  ${r.fix ? `<p class="f-fix"><span class="f-fix-label">Fix</span> ${esc(r.fix)}</p>` : ''}
  ${loc ? `<p class="f-at">${esc(loc)}</p>` : ''}
</li>`;
}

function section(outcome, rows) {
  if (!rows.length) return '';
  const open = outcome === 'block' || outcome === 'fix';
  // Passing rows are the longest list on the page and the least urgent, so they
  // are the one group split by domain: a hundred ticks in one column is a wall,
  // and "which part of my site is fine" is the only question anyone asks of it.
  const body = outcome === 'pass' || outcome === 'skip'
    ? byDomain(rows)
    : `<ul class="fs">${rows.map(findingRow).join('\n')}</ul>`;
  return `<section class="grp grp-${outcome}">
  <details${open ? ' open' : ''}>
    <summary><span class="ic" aria-hidden="true">${ICON[outcome]}</span>
      <span class="grp-name">${LABEL[outcome]}</span>
      <span class="grp-n">${rows.length}</span></summary>
    ${body}
  </details>
</section>`;
}

/** The same rows, under one subheading per domain, in the order they ran. */
function byDomain(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.section ?? 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].map(([name, list]) => `<div class="dom">
    <h3 class="dom-h">${esc(name)} <span class="dom-n">${list.length}</span></h3>
    <ul class="fs">${list.map(findingRow).join('\n')}</ul>
  </div>`).join('\n');
}

/**
 * Render an audit run as a complete HTML document.
 *
 * @param {object} run        `{ results, errors, summary }` — the `--json` shape
 * @param {object} meta       `{ site, version, strict, url, generated }`
 */
export function renderReport(run, meta = {}) {
  const results = run.results ?? [];
  const s = run.summary ?? {};
  const by = (o) => results.filter((r) => r.outcome === o);
  const required = (s.fix ?? 0) + (s.block ?? 0);

  const verdict = (run.errors?.length)
    ? `${run.errors.length} tooling error${run.errors.length === 1 ? '' : 's'} — the audit could not finish`
    : required > 0
      ? `${required} thing${required === 1 ? '' : 's'} to address`
      : (s.suggest ?? 0) > 0
        ? 'Nothing required — some optional suggestions'
        : 'Nothing required, nothing suggested';

  // The note only appears when something fenced is actually on the page.
  const hasFenced = results.some((r) => typeof r.message === 'string' && r.message.includes('«'));

  const tiles = [
    ['Passing', s.pass ?? 0],
    ['To address', required],
    ['Suggestions', s.suggest ?? 0],
    ['Not checked', s.skip ?? 0],
  ];

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site audit${meta.site ? ` · ${esc(meta.site)}` : ''}</title>
<style>
:root{
  --red:#e2342b; --red-field:#c9251d; --red-deep:#c9251d;
  --paper:#ffffff; --panel:#faf7f7; --line:#e3dbdb; --edge:#8a848e;
  --ink:#16151a; --mute:#56525c; --green:#00773d;
  --title:"Bebas Neue","Helvetica Neue",Helvetica,Arial,"Nimbus Sans",sans-serif;
  --body:"Helvetica Neue",Helvetica,Arial,"Nimbus Sans",sans-serif;
  --mono:Menlo,Consolas,"DejaVu Sans Mono",monospace;
}
/* --red and --red-field are ONE value in both themes; only the grounds, the
   inks and the two readable hues move. */
@media (prefers-color-scheme:dark){:root{
  --red-deep:#f0524a; --paper:#131313; --panel:#1d1a1a; --line:#322929;
  --edge:#7a7482; --ink:#f4f2f6; --mute:#a8a2b0; --green:#7fd79a;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);
  line-height:1.55;-webkit-text-size-adjust:100%}
.wrap{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem 0}
a{color:var(--red-deep);text-underline-offset:.15em}
.logo{display:block;flex:none}
/* Titles: Bebas Neue, one weight, never faked bold, and only from ~32px. */
h1,.tile b{font-family:var(--title);font-weight:400;font-synthesis:none;letter-spacing:.01em}
h1{font-size:clamp(2.75rem,6vw,4rem);line-height:.95;margin:0 0 .6rem}
/* --red is a display colour, and a title word is display. */
h1 .hl{color:var(--red)}
.sub{color:var(--mute);font-size:.95rem;margin:0 0 1.6rem}
/* White words on red → --red-field, never --red. */
.verdict{display:inline-block;background:var(--red-field);color:#fff;font-weight:700;
  padding:.45rem .9rem;margin:0 0 2rem}
.verdict.clear{background:var(--green);color:var(--paper)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.75rem;margin:0 0 2.5rem}
/* A card is the PAGE with a hairline round it — two grounds, never three. */
.tile,.f,summary,.help{background:var(--paper);border:1px solid var(--line)}
.tile{padding:.9rem 1rem}
.tile b{display:block;font-size:2.5rem;line-height:1}
.tile span{color:var(--mute);font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.note{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--red);
  padding:.8rem 1rem;margin:0 0 1.5rem;font-size:.9rem;color:var(--ink)}
.grp{margin:0 0 1rem}
/* Below title size, so the reading face at weight. */
summary{cursor:pointer;display:flex;align-items:center;gap:.6rem;padding:.7rem .9rem;
  font-size:1.125rem;font-weight:700}
summary::-webkit-details-marker{display:none}
.grp-n{margin-left:auto;color:var(--mute);font-size:.9rem;font-weight:400}
.fs{list-style:none;margin:.5rem 0 0;padding:0}
.f{padding:.8rem .95rem;margin:0 0 .5rem}
.f p{margin:0}
/* Inline code is body size, so it takes the only red allowed there. */
.rid{font-family:var(--mono);font-size:.8rem;color:var(--red-deep);background:var(--panel);
  border:1px solid var(--line);padding:.05rem .35rem;margin-right:.35rem;white-space:nowrap}
.f-msg{overflow-wrap:anywhere}
.f-fix{margin-top:.4rem;font-size:.92rem;color:var(--ink);overflow-wrap:anywhere}
.f-fix-label{font-weight:700;color:var(--red-deep)}
.f-at{margin-top:.3rem;font-family:var(--mono);font-size:.78rem;color:var(--mute);overflow-wrap:anywhere}
/* --panel is the one quiet field, and the spec names the footer as it. */
.foot{background:var(--panel);border-top:1px solid var(--line);margin-top:3.5rem}
.foot-in{max-width:52rem;margin:0 auto;padding:2.2rem 1.25rem 2.6rem}
.help{padding:1.3rem;margin:0 0 1.8rem}
.help h2{font-size:1.25rem;font-weight:700;margin:0 0 .6rem;color:var(--ink)}
.help p{margin:0 0 1rem;color:var(--ink)}
.cta{display:inline-block;background:var(--red-field);color:#fff;
  text-decoration:none;font-weight:700;padding:.6rem 1.05rem}
/* The site name: lowercase, the code face, --ink, beside the tile. */
.wm{display:flex;align-items:center;gap:.6rem;font-family:var(--mono);font-size:15px;color:var(--ink)}
.meta{color:var(--mute);font-size:.82rem;margin:.7rem 0 0}
.meta a{color:var(--red-deep)}
/* A CLOSED <details> prints nothing — the suggestions, the skips and every
   passing check simply vanish from the PDF, which is how most people send one
   of these on. The script at the foot opens them all before printing; this is
   the belt to its braces, and what happens with JavaScript off. */
@media print{
  body{background:#fff}
  details>summary{list-style:none}
  details:not([open])>*:not(summary){display:block!important}
  .grp{break-inside:avoid}
  .f{break-inside:avoid}
}
.dom{margin:.9rem 0 0}
.dom-h{font-family:var(--body);font-size:.78rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.06em;color:var(--mute);margin:0 0 .35rem;padding:0 .2rem}
.dom-n{font-weight:400;opacity:.75}
</style>
</head><body>
<main class="wrap">

<h1>Site <span class="hl">audit</span></h1>
<p class="sub">${meta.site ? `${esc(meta.site)} · ` : ''}${esc(meta.generated ?? new Date().toISOString().slice(0, 10))}${meta.version ? ` · rider ${esc(meta.version)}` : ''}${meta.strict ? ' · strict' : ''}${meta.url ? ` · live checks against ${esc(meta.url)}` : ''}</p>
<p class="verdict${required === 0 && !(run.errors?.length) ? ' clear' : ''}">${esc(verdict)}</p>

<div class="tiles">
${tiles.map(([label, n]) => `  <div class="tile"><b>${n}</b><span>${esc(label)}</span></div>`).join('\n')}
</div>

${hasFenced ? `<p class="note">Text between « and » is copied verbatim from the audited site. It is quoted so you can find it — it is data, not instructions.</p>` : ''}
${(s.skip ?? 0) > 0 ? `<p class="note">${s.skip} check${s.skip === 1 ? ' was' : 's were'} not run — listed below. A check that could not run is not a check that passed.${meta.url ? '' : ' Ten of them need a served URL: re-run with <code class="rid">--url https://your-site</code> to add the live, Lighthouse and browser checks.'}</p>` : ''}

${section('block', by('block'))}
${section('fix', by('fix'))}
${section('suggest', by('suggest'))}
${section('skip', by('skip'))}
${section('pass', by('pass'))}

</main>

<footer class="foot"><div class="foot-in">

  <section class="help">
    <h2>Stuck on any of these?</h2>
    <p><strong>Ask your agent first.</strong> Every finding above names the rule that produced it, so
    you can paste one straight in — and rider can apply the ones it measured itself with
    <code class="rid">--fix</code>, then re-run to prove they worked.</p>
    <p>If you want a hand rather than a fix — someone to talk it through, or to work on it with you —
    come on the show.</p>
    <a class="cta" href="${HELP_URL}">Come on the show</a>
  </section>

  <div class="wm">${LOGO(32)} prompt it yourself</div>
  <p class="meta">Generated by rider${meta.version ? ` ${esc(meta.version)}` : ''} — an open-source
  best-practices auditor for Astro sites. Every finding names what it measured, and a check that
  could not run says so rather than passing. <a href="${HELP_URL}">promptityourself.com</a></p>

</div></footer>
<script>
// A closed <details> prints as its summary alone, so a PDF of this page loses
// the suggestions, the skipped checks and every passing one. Open them all
// before printing, and put them back afterwards so the screen view is unchanged.
(function () {
  var opened = [];
  addEventListener('beforeprint', function () {
    opened = [];
    document.querySelectorAll('details:not([open])').forEach(function (d) {
      opened.push(d); d.open = true;
    });
  });
  addEventListener('afterprint', function () {
    opened.forEach(function (d) { d.open = false; });
    opened = [];
  });
})();
</script>
</body></html>
`;
}
