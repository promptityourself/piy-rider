// JSON-LD — read the structured data a page actually emits.
//
// Checking for the literal string "BlogPosting" in a helper file answered the
// wrong question twice over: it asked whether a *source file we named* mentions
// a type, not whether the shipped page carries one. Five independently built
// sites all emitted rich, valid JSON-LD and all five were told they had none —
// they wrote the helper somewhere else, or inlined it, or chose Article over
// BlogPosting. Parse the page instead.

// Schema.org types that mean "this page is an article". A site is not wrong for
// choosing Article, TechArticle or the CreativeWork superclass over BlogPosting;
// all of them earn the same rich results.
export const ARTICLE_TYPES = new Set([
  'Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle',
  'LiveBlogPosting', 'Report', 'CreativeWork',
]);

/**
 * Every JSON-LD object in an HTML document, flattened.
 *
 * Unwraps the two nestings publishers actually use — a top-level array of
 * objects, and the `@graph` container — so a type nested inside either is found.
 * A block that doesn't parse is skipped rather than failing the audit: the point
 * is to report what IS there, and `jsonld:parses` reports the broken ones.
 */
export function collectJsonLd(html) {
  const objects = [], broken = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { broken.push(raw.slice(0, 80)); continue; }
    for (const o of flatten(parsed)) objects.push(o);
  }
  return { objects, broken };
}

function flatten(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out; }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  if (node['@graph']) flatten(node['@graph'], out);
  return out;
}

/** Every @type in a set of JSON-LD objects (a node may declare several). */
export function ldTypes(objects) {
  const types = new Set();
  for (const o of objects) {
    const t = o['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.add(x);
  }
  return types;
}

/**
 * The Article types whose PROPERTIES are worth demanding — everything in
 * `ARTICLE_TYPES` except the `CreativeWork` superclass.
 *
 * `CreativeWork` earns its place in the presence check: a page that declares it
 * has said something about itself. It does not belong in the property check,
 * because it is the generic parent of almost every content type — a portfolio
 * piece, a case study, a photograph, a dataset description. Demanding a
 * `headline` and an `author` of one is the check assuming a blog post, which is
 * the same mistake `CONTENT_PAGE_TYPES` exists to stop it making.
 */
export const ARTICLE_PROPERTY_TYPES = new Set(
  [...ARTICLE_TYPES].filter((t) => t !== 'CreativeWork'),
);

export function hasArticleType(types) {
  for (const t of types) if (ARTICLE_TYPES.has(t)) return true;
  return false;
}

/**
 * Page types that describe a page's content without being articles.
 *
 * A glossary entry is a `DefinedTerm`; an FAQ is an `FAQPage`; a recipe is a
 * `Recipe`. Each is the *correct* markup for that page, and rewriting it as an
 * Article would make the page worse. Reporting one as a missing Article is the
 * check assuming every content page wants to be a blog post — reported by
 * matewishkey-web, whose `/glossary/*` pages were flagged while their project
 * and update pages carried BlogPosting all along.
 *
 * Deliberately excludes the generic wrappers — `WebPage`, `WebSite`,
 * `BreadcrumbList`, `Organization`, `SearchAction`. Those say nothing about what
 * the page *is*, so accepting them would turn this check into "has any JSON-LD",
 * which `jsonld:emitted` already answers.
 */
export const CONTENT_PAGE_TYPES = new Set([
  'DefinedTerm', 'DefinedTermSet', 'FAQPage', 'QAPage', 'HowTo', 'Recipe',
  'Event', 'Product', 'Course', 'JobPosting', 'VideoObject', 'PodcastEpisode',
  'SoftwareApplication', 'Book', 'Review', 'Dataset',
  // `Service` joined the "what this page offers" half of this list on
  // 2026-09-06 (issue #37, from a real audited site): a services page emitting
  // Service has said exactly what it is, and the check was telling it to become
  // an Article — advice that would make the page worse, at 🔧, failing the run.
  // `ProfessionalService` is deliberately NOT here: it is a LocalBusiness
  // subtype, so it is the site-wide business node rather than this page's own
  // type, which is the same reason Organization is excluded above.
  'Service',
]);

/**
 * How this page describes itself: an article, another legitimate content type,
 * or nothing that says what it is.
 *
 * Returns `{ kind: 'article' | 'content' | 'none', type }`.
 */
export function classifyPage(types) {
  for (const t of types) if (ARTICLE_TYPES.has(t)) return { kind: 'article', type: t };
  for (const t of types) if (CONTENT_PAGE_TYPES.has(t)) return { kind: 'content', type: t };
  return { kind: 'none', type: null };
}

// ---------------------------------------------------------------------------
// Property-level validation.
//
// `jsonld:emitted`, `jsonld:parses` and `jsonld:shapes` answer "is there
// structured data, does it parse, and does it declare the right @type". None of
// them looks *inside* the node. A BlogPosting with a bare-string author and a
// relative image URL passes all three and earns nothing: Google reads the type,
// finds the properties unusable, and drops the rich result silently. There is no
// error anywhere — the page looks marked up, in the source and in the audit.
//
// Everything asserted below is a documented Google requirement or an outright
// broken value, never a preference. Sources are on each function.

/** A node's @type as an array, however it was written. */
function typesOf(node) {
  const t = node?.['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x) => typeof x === 'string');
  return [];
}

/** Nodes whose @type is in `set`. */
export function nodesOfType(objects, set) {
  return objects.filter((o) => typesOf(o).some((t) => set.has(t)));
}

/**
 * Is this an absolute URL?
 *
 * A relative one is NOT broken, and an earlier draft of this check said it was.
 * JSON-LD 1.1 resolves relative IRIs against the base IRI, which for a block
 * embedded in HTML is the document's own location — so a compliant processor
 * reads `/og/default.png` exactly as intended (https://www.w3.org/TR/json-ld11/
 * § base IRI). Google documents no rule either way: grepping sd-policies,
 * intro-structured-data, article and breadcrumb for "absolute" and "relative
 * URL" returns nothing, and what IS documented is that image URLs must be
 * crawlable, which is a different property.
 *
 * So this is advice, not a verdict. Absolute values survive being syndicated,
 * copied into a feed, or read by anything that never saw the page they came
 * from; relative ones only work while the block sits on its original URL.
 * Google's own examples are absolute throughout.
 */
export function isAbsoluteUrl(v) {
  if (typeof v !== 'string' || !v) return false;
  try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; }
}

/**
 * ISO 8601, which is what Google documents for every date property.
 *
 * `new Date(x)` is far too forgiving to use alone — it accepts "January 5" and
 * a bare "2024" — so the shape is matched first and the value parsed second.
 * A date-only value (`2024-01-05`) is legal ISO 8601 and accepted; the offset is
 * recommended, not required, so its absence is not a finding here.
 */
export function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/.test(v)) return false;
  // An hour-only offset (`+13`) is legal ISO 8601 and `Date.parse` cannot read
  // it, so the shape is normalised before the value is parsed — without this the
  // second gate rejected a date the first had just accepted. The time component
  // has to be part of the match: anchoring on the offset alone rewrote the
  // date-only `2024-01-05` (whose `-05` looks exactly like one) into nonsense.
  const parseable = v.replace(/([T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$/, '$1$2:00');
  return !Number.isNaN(Date.parse(parseable));
}

/**
 * Author problems on one Article-family node.
 *
 * Google lists `author` as recommended (Article has no required properties),
 * and where it is present it must name a Person or an Organization — `"author": "Jane Doe"` is the common
 * shorthand and it is not usable, because a bare string cannot carry the @type
 * that disambiguates a person from a publisher.
 * https://developers.google.com/search/docs/appearance/structured-data/article
 */
export function authorProblems(node, graph = []) {
  const a = node.author;
  if (a === undefined || a === null) return ['no author'];
  const list = Array.isArray(a) ? a : [a];
  if (!list.length) return ['author is an empty array'];
  const out = [];
  for (const raw of list) {
    // A node REFERENCE — `"author": { "@id": "…#/schema/person/1" }` — is valid
    // JSON-LD and is what most graph emitters produce; the Person itself is a
    // sibling node in the same @graph. Judging the reference as if it were the
    // author reported two findings on the single most common shape in the wild,
    // and the suggested fix would have duplicated a node that already existed.
    // Resolve it; if the target is not on this page, say nothing rather than
    // guess — it may legitimately live elsewhere.
    const one = resolveRef(raw, graph);
    if (one === null) continue;
    if (typeof one === 'string') { out.push(`author is a bare string ("${one.slice(0, 40)}") — needs @type and name`); continue; }
    if (!one || typeof one !== 'object') { out.push('author is not an object'); continue; }
    const t = typesOf(one);
    if (!t.length) out.push('author has no @type (Person or Organization)');
    else if (!t.some((x) => x === 'Person' || x === 'Organization')) out.push(`author @type is ${t.join('/')} — Google reads Person or Organization`);
    if (typeof one.name !== 'string' || !one.name.trim()) out.push('author has no name');
  }
  return out;
}

/**
 * A value that is only an `@id` resolved against the flattened graph.
 *
 * Returns the referenced node, the value itself when it is not a reference, or
 * `null` when it is a reference this page does not contain.
 */
function resolveRef(value, graph) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== '@id') return value;
  return graph.find((n) => n && n['@id'] === value['@id']) ?? null;
}

/**
 * Date problems on one node. Only properties that are present are judged —
 * whether they must exist is `articleProblems`' question, not this one.
 */
export function dateProblems(node) {
  const out = [];
  for (const key of ['datePublished', 'dateModified']) {
    if (node[key] === undefined) continue;
    if (!isIsoDate(node[key])) out.push(`${key} is not ISO 8601 ("${String(node[key]).slice(0, 40)}")`);
  }
  return out;
}

/**
 * URL-valued properties that are present but not absolute.
 *
 * Only properties whose value is documented as a URL are examined, and only when
 * the value is a string — `image` and `publisher` are routinely objects
 * (ImageObject, Organization), which is correct and not a finding.
 */
// `@id` is deliberately absent: it is a node IDENTIFIER, not a URL property.
// Graph emitters name nodes with fragments (`#organization`) and blank-node ids
// (`_:b0`), neither of which can ever be an absolute URL, so including it
// produced one advisory line per node on exactly the sites that mark up best.
const URL_PROPS = ['url', 'image', 'logo', 'item', 'contentUrl', 'thumbnailUrl', 'sameAs'];
export function urlProblems(node) {
  const out = [];
  for (const key of URL_PROPS) {
    const v = node[key];
    if (v === undefined || v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      if (typeof one !== 'string') continue;      // an ImageObject/Organization — fine
      if (!isAbsoluteUrl(one)) out.push(`${key} is not an absolute URL ("${one.slice(0, 50)}")`);
    }
  }
  return out;
}

/**
 * The properties Google documents for the Article family.
 *
 * Google requires none of them ("There are no required properties", read
 * 2026-10-03). `author` and `headline` are the floor THIS TOOL holds an Article
 * to — `required` below means ours, not Google's; the rest each visibly change
 * the result — no `image` is no thumbnail, no `datePublished` is no date. They
 * are reported together because the fix is the same edit to the same builder,
 * and separated in the message so it is clear which half is which.
 * https://developers.google.com/search/docs/appearance/structured-data/article
 */
export function articleProblems(node) {
  const missing = { required: [], recommended: [] };
  if (node.author === undefined || node.author === null) missing.required.push('author');
  if (typeof node.headline !== 'string' || !node.headline.trim()) missing.required.push('headline');
  for (const key of ['image', 'datePublished']) {
    if (node[key] === undefined || node[key] === null || node[key] === '') missing.recommended.push(key);
  }
  return missing;
}

/**
 * BreadcrumbList problems.
 *
 * Positions must be integers running 1..n in order. `name` is required on every
 * item; `item` is required on every element *except the last*, where Google
 * defaults to the current page URL — flagging the last one is the mistake a
 * naive implementation of this check makes, and it would fire on Google's own
 * documented example.
 * https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
 */
export function breadcrumbProblems(node) {
  // A single value is legal JSON-LD for a one-element list; requiring an array
  // reported a correct one-item trail as empty.
  const raw = node.itemListElement;
  const items = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
  if (!items.length) return ['itemListElement is missing or empty'];
  const out = [];
  const positions = new Array(items.length).fill(null);
  items.forEach((li, i) => {
    const last = i === items.length - 1;
    if (!li || typeof li !== 'object') { out.push(`item ${i + 1} is not an object`); return; }
    const pos = typeof li.position === 'string' && /^\d+$/.test(li.position) ? Number(li.position) : li.position;
    if (!Number.isInteger(pos)) out.push(`item ${i + 1} has no integer position`);
    else positions[i] = pos;
    if (typeof li.name !== 'string' || !li.name.trim()) {
      // A `item` given as a Thing carries the name instead — legal, so only the
      // combination of no name AND no named Thing is a problem.
      const named = li.item && typeof li.item === 'object' && typeof li.item.name === 'string' && li.item.name.trim();
      if (!named) out.push(`item ${i + 1} has no name`);
    }
    if (!last && (li.item === undefined || li.item === null)) out.push(`item ${i + 1} has no item URL (only the last may omit it)`);
  });
  // Judge the sequence only when every item declared one. Collecting just the
  // integers and comparing against 1..count produced a second, factually wrong
  // message when a MIDDLE item had none ("positions are 1,3 — must run 1..2"),
  // and passed silently when the LAST one did, which is the case that matters.
  if (positions.every((p) => p !== null)) {
    const expected = positions.map((_, i) => i + 1).join(',');
    if (positions.join(',') !== expected) out.push(`positions are ${positions.join(',')} — must run 1..${items.length} in order`);
  }
  return out;
}

/**
 * Structured data that no longer earns anything.
 *
 * Three rich results were retired while the markup that requests them stayed
 * valid, so a site keeps emitting them and keeps believing they do something:
 *
 *   - `SearchAction` inside `WebSite` — the sitelinks searchbox, removed from
 *     results on 21 November 2024. (The rest of `WebSite` is still supported and
 *     still worth emitting; only the SearchAction is dead.)
 *   - `HowTo` — desktop How-to results ended 13 September 2023, docs removed the
 *     next day.
 *   - `FAQPage` — restricted to authoritative government and health sites in
 *     September 2023, then retired outright on 7 May 2026.
 *
 * Google is explicit that removing them is optional and that leaving them causes
 * no errors, which is exactly why this reports and never fails: the markup is
 * not wrong, it is just no longer paid for. Verified against the changelog at
 * https://developers.google.com/search/updates on 2026-09-02 — all three doc
 * pages now redirect to their removal entries.
 */
export function deprecatedShapes(objects) {
  const found = [];
  for (const o of objects) {
    const t = typesOf(o);
    if (t.includes('WebSite') && o.potentialAction) {
      const actions = Array.isArray(o.potentialAction) ? o.potentialAction : [o.potentialAction];
      if (actions.some((a) => typesOf(a).includes('SearchAction'))) {
        found.push('WebSite → SearchAction (sitelinks searchbox, retired 2024-11-21)');
      }
    }
    if (t.includes('HowTo')) found.push('HowTo (rich result retired 2023-09-13)');
    if (t.includes('FAQPage')) found.push('FAQPage (rich result retired 2026-05-07)');
  }
  return [...new Set(found)];
}
