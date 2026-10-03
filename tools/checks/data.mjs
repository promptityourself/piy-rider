// data — the machine-readable surface other tools consume: structured data
// (JSON-LD), an LLM-friendly index (/llms.txt), a feed (RSS), and a search index
// (Orama). Endpoints are matched by *pattern*, not fixed filenames, so the
// canonical single-locale and per-locale naming shapes both pass:
//   rss.xml.ts | rss-[locale].xml.ts | rss.en.xml.ts | feed.xml.ts
//   llms.txt.ts (+ llms-[locale].txt.ts) — pass if SOME endpoint is content-driven
//   search-index.json.ts | search-index-[locale].json.ts

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readSrcFiles, stripComments } from '../lib/src-scan.mjs';
import { eachDistHtml } from '../lib/html.mjs';
import { distFiles, readDist, countMatches, sitemapPages, distRelative } from '../lib/dist.mjs';
import {
  collectJsonLd, ldTypes, hasArticleType, ARTICLE_PROPERTY_TYPES, nodesOfType,
  articleProblems, authorProblems, dateProblems, urlProblems, breadcrumbProblems,
  deprecatedShapes,
} from '../lib/jsonld.mjs';
import { installedEngines, describeEngine } from '../lib/search-engines.mjs';
import { walkFiles } from '../lib/walk.mjs';

const SEC = 'data';

export async function run({ project, reporter }) {
  const pages = listPages(project.root);
  // Comment-blanked, like every other source grep in the tool. Raw text meant
  // `// TODO: build with getCollection(), filtering !draft && !previewOnly` in a
  // placeholder endpoint passed BOTH `llms.txt` (content-driven) and
  // `llms.txt:filter` — the tool reporting verified-good over a file that emits
  // a hardcoded string. checkContentSchema three functions down already did
  // this; these three reads were the ones left raw.
  const read = (rel) => {
    try { return stripComments(readFileSync(join(project.root, rel), 'utf8')); }
    catch { return ''; }
  };
  const contentDriven = (rel) => /getCollection\s*\(/.test(read(rel));
  // The baseline filter predicate is `!draft && !previewOnly` (the documented
  // invariant shared by llms/rss/search-index). Accept either form:
  //  - inline: a negated draft AND a negated previewOnly, allowing any dotted
  //    accessor before the field (e.g. `!p.data.draft`, `!entry.data.previewOnly`)
  //  - a shared publish predicate factored into a helper (e.g. `isPublished(data)`)
  // Returns WHICH form was found, not just that one was: a pass that names the
  // evidence is the difference between "checked and clean" and "never ran".
  const filterForm = (rel) => {
    const t = read(rel);
    const inline = /!\s*[\w.]*\bdraft\b/.test(t) && /!\s*[\w.]*\bpreviewOnly\b/.test(t);
    if (inline) return 'inline !draft && !previewOnly';
    // `.filter(isPublished)` passes the predicate by reference — the idiomatic
    // form, and the one the comment above already claims to accept.
    const helper = t.match(/\b(\w*[Pp]ublished)\s*[(,)\]]/) ?? t.match(/\bfilter\(\s*(\w*[Pp]ublished)\s*\)/);
    return helper ? `${helper[1]}() predicate` : null;
  };
  const hasFilter = (rel) => filterForm(rel) !== null;

  checkJsonLd(project, reporter);

  // /llms.txt — any llms*.txt endpoint; pass if SOME endpoint is content-driven.
  // (Multi-locale: root llms.txt is a thin index, llms-[locale].txt is the content one.)
  const llms = pages.filter((p) => /(^|\/)llms[-.a-z\[\]]*\.txt\.(ts|js)$/i.test(p));
  if (llms.length === 0) {
    reporter.fix(SEC, 'llms.txt', 'no src/pages/llms*.txt endpoint', 'add an llms.txt endpoint built from getCollection()');
  } else {
    const driven = llms.filter(contentDriven);
    if (driven.length === 0) reporter.fix(SEC, 'llms.txt', `endpoint(s) exist but none call getCollection() (${llms.map(short).join(', ')})`, 'build the index from getCollection() so it tracks published content');
    else reporter.pass(SEC, 'llms.txt', `content-driven (${driven.map(short).join(', ')})`);
    const filtered = driven.filter(hasFilter);
    if (filtered.length) reporter.pass(SEC, 'llms.txt:filter', `${filterForm(filtered[0])} in ${short(filtered[0])}`);
    else if (driven.length) reporter.fix(SEC, 'llms.txt:filter', 'no draft/preview filter on the content endpoint', 'exclude drafts/preview-only (!draft && !previewOnly)');
  }

  // RSS — the built feed is the artifact; the endpoint file is only how it got
  // there. Requiring getCollection() *in the endpoint* penalised the better
  // pattern of factoring the query into a shared helper.
  const rss = pages.filter((p) => /(^|\/)(rss|feed)[-.a-z\[\]]*\.xml\.(ts|js)$/i.test(p));
  const builtFeeds = project.hasDist ? distFiles(project.root, /(^|\/)(rss|feed|atom)[-.a-z0-9]*\.xml$/i) : [];
  if (builtFeeds.length) {
    const items = builtFeeds.reduce((n, f) => n + countMatches(readDist(project.root, f), /<(?:item|entry)\b/gi), 0);
    if (items > 0) reporter.pass(SEC, 'rss', `${items} item(s) in ${builtFeeds.length} built feed(s) (${builtFeeds.join(', ')})`);
    else reporter.fix(SEC, 'rss', `feed built but empty (${builtFeeds.join(', ')})`, 'the feed renders no items — check the collection query and the draft/preview filter');
  } else if (rss.length === 0) {
    reporter.fix(SEC, 'rss', `no rss/feed .xml endpoint${project.hasDist ? ' and no feed in dist/' : ''}`, 'add an RSS feed via @astrojs/rss built from getCollection()');
  } else if (project.hasDist) {
    reporter.fix(SEC, 'rss', `endpoint(s) exist but no feed in dist/ (${rss.map(short).join(', ')})`, 'the endpoint is not producing a feed — check it returns a Response and is not a draft route');
  } else if (rss.some((p) => /@astrojs\/rss|\brss\s*\(/.test(read(p)))) {
    reporter.pass(SEC, 'rss', `endpoint present (${rss.map(short).join(', ')}) — no dist/, so its output is unverified`);
  } else {
    reporter.fix(SEC, 'rss', `endpoint(s) exist but not via @astrojs/rss (${rss.map(short).join(', ')})`, 'build the feed with @astrojs/rss');
  }

  // Search — the index endpoint a client-side engine loads.
  //
  // Search is optional (see modules:search:engine), so a missing endpoint is
  // only a finding when the site actually ships a search library. That is the
  // coherence half of making search optional: dropping @orama/orama from the
  // baseline deps without this would mean nobody is ever told their search box
  // has nothing to search.
  const searchIdx = pages.filter((p) => /(^|\/)search-?index[-.a-z\[\]]*\.json\.(ts|js)$/i.test(p));
  const searchLibs = installedEngines(project.packageJson);
  // Only some engines read an index the SITE emits. Pagefind builds one from
  // dist/ at build time; Algolia, Meilisearch and Typesense host it. Demanding
  // a search-index endpoint of those is demanding a file they are designed not
  // to have — measured, it fired on a correct pagefind site and a correct
  // Algolia one.
  const needIndex = searchLibs.filter((e) => e.localIndex);
  if (searchIdx.length === 0 && searchLibs.length === 0) {
    reporter.skip(SEC, 'search:index', 'no search-index endpoint and no search library installed — search is optional, so there is nothing to check');
  } else if (searchIdx.length === 0 && needIndex.length === 0) {
    reporter.skip(SEC, 'search:index', `${searchLibs.map(describeEngine).join(', ')} builds or hosts its own index — a site using it is not expected to emit a search-index endpoint`);
  } else if (searchIdx.length === 0) {
    reporter.fix(SEC, 'search:index', `${needIndex.map(describeEngine).join(', ')} installed but no search-index*.json endpoint — the search UI has nothing to load`, 'add src/pages/search-index.json.ts (or per-locale) built from getCollection(), or drop the search dependency if the site has no search');
  } else if (searchIdx.some(contentDriven)) {
    reporter.pass(SEC, 'search:index', `Orama index source present (${searchIdx.map(short).join(', ')})`);
  } else {
    reporter.fix(SEC, 'search:index', `search-index endpoint(s) exist but none call getCollection() (${searchIdx.map(short).join(', ')})`, 'build the index from getCollection()');
  }

  checkContentSchema(project, reporter);
}

/**
 * Every collection is schema-validated, not just one of them.
 *
 * The old check was a whole-file `/z\.object\(/` on the raw text of
 * content.config.ts. Two collections where only one had a schema passed; so did
 * a file whose only mention of Zod was in a comment — the exact failure this
 * repo had already fixed for meta tags and then repeated here. All five dogfood
 * builds found it.
 */
function checkContentSchema(project, reporter) {
  if (!project.contentConfig) {
    reporter.fix(SEC, 'content:schema', 'no src/content.config.ts (or src/content/config.ts)', 'define your collections with a Zod schema so consumers get a validated, stable shape');
    return;
  }
  const code = stripComments(project.contentConfig);
  // `const blog = defineCollection({…})` and `{ blog: defineCollection({…}) }`
  // are both idiomatic; take the text up to the next definition as the body.
  const defs = [...code.matchAll(/(?:const\s+(\w+)\s*=|(\w+)\s*:)\s*defineCollection\s*\(/g)];
  if (defs.length === 0) {
    reporter.fix(SEC, 'content:schema', 'content.config.ts defines no collections (no defineCollection call outside comments)', 'define each collection with defineCollection({ loader, schema })', { file: 'src/content.config.ts' });
    return;
  }
  const unschemad = [];
  for (const [i, m] of defs.entries()) {
    const end = i + 1 < defs.length ? defs[i + 1].index : code.length;
    const body = code.slice(m.index, end);
    if (!/\bschema\s*:/.test(body)) unschemad.push(m[1] ?? m[2] ?? '(unnamed)');
  }
  if (unschemad.length === 0) {
    reporter.pass(SEC, 'content:schema', `${defs.length} collection(s), each with a schema`, { file: 'src/content.config.ts' });
  } else {
    reporter.fix(SEC, 'content:schema', `${unschemad.length}/${defs.length} collection(s) have no schema: ${unschemad.join(', ')}`, 'give every collection a Zod schema — an unvalidated one has no guaranteed shape for any consumer', { file: 'src/content.config.ts' });
  }
}

/**
 * Structured data, judged on what the pages emit.
 *
 * The old check required a file at `src/lib/jsonld.ts` containing the literal
 * strings "BlogPosting" and "WebSite". Sites that emit perfectly good JSON-LD
 * from a differently-named module, or inline, or using Article instead of
 * BlogPosting, were all told they had none. Read dist/ and parse it.
 */
function checkJsonLd(project, reporter) {
  if (!project.hasDist) {
    // No artifact to read: say what could not be checked rather than passing or
    // failing on a proxy. The source-side signal is still worth reporting.
    const ld = readSrcFiles(project.root).find((f) => /application\/ld\+json/.test(f.code));
    if (ld) reporter.pass(SEC, 'jsonld:emitted', `${ld.path} — no dist/, so the emitted shapes are unverified`);
    else reporter.fix(SEC, 'jsonld:emitted', 'no <script type="application/ld+json"> anywhere in src/', 'emit JSON-LD structured data from the component that renders <head>');
    reporter.skip(SEC, 'jsonld:shapes', 'no dist/ — build the site to check the JSON-LD it actually emits (Article-family + WebSite)');
    return;
  }

  // Judged over the pages the site declares in its sitemap, for the same reason
  // seo's coverage checks are: "every built page" counts OG templates.
  const declared = sitemapPages(project.root);
  const objects = [], broken = [], without = [], perPage = [];
  let pages = 0, pagesWithLd = 0;
  eachDistHtml(project.root, (rel, html) => {
    if (declared && !declared.has(distRelative(project.root, rel))) return;
    pages++;
    const found = collectJsonLd(html);
    if (found.objects.length) pagesWithLd++;
    else without.push(rel);
    objects.push(...found.objects);
    perPage.push({ rel, objects: found.objects });
    for (const b of found.broken) broken.push(`${rel}: ${b}`);
  });

  if (pages === 0) {
    reporter.skip(SEC, 'jsonld:emitted', 'dist/ has no HTML — nothing to read');
    reporter.skip(SEC, 'jsonld:shapes', 'dist/ has no HTML — nothing to read');
    return;
  }

  // "More than zero" was the bar: 1 page out of 19 reported ✅ and exit 0, with
  // the ratio printed but no threshold to read it against.
  const scope = declared ? 'sitemap page(s)' : 'built page(s)';
  if (pagesWithLd === 0) {
    reporter.fix(SEC, 'jsonld:emitted', `no JSON-LD on any of the ${pages} ${scope}`, 'emit JSON-LD structured data from the component that renders <head>');
  } else if (without.length) {
    reporter.suggest(SEC, 'jsonld:emitted', `${without.length}/${pages} ${scope} emit no JSON-LD — ${without.slice(0, 3).join('; ')}${without.length > 3 ? ' …' : ''}`, 'emit it from the shared head component so every published page carries it, not just some');
  } else {
    reporter.pass(SEC, 'jsonld:emitted', `on all ${pages} ${scope}`);
  }

  // Invalid JSON-LD is worse than none: search engines discard the block, but
  // nothing in the source hints that anything is wrong.
  if (broken.length) {
    reporter.fix(SEC, 'jsonld:parses', `${broken.length} JSON-LD block(s) are not valid JSON`, 'serialise with JSON.stringify and set:html — hand-written JSON-LD in a template usually breaks on quoting', { file: broken[0].split(':')[0] });
  }

  const types = ldTypes(objects);
  const article = hasArticleType(types);
  const site = types.has('WebSite');
  if (article && site) {
    reporter.pass(SEC, 'jsonld:shapes', `emitted: ${[...types].sort().join(', ')}`);
  } else {
    const missing = [!article ? 'an Article-family type (Article/BlogPosting/NewsArticle/TechArticle…)' : null, !site ? 'WebSite' : null].filter(Boolean).join(' and ');
    reporter.fix(SEC, 'jsonld:shapes', `dist/ emits ${types.size ? [...types].sort().join(', ') : 'no @type at all'} — missing ${missing}`, 'emit an Article-family shape per post and a site-wide WebSite shape');
  }

  checkJsonLdProperties(perPage, reporter);
}

function listPages(root) {
  const dir = join(root, 'src', 'pages');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const full of walkFiles(dir, { skip: (n) => n.startsWith('.') })) out.push(relative(root, full));
  return out;
}

function short(rel) { return rel.replace(/^src\/pages\//, ''); }

/**
 * What is *inside* the structured data, not just that it is there.
 *
 * `jsonld:shapes` reads the @type and stops. That is the whole gap this closes:
 * a BlogPosting whose author is a bare string, whose image is a relative path
 * and whose dates are `toLocaleDateString()` output declares itself perfectly
 * and earns nothing. Google reads the type, finds the properties unusable, and
 * drops the rich result — with no error, in the page or in an audit that only
 * counted types.
 *
 * Everything here is a documented Google requirement or a value that is broken
 * on its face. Presence of a breadcrumb is the one taste call, and it is the one
 * thing here that is house style.
 */
const BREADCRUMB = new Set(['BreadcrumbList']);

function checkJsonLdProperties(perPage, reporter) {
  // `ARTICLE_PROPERTY_TYPES`, not `ARTICLE_TYPES`: the presence check counts the
  // `CreativeWork` superclass as an article, which is right for "has this page
  // said what it is" and wrong for "does it carry a headline". `objects` is
  // carried through so the author check can resolve @id references against the
  // page's own graph, and so the breadcrumb lookup below needs no second scan.
  const articlePages = perPage
    .map((p) => ({ rel: p.rel, objects: p.objects, nodes: nodesOfType(p.objects, ARTICLE_PROPERTY_TYPES) }))
    .filter((p) => p.nodes.length);

  if (!articlePages.length) {
    const why = 'no Article-family node on any page — jsonld:shapes reports that';
    for (const name of ['jsonld:article-props', 'jsonld:author', 'jsonld:breadcrumb']) reporter.skip(SEC, name, why);
  } else {
    // --- the documented Article properties ---------------------------------
    const missingRequired = [], missingRecommended = [];
    for (const { rel, nodes } of articlePages) {
      for (const n of nodes) {
        const m = articleProblems(n);
        if (m.required.length) missingRequired.push(`${rel}: ${m.required.join(', ')}`);
        if (m.recommended.length) missingRecommended.push(`${rel}: ${m.recommended.join(', ')}`);
      }
    }
    if (missingRequired.length) {
      reporter.fix(SEC, 'jsonld:article-props', `${missingRequired.length} Article node(s) missing author or headline — ${sample(missingRequired)}`,
        'add author and headline to the Article builder — a node with neither has nothing to attribute and nothing to show',
        { file: missingRequired[0].split(':')[0] });
    } else if (missingRecommended.length) {
      reporter.suggest(SEC, 'jsonld:article-props', `${missingRecommended.length} Article node(s) missing a recommended property — ${sample(missingRecommended)}`,
        'add image and datePublished — no image is no thumbnail in the result, and no date is no date');
    } else {
      reporter.pass(SEC, 'jsonld:article-props', `author + headline + image + datePublished on all ${articlePages.length} Article page(s)`);
    }

    // --- author shape ------------------------------------------------------
    const authorBad = [];
    for (const { rel, objects, nodes } of articlePages) {
      for (const n of nodes) {
        if (n.author === undefined || n.author === null) continue;  // article-props' finding, not this one
        for (const p of authorProblems(n, objects)) authorBad.push(`${rel}: ${p}`);
      }
    }
    if (authorBad.length) {
      reporter.fix(SEC, 'jsonld:author', `${authorBad.length} author problem(s) — ${sample(authorBad)}`,
        'emit author as { "@type": "Person" | "Organization", name, url } — a bare string cannot say which it is',
        { file: authorBad[0].split(':')[0] });
    } else {
      reporter.pass(SEC, 'jsonld:author', 'every author is a typed Person or Organization with a name');
    }

    // --- breadcrumbs -------------------------------------------------------
    // Presence is house style: a breadcrumb earns a nicer result, and a flat
    // blog is not wrong for having no hierarchy to describe. Being *malformed*
    // is not house style — see below.
    const noCrumb = articlePages.filter((p) => !nodesOfType(p.objects, BREADCRUMB).length);
    if (noCrumb.length) {
      reporter.fix(SEC, 'jsonld:breadcrumb', `${noCrumb.length}/${articlePages.length} Article page(s) emit no BreadcrumbList — ${sample(noCrumb.map((p) => p.rel))}`,
        'emit a BreadcrumbList alongside the Article shape — it is what puts the trail, rather than the bare URL, in the result');
    } else {
      reporter.pass(SEC, 'jsonld:breadcrumb', `on all ${articlePages.length} Article page(s)`);
    }
  }

  // --- values that are broken wherever they appear --------------------------
  // Judged over every node on every page, not just Article ones: a relative
  // logo on an Organization is as dead as a relative image on a BlogPosting.
  //
  // Nothing to judge is NOT a pass. With no JSON-LD anywhere these three printed
  // "every URL value in the structured data is absolute" beside jsonld:emitted's
  // finding that there is none — a pass for work never done, which is the thing
  // CONTRIBUTING § "never let a check silently not run" forbids.
  const totalNodes = perPage.reduce((n, p) => n + p.objects.length, 0);
  if (totalNodes === 0) {
    const why = 'no JSON-LD on any built page — jsonld:emitted reports that';
    for (const name of ['jsonld:dates', 'jsonld:urls', 'jsonld:deprecated', 'jsonld:breadcrumb-shape']) reporter.skip(SEC, name, why);
    return;
  }

  const dateBad = [], urlBad = [], crumbBad = [];
  let crumbs = 0;
  for (const { rel, objects } of perPage) {
    for (const n of objects) {
      for (const p of dateProblems(n)) dateBad.push(`${rel}: ${p}`);
      for (const p of urlProblems(n)) urlBad.push(`${rel}: ${p}`);
    }
    for (const n of nodesOfType(objects, BREADCRUMB)) {
      crumbs++;
      for (const p of breadcrumbProblems(n)) crumbBad.push(`${rel}: ${p}`);
    }
  }

  if (dateBad.length) {
    reporter.fix(SEC, 'jsonld:dates', `${dateBad.length} date(s) are not ISO 8601 — ${sample(dateBad)}`,
      'emit dates with .toISOString() — a formatted date ("5 January 2024") is not a date to a parser',
      { file: dateBad[0].split(':')[0] });
  } else {
    reporter.pass(SEC, 'jsonld:dates', 'every datePublished/dateModified is ISO 8601');
  }

  // Advisory by construction. A relative IRI resolves against the document base
  // and works, so this is never a defect — it is a value that stops working the
  // moment the block leaves the page it was served on.
  if (urlBad.length) {
    reporter.suggest(SEC, 'jsonld:urls', `${urlBad.length} URL value(s) are relative — ${sample(urlBad)}`,
      'resolve them against the site URL — relative values are legal and resolve against the page, but only while the block stays on it');
  } else {
    reporter.pass(SEC, 'jsonld:urls', 'every URL value in the structured data is absolute');
  }

  // Markup for rich results Google has retired. Not wrong, just no longer paid
  // for — Google says leaving it causes no errors, so this never fails a run.
  const dead = [];
  for (const { rel, objects } of perPage) {
    for (const d of deprecatedShapes(objects)) dead.push(`${rel}: ${d}`);
  }
  if (dead.length) {
    const kinds = [...new Set(dead.map((d) => d.split(': ')[1]))];
    reporter.suggest(SEC, 'jsonld:deprecated', `${kinds.length} retired rich-result shape(s) still emitted — ${kinds.join('; ')}`,
      'drop them, or keep them knowingly — Google ignores unsupported structured data without error, so this costs bytes and maintenance rather than ranking');
  } else {
    reporter.pass(SEC, 'jsonld:deprecated', 'no retired rich-result shapes (SearchAction, HowTo, FAQPage)');
  }

  if (!crumbs) {
    reporter.skip(SEC, 'jsonld:breadcrumb-shape', 'no BreadcrumbList emitted — nothing to validate');
  } else if (crumbBad.length) {
    reporter.fix(SEC, 'jsonld:breadcrumb-shape', `${crumbBad.length} BreadcrumbList problem(s) — ${sample(crumbBad)}`,
      'positions must run 1..n in order and every item needs a name; only the last may omit its item URL',
      { file: crumbBad[0].split(':')[0] });
  } else {
    reporter.pass(SEC, 'jsonld:breadcrumb-shape', `${crumbs} BreadcrumbList(s) well formed`);
  }
}

/** First few of a list, with a count for the rest — the house message shape. */
function sample(list, n = 2) {
  return list.slice(0, n).join('; ') + (list.length > n ? ` … +${list.length - n} more` : '');
}
