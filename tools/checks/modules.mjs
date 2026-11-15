// modules — the baseline Astro stack: version, integrations, and core config.
// Assumes the site is meant to be on the standard baseline and checks it's there
// and wired correctly (it does not try to set anything up).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BASELINE_SEARCH, installedEngines, describeEngine } from '../lib/search-engines.mjs';
import { stripComments } from '../lib/src-scan.mjs';
import { setJson } from '../lib/remedy.mjs';
import { walkFiles } from '../lib/walk.mjs';

// First-party adapters. The list is a convenience for naming what it found —
// `adapter:` in astro.config is what actually decides, so a third-party adapter
// counts too.
const KNOWN_ADAPTERS = [
  '@astrojs/cloudflare', '@astrojs/node', '@astrojs/vercel',
  '@astrojs/netlify', '@astrojs/deno',
];

const SEC = 'modules';

// Baseline integrations every managed site is expected to carry.
//
// astro-robots-txt is deliberately NOT here: what matters is that the build
// ships a robots.txt pointing at the sitemap, and a generated endpoint does that
// at least as well (see seo:robots, which reads dist/robots.txt).
//
// @orama/orama is deliberately NOT here either, as of the 2026-08-03 baseline
// shift. Search is now optional: most content sites are small enough that the
// browser's own find-in-page beats a bundled index, and requiring the dependency
// gave every searchless site a `dep:` finding for choosing not to have a
// feature. What still binds is coherence — see `search:engine` below and
// `data:search:index`, which fires when a search library ships with nothing to
// feed it.
export const BASELINE_DEPS = [
  '@astrojs/mdx',
  '@astrojs/sitemap',
  '@astrojs/rss',
  '@astrojs/check',
];

// The engine list lives in lib/search-engines.mjs — data:search:index reasons
// about the same set, and two lists is how they disagree.

// Experimental flags Astro 7 stabilized — still present under `experimental:`
// they are config errors, not no-ops. Each maps to its v7 home.
// (docs.astro.build/en/guides/upgrade-to/v7 — verified 2026-08-01)
const STABILIZED_EXPERIMENTAL = {
  logger:          'moved to top-level `logger`',
  cache:           'moved to top-level `cache`',
  routeRules:      'moved to top-level `routeRules`',
  queuedRendering: 'now the default — drop the flag',
  rustCompiler:    'now the only compiler — drop the flag',
  advancedRouting: 'on by default — drop the flag',
};

// `astro:transitions` internals removed in v7 — use the lifecycle event names.
const REMOVED_TRANSITION_APIS = [
  'TRANSITION_BEFORE_PREPARATION', 'TRANSITION_AFTER_PREPARATION',
  'TRANSITION_BEFORE_SWAP', 'TRANSITION_AFTER_SWAP', 'TRANSITION_PAGE_LOAD',
  'isTransitionBeforePreparationEvent', 'isTransitionBeforeSwapEvent',
  'createAnimationScope',
];

export async function run({ project, reporter }) {
  const pkg = project.packageJson;
  if (!pkg) {
    if (project.packageJsonMalformed) {
      reporter.block(SEC, 'package.json', 'present but not valid JSON — every dependency check is skipped', 'fix the JSON syntax (a trailing comma or comment will do it)');
    } else {
      reporter.block(SEC, 'package.json', 'missing at project root', 'create package.json');
    }
    return;
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // astro ^7+ (compare major.minor numerically so 7.10+ and 8+ pass)
  const astroVer = deps.astro;
  if (!astroVer) {
    reporter.block(SEC, 'astro:installed', 'not in dependencies', 'npm i astro@latest');
  } else if (!atLeast(astroVer, 7)) {
    // The guide is 333 pages and the two changes that actually break a site are
    // both silent. So the hint leads with the mechanical check that catches them
    // — reported by tasmanvisa-web, who got to "332 of 333 pages byte-identical,
    // and the one difference is a fix" with it.
    reporter.fix(SEC, 'astro:version', `${astroVer} (baseline is ^7+)`, 'npx @astrojs/upgrade — then walk docs.astro.build/en/guides/upgrade-to/v7 (Rust compiler, Sätteri markdown, Vite 8, compressHTML: "jsx"). Verify it mechanically rather than by reading: build on the old version, snapshot dist/, upgrade, rebuild, and diff the rendered visible text with tags stripped to EMPTY — not to a space, which masks exactly the compressHTML whitespace change');
  } else {
    reporter.pass(SEC, 'astro:version', astroVer);
  }

  // engines.node >= 22.12.0 — Astro 7's own engines floor
  const nodeEng = pkg.engines?.node;
  if (!atLeast(nodeEng, 22, 12)) {
    // A remedy: the floor is a constant this check already knows, and setting a
    // key in package.json needs no parser and no judgement.
    reporter.fix(SEC, 'engines.node', `${nodeEng ?? 'unset'} (need >= 22.12.0, Astro 7's floor)`, 'set "engines.node" to ">=22.12.0" in package.json',
      { remedy: setJson('package.json', ['engines', 'node'], '>=22.12.0') });
  } else {
    reporter.pass(SEC, 'engines.node', nodeEng);
  }

  // TypeScript major must stay within what @astrojs/check peers on (^5 || ^6).
  // TS 7 is published as `latest` but breaks `astro check` today.
  const tsVer = deps.typescript;
  if (tsVer && deps['@astrojs/check'] && majorOf(tsVer) >= 7) {
    reporter.fix(SEC, 'typescript:version', `${tsVer} — @astrojs/check peers on typescript ^5 || ^6, so \`astro check\` breaks on 7`, 'pin typescript to ^6 until @astrojs/check declares TS 7 support');
  } else if (tsVer) {
    reporter.pass(SEC, 'typescript:version', tsVer);
  }

  // Baseline integrations present
  for (const dep of BASELINE_DEPS) {
    // One rule ("a baseline integration is missing"), many packages — so the id
    // is fixed and the package stays in the name. Deriving it per package would
    // mint a new "rule" for every dependency we ever add.
    if (deps[dep]) reporter.pass(SEC, `dep:${dep}`, deps[dep], { id: 'modules/dep' });
    else           reporter.fix(SEC, `dep:${dep}`, 'not installed', `npm i ${dep}`, { id: 'modules/dep' });
  }

  // Search: optional, but coherent.
  //
  // This used to demand Orama and flag anything else. That is house style being
  // asserted as a defect — a site with Pagefind has search, and it works. What
  // is a genuine defect is *two* client-side search engines: two indexes to
  // build, two bundles to ship, and two different answers to the same query.
  //
  // So: none is fine, one is fine, two is a finding.
  const engines = installedEngines(pkg);
  if (engines.length === 0) {
    reporter.skip(SEC, 'search:engine', 'no search library installed — search is optional in the baseline, so there is nothing to check here (data:search:index checks that a site which HAS one also feeds it)');
  } else if (engines.length > 1) {
    reporter.fix(SEC, 'search:engine', `${engines.length} search engines installed: ${engines.map(describeEngine).join(', ')} — two indexes to build, two bundles to ship, and two answers to the same query`, `pick one and drop the rest (the baseline's is ${BASELINE_SEARCH}, but any single client-side engine is fine)`);
  } else if (engines[0].id === BASELINE_SEARCH) {
    reporter.pass(SEC, 'search:engine', 'Orama');
  } else {
    reporter.suggest(SEC, 'search:engine', `search is ${describeEngine(engines[0])}`, `a single client-side search engine is fine — the baseline happens to use ${BASELINE_SEARCH}, so only reach for it if you want the shared index-endpoint shape too`);
  }

  // MDX is required by the baseline — so it has to be USABLE, not just present.
  checkMdxReachable(project, deps, reporter);

  // --- on-demand rendering and the adapter it requires ------------------------
  //
  // "On demand" is NOT just output: 'server'. A static site with one
  // `export const prerender = false` route renders that route on demand too, and
  // that is the shape a contact form takes: the whole site prerendered, one API
  // endpoint live. Testing only for output:'server' missed it entirely — a
  // static build with a prerender=false page using <Image> renders on Workers,
  // where Sharp cannot run, which is the exact case adapter:cloudflare exists to
  // catch.
  const cfgCode = stripComments(project.astroConfig ?? '');
  const explicitServer = /output\s*:\s*['"]server['"]/.test(cfgCode);
  const prerenderFalse = await collectSrcFiles(project.root, /export\s+const\s+prerender\s*=\s*false/);
  const rendersOnDemand = explicitServer || prerenderFalse.length > 0;
  const onDemandReason = explicitServer
    ? "output: 'server'"
    : `${prerenderFalse.length} route(s) with prerender = false (${prerenderFalse.slice(0, 2).join(', ')})`;

  // Any adapter. Naming ours would be house style wearing a universal badge —
  // the build fails on Vercel, Netlify, Node and Deno for exactly the same
  // reason, and it is not this tool's business which host you picked.
  const installedAdapters = KNOWN_ADAPTERS.filter((d) => deps[d]);
  const configuresAdapter = /\badapter\s*:/.test(cfgCode);
  const hasAnyAdapter = installedAdapters.length > 0 || configuresAdapter;
  const adapterLabel = installedAdapters.join(', ') || 'an adapter declared in astro.config';

  if (!rendersOnDemand) {
    reporter.skip(SEC, 'adapter:on-demand', 'every route is prerendered — a static build needs no adapter');
  } else if (hasAnyAdapter) {
    reporter.pass(SEC, 'adapter:on-demand', `${onDemandReason}, backed by ${adapterLabel}`);
  } else {
    reporter.block(SEC, 'adapter:on-demand', `${onDemandReason}, but no adapter is installed — the build fails with "Cannot use \`prerender = false\` without an adapter"`, 'add the adapter for your host (@astrojs/cloudflare, @astrojs/node, @astrojs/vercel, @astrojs/netlify, @astrojs/deno …) and pass it as `adapter:` in astro.config, or prerender the route');
  }

  // @astrojs/cloudflare specifically: its image service is what backs <Image>
  // where Sharp cannot run. On a fully prerendered build <Image> is optimized at
  // build time by Sharp and emitted to dist/, so no adapter is needed or wanted.
  const usesImageComponent = await grepSrc(project.root, /<Image[\s/>]/);
  const hasCloudflare = !!deps['@astrojs/cloudflare'];
  if (!usesImageComponent) {
    reporter.pass(SEC, 'adapter:cloudflare', hasCloudflare ? 'present (no <Image> usage detected)' : 'absent, no <Image> usage');
  } else if (!rendersOnDemand) {
    reporter.pass(SEC, 'adapter:cloudflare', '<Image> optimized at build time by Sharp (fully prerendered) — no adapter needed');
  } else if (hasCloudflare) {
    reporter.pass(SEC, 'adapter:cloudflare', `present, backs runtime <Image> under on-demand rendering (${onDemandReason})`);
  } else if (hasAnyAdapter) {
    // Sharp runs fine on Node/Vercel/Netlify/Deno. Demanding the Cloudflare
    // adapter there would be house style asserted as a defect.
    reporter.pass(SEC, 'adapter:cloudflare', `not needed — this site renders on demand via ${adapterLabel}, not Workers`);
  } else {
    // No adapter at all is already a block on adapter:on-demand. Reporting the
    // same root cause twice is the noise this tool exists to avoid.
    reporter.skip(SEC, 'adapter:cloudflare', 'no adapter installed at all — see adapter:on-demand, which is the finding that matters here');
  }

  // The billing trap. @astrojs/cloudflare's `imageService` default changed from
  // 'compile' to 'cloudflare-binding' (Astro's Cloudflare adapter docs, verified
  // 2026-08-03), and that binding is "automatically provisioned upon deployment"
  // — a paid product. So adding the adapter for something unrelated (a contact
  // form, say) can silently opt a site into billing for image transforms it was
  // previously doing for free at build time. Being explicit costs one line.
  if (hasCloudflare && usesImageComponent) {
    if (/\bimageService\s*:/.test(cfgCode)) {
      reporter.pass(SEC, 'adapter:imageService', 'set explicitly');
    } else {
      reporter.suggest(
        SEC,
        'adapter:imageService',
        "@astrojs/cloudflare with <Image> and no explicit imageService — the default is 'cloudflare-binding', which provisions the paid Cloudflare Images binding on deploy",
        "set it deliberately: `cloudflare({ imageService: 'compile' })` keeps build-time Sharp optimization and costs nothing; 'cloudflare-binding' is the right choice only if you want runtime transforms and are happy to pay for them",
      );
    }
  }

  // astro.config assertions
  const cfg = project.astroConfig;
  if (!cfg) {
    reporter.block(SEC, 'astro.config', 'missing', 'create astro.config.mjs');
    return;
  }
  // `output` defaults to 'static' (Astro configuration reference, verified
  // 2026-08-02), so omitting it is correct — it was a required finding for
  // writing less config than necessary. Only an explicit 'server' is a
  // departure from the baseline, and even that is a legitimate choice.
  if (/output\s*:\s*['"]server['"]/.test(cfg)) {
    reporter.fix(SEC, 'output:static', "output: 'server' — the baseline is a fully static build", "set output: 'static' (or drop the option, since static is Astro's default) unless this site genuinely needs on-demand rendering");
  } else if (/output\s*:\s*['"]static['"]/.test(cfg)) {
    reporter.pass(SEC, 'output:static', 'explicit');
  } else {
    reporter.pass(SEC, 'output:static', "not set — static is Astro's default");
  }

  // --- Astro 7 migration residue -------------------------------------------
  // Things that were valid on 6 and are errors (or silently wrong) on 7.

  // Experimental flags v7 stabilized — still under `experimental:` they throw.
  const experimental = extractBlock(cfg, 'experimental');
  const stale = experimental
    ? Object.keys(STABILIZED_EXPERIMENTAL).filter((k) => new RegExp(`\\b${k}\\s*:`).test(experimental))
    : [];
  if (stale.length === 0) {
    reporter.pass(SEC, 'astro7:experimental', 'no stabilized flags left under experimental');
  } else {
    reporter.fix(
      SEC,
      'astro7:experimental',
      `experimental.${stale.join(', experimental.')} — stabilized in Astro 7`,
      stale.map((k) => `${k}: ${STABILIZED_EXPERIMENTAL[k]}`).join('; '),
    );
  }

  // Markdown: v7 renders with Sätteri and no longer installs @astrojs/markdown-remark.
  // The deprecated unified() options still work, but only with that package present.
  const md = extractBlock(cfg, 'markdown');
  const unifiedOpts = md
    ? ['remarkPlugins', 'rehypePlugins', 'remarkRehype'].filter((k) => new RegExp(`\\b${k}\\s*:`).test(md))
    : [];
  if (unifiedOpts.length === 0) {
    reporter.pass(SEC, 'astro7:markdown', 'no unified()-only markdown options (Sätteri default)');
  } else if (deps['@astrojs/markdown-remark']) {
    reporter.pass(SEC, 'astro7:markdown', `${unifiedOpts.join(', ')} backed by @astrojs/markdown-remark`);
  } else {
    reporter.fix(
      SEC,
      'astro7:markdown',
      `markdown.${unifiedOpts.join(', markdown.')} configured but @astrojs/markdown-remark is not installed (Astro 7 defaults to Sätteri and no longer ships it)`,
      'either port the plugins to Sätteri MDAST/HAST plugins, or npm i @astrojs/markdown-remark and set markdown.processor: unified()',
    );
  }

  // @astrojs/db was removed in v7 and is no longer maintained.
  if (deps['@astrojs/db']) {
    reporter.fix(SEC, 'astro7:db', '@astrojs/db installed — the package was removed in Astro 7', 'migrate to node:sqlite, Drizzle, or a hosted DB (Turso/Neon/PlanetScale) and drop the dep');
  } else {
    reporter.pass(SEC, 'astro7:db', 'not installed');
  }

  // astro:transitions internals removed in v7 — lifecycle event names replace them.
  const usedInternals = await collectSrc(
    project.root,
    new RegExp(`\\b(${REMOVED_TRANSITION_APIS.join('|')})\\b`, 'g'),
  );
  if (usedInternals.length === 0) {
    reporter.pass(SEC, 'astro7:transitions', 'no removed astro:transitions internals');
  } else {
    reporter.fix(
      SEC,
      'astro7:transitions',
      `removed astro:transitions API in use: ${usedInternals.join(', ')}`,
      "use the lifecycle event names directly ('astro:before-preparation', 'astro:after-swap', …)",
    );
  }

  // tsconfig strict
  if (project.tsconfig) {
    const ext = project.tsconfig.extends;
    const strict = typeof ext === 'string'
      ? ext.includes('astro/tsconfigs/strict')
      : Array.isArray(ext) && ext.some((e) => e.includes('astro/tsconfigs/strict'));
    if (strict) reporter.pass(SEC, 'tsconfig:strict', `tsconfig.json extends "${Array.isArray(ext) ? ext.join('", "') : ext}"`);
    // The remedy is attached only when `extends` is absent or is Astro's own
    // weaker base. Anything else — a monorepo's shared config, `strictest`,
    // an array — and rewriting the key would DELETE what the project extends,
    // which is a far worse outcome than the finding it set out to clear.
    else reporter.fix(SEC, 'tsconfig:strict', `extends "${ext ?? 'nothing'}"`, 'extend "astro/tsconfigs/strict" in tsconfig.json',
      (ext == null || ext === 'astro/tsconfigs/base')
        ? { remedy: setJson('tsconfig.json', ['extends'], 'astro/tsconfigs/strict') }
        : {});

    // Astro's own tsconfigs exclude dist/, but only relative to the config that
    // declares them — a project that sets its own `exclude` replaces that list
    // rather than adding to it, and `astro check` then type-checks the built
    // bundle. cypruspokerbrisbane got ~70 spurious warnings out of a built
    // chart.js this way, and 0/0/0 once dist was excluded again.
    const exclude = project.tsconfig.exclude;
    const excludesDist = Array.isArray(exclude) && exclude.some((e) => /(^|\/)dist(\/|$|\/\*)/.test(String(e)));
    if (!Array.isArray(exclude)) {
      reporter.pass(SEC, 'tsconfig:exclude-dist', 'no "exclude" of its own, so the one from astro/tsconfigs (which excludes dist) applies');
    } else if (excludesDist) {
      reporter.pass(SEC, 'tsconfig:exclude-dist', `"exclude": [${exclude.map((e) => `"${e}"`).join(', ')}]`);
    } else {
      // An array remedy MERGES — the project's own exclude entries are why this
      // finding exists, so replacing the list would be the same bug in reverse.
      reporter.fix(SEC, 'tsconfig:exclude-dist', `"exclude": [${exclude.map((e) => `"${e}"`).join(', ')}] replaces the one from astro/tsconfigs and does not cover dist — \`astro check\` type-checks the built bundle`, 'add "dist" to the exclude array',
        { remedy: setJson('tsconfig.json', ['exclude'], ['dist']) });
    }
  } else if (project.tsconfigMalformed) {
    // "missing" is the wrong word for a file that is there and unreadable, and
    // it sent a reporter looking for a gap that did not exist (#36). The
    // information was already computed in lib/project.mjs and thrown away —
    // nothing read `tsconfigMalformed` before this.
    reporter.fix(SEC, 'tsconfig:strict', 'tsconfig.json is present but could not be parsed, even as JSONC — so nothing below it could be checked either',
      'fix the syntax (an unclosed brace or a stray comma is usual); comments and trailing commas are legal here and are already handled');
  } else {
    reporter.fix(SEC, 'tsconfig:strict', 'tsconfig.json missing', 'create tsconfig.json extending astro/tsconfigs/strict');
  }

  // compressHTML: v7 changed the default from `true` to `"jsx"`, which strips
  // whitespace by JSX rules — including the newline between prose and an inline
  // element. Measured on astro@7.1.6: `operates the website\n<a>…</a>.` renders
  // as `operates the website<a>…</a>.` with the default, and keeps the space
  // with `compressHTML: true`. It builds clean, typechecks clean, and ships
  // visibly wrong text. tasmanvisa-web had it live on their privacy page.
  if (atLeast(deps.astro, 7) && cfg != null) {
    if (/\bcompressHTML\s*:/.test(cfg)) {
      reporter.pass(SEC, 'compressHTML', 'set explicitly in astro.config');
    } else {
      reporter.fix(SEC, 'compressHTML', 'unset, so Astro 7 uses its new default "jsx" — whitespace between an inline element and the text around it is stripped, so `the website\\n<a>x</a>.` ships as `the websitex.`', 'set compressHTML: true to restore the v6 HTML-aware behaviour, or leave it "jsx" deliberately and check every place prose meets an inline element');
    }
  }

  // <ClientRouter /> in the root layout (view transitions)
  const rootLayout = [
    'src/layouts/RootLayout.astro',
    'src/layouts/Layout.astro',
    'src/layouts/BaseLayout.astro',
  ].find((p) => existsSync(join(project.root, p)));
  if (rootLayout) {
    const txt = readFileSync(join(project.root, rootLayout), 'utf8');
    if (/<ClientRouter\s*\/?>/.test(txt)) reporter.pass(SEC, 'ClientRouter', rootLayout);
    else reporter.fix(SEC, 'ClientRouter', `not in ${rootLayout}`, 'insert <ClientRouter /> into the layout <head>');
  }

  check404Served(project, reporter);

  // Custom 404
  if (existsSync(join(project.root, 'src/pages/404.astro'))) {
    reporter.pass(SEC, '404:custom', 'src/pages/404.astro');
  } else {
    reporter.fix(SEC, '404:custom', 'src/pages/404.astro missing', 'create a branded 404 page');
  }

  // Fonts: Astro has a first-party fonts API (config `fonts:` + <Font> from
  // astro:assets) that self-hosts, generates fallback metrics to stop the swap
  // shifting layout, and emits preload links. A third-party font CDN costs an
  // extra connection on the critical path and leaks visitor IPs to that host.
  const fontCdn = await collectSrc(
    project.root,
    /(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net)/g,
  );
  const hasFontsConfig = /\bfonts\s*:\s*\[/.test(cfg);
  if (fontCdn.length > 0 && !hasFontsConfig) {
    reporter.fix(SEC, 'fonts', `webfonts loaded from ${fontCdn.join(', ')} — an extra connection on the critical path, and no fallback metrics (font swap shifts layout)`, "move to Astro's built-in fonts API: `fonts: [{ provider: fontProviders.google(), name: '…', cssVariable: '--font-…' }]` in astro.config, then <Font cssVariable=\"--font-…\" preload /> from astro:assets");
  } else if (hasFontsConfig) {
    reporter.pass(SEC, 'fonts', 'astro:fonts configured (self-hosted, with fallback metrics)');
  } else {
    reporter.skip(SEC, 'fonts', 'no third-party font CDN referenced in src/ — this check only looks for that; perf:font:* measures the fonts actually shipped in dist/');
  }

  checkIcons(project, deps, reporter);

  // image.remotePatterns includes the media domain (only checkable if og.config declares one)
  const mediaDomain = project.ogConfig?.mediaDomain ?? project.ogConfig?.brand?.mediaDomain;
  if (mediaDomain) {
    // EVERY regex metacharacter, not just the dot. `mediaDomain` is scraped out
    // of the audited project's own scripts/og.config.mjs, so it is attacker- (or
    // typo-) controlled: `cdn.example[` compiled to an unterminated character
    // class, threw out of run(), and audit.mjs reported "modules check crashed"
    // — taking all ~40 module checks with it. Same escape set as policy.mjs.
    const escaped = mediaDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Comments are stripped first: a commented-out remotePatterns block is not
    // configuration, and reading `cfg` raw let one pass.
    const code = stripComments(cfg);
    // Either the literal hostname, or a remotePatterns entry that reads it from
    // the brand config. The starter does the latter so the domain has exactly
    // one home; a check that demanded the literal would force a second copy that
    // create mode then has to keep in step. Both accessor forms count —
    // `hostname: mediaDomain` from a named import is as idiomatic as
    // `hostname: brandConfig.mediaDomain`, and requiring the dot reported the
    // bare one as missing while telling you to add what was already there.
    const derived = /remotePatterns[\s\S]{0,400}?hostname\s*:\s*(?:[\w$.]*\.)?mediaDomain\b/.test(code);
    if (new RegExp(escaped).test(code)) {
      reporter.pass(SEC, 'remotePatterns', mediaDomain);
    } else if (derived) {
      reporter.pass(SEC, 'remotePatterns', `${mediaDomain} — derived from og.config's mediaDomain in astro.config`);
    } else {
      reporter.fix(SEC, 'remotePatterns', `${mediaDomain} not in image.remotePatterns`, `add { protocol: 'https', hostname: '${mediaDomain}' } to image.remotePatterns`);
    }
  }
}

// Does a version/range string satisfy a minimum major(.minor)? Reads the first
// major.minor in the string (handles `^6.10.0`, `>=22`, `~6.3`, `24.x`) and
// compares numerically — so two-digit minors (6.10) and future majors (7+) pass.
function atLeast(range, minMajor, minMinor = 0) {
  if (!range) return false;
  // Non-numeric specifiers carry no version to compare (`latest`, `workspace:*`,
  // `catalog:`, a git URL). Treat them as satisfied rather than inventing a
  // failure — the tool can't know, and a false 🔧 is worse than a missed nudge.
  if (!/\d/.test(range)) return true;
  // An OR'd range passes if ANY branch does: `^6 || ^7` satisfies a 7 floor.
  return range.split('||').some((branch) => {
    const m = branch.match(/(\d+)(?:\.(\d+))?/);
    if (!m) return false;
    const major = Number(m[1]);
    // `22.x` / `7.*` — an unpinned minor can be anything at or above 0.
    const minorRaw = m[2];
    const minor = minorRaw == null ? (/^\s*[~^]?\d+\s*$|\.[x*]/.test(branch) ? Infinity : 0) : Number(minorRaw);
    return major > minMajor || (major === minMajor && minor >= minMinor);
  });
}

// Leading major of a version/range string (`^6.0.3` → 6, `>=22.12.0` → 22).
function majorOf(range) {
  const m = String(range ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Pull the body of a top-level `<key>: { … }` block out of a config source,
// brace-matched so nested objects don't truncate it. Returns null if absent.
// Text-level, like every other assertion here — the tool never imports a
// project's config (it may reference deps that aren't installed).
function extractBlock(src, key) {
  // Strip comments first: `// experimental: { rustCompiler: true }` left behind
  // after a migration is a note to self, not live config, and flagging it makes
  // the tool wrong exactly when someone is doing the upgrade it asks for.
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const open = src.search(new RegExp(`\\b${key}\\s*:\\s*\\{`));
  if (open === -1) return null;
  const start = src.indexOf('{', open);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return null;
}

async function grepSrc(root, regex) {
  const src = join(root, 'src');
  if (!existsSync(src)) return false;
  for (const file of walkSrc(src)) {
    try { if (regex.test(readFileSync(file, 'utf8'))) return true; }
    catch {}
  }
  return false;
}

// Project-relative paths of the src/ files whose code matches. Comments are
// blanked first: a commented-out `// export const prerender = false` is a note,
// not a route, and treating it as one would demand an adapter nobody needs.
async function collectSrcFiles(root, regex) {
  const src = join(root, 'src');
  if (!existsSync(src)) return [];
  const hits = [];
  for (const file of walkSrc(src)) {
    try {
      if (regex.test(stripComments(readFileSync(file, 'utf8')))) hits.push(relative(root, file));
    } catch {}
  }
  return hits;
}

// Every distinct capture of `regex` (global, one capture group) across src/.
async function collectSrc(root, regex) {
  const src = join(root, 'src');
  if (!existsSync(src)) return [];
  const hits = new Set();
  for (const file of walkSrc(src)) {
    let txt;
    try { txt = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(regex)) hits.add(m[1] ?? m[0]);
  }
  return [...hits];
}

function* walkSrc(src) {
  for (const full of walkFiles(src)) {
    if (/\.(astro|tsx?|jsx?|mdx?)$/.test(full)) yield full;
  }
}

/**
 * `@astrojs/mdx` installed, and a content loader that can actually load `.mdx`.
 *
 * Presence is cheap to assert and worth almost nothing next to coherence — the
 * same lesson as `modules: search:engine` ↔ `data: search:index`. A site can
 * install the integration, pass `modules: dep:@astrojs/mdx`, and declare
 * `glob({ pattern: '**\/*.md' })`, which can never match an `.mdx` file. The
 * post produces no page and no error.
 *
 * **Both example sites shipped exactly that until 2026-09-01**, so the audit
 * required the dependency of every site it ran on while its own reference sites
 * could not use it. Issue #29.
 *
 * A pattern that is not a string literal — a variable, a spread, a value built
 * at runtime — is reported as unread rather than guessed at. An unreadable
 * pattern is a missed finding; a guessed one is a wrong finding on a site that
 * is fine, and this tool spent 2026-09-01 learning which of those costs more.
 */
function checkMdxReachable(project, deps, reporter) {
  const SEC2 = 'modules';
  if (!deps['@astrojs/mdx']) {
    reporter.skip(SEC2, 'mdx:reachable', '@astrojs/mdx not installed — no integration whose reachability to check');
    return;
  }
  if (!project.contentConfig) {
    // data: content:schema already reports the missing config; saying it twice
    // in two domains is noise, not emphasis.
    reporter.skip(SEC2, 'mdx:reachable', 'no content.config.ts to read a loader pattern from — see data: content:schema');
    return;
  }
  const code = stripComments(project.contentConfig);
  const patterns = [...code.matchAll(/pattern\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1].trim());

  if (patterns.length === 0) {
    reporter.skip(SEC2, 'mdx:reachable', 'no glob pattern found in content.config.ts — a loader that takes none matches whatever it defaults to');
    return;
  }

  // Allows .mdx if it names mdx, or if its extension is an unrestricted
  // wildcard (`**\/*`, `**\/*.*`) that matches any suffix.
  const allowsMdx = (g) => /mdx/i.test(g) || /\*(\.\*)?$/.test(g);

  // Judged per PATTERN EXPRESSION, and the question is "can MDX be loaded
  // anywhere", not "does every collection take it".
  //
  // Two unions, and conflating them is a false positive on a correct site:
  // an ARRAY of globs is one loader matching any of them, so
  // `['**\/*.md', '**\/*.mdx']` admits MDX — flagging it because its first
  // element does not was this check's first bug. And a site with several
  // collections may quite reasonably let only one of them hold MDX; the
  // integration is usable either way. So: any readable pattern admitting .mdx
  // is a pass, and only a site where NONE can is a finding.
  const readable = [], unreadable = [];
  for (const raw of patterns) {
    const globs = [...raw.matchAll(/['"`]([^'"`]*)['"`]/g)].map((m) => m[1]);
    if (globs.length) readable.push(globs); else unreadable.push(raw);
  }
  const admitting = readable.filter((globs) => globs.some(allowsMdx));
  const flat = readable.flat();

  if (admitting.length > 0) {
    reporter.pass(SEC2, 'mdx:reachable', `@astrojs/mdx is installed and a loader admits .mdx (${admitting[0].join(', ')})`);
  } else if (unreadable.length > 0) {
    reporter.skip(SEC2, 'mdx:reachable', `no readable loader pattern admits .mdx, but ${unreadable.length} is not a literal (${unreadable.join(', ')}) — cannot tell without running the config, and a guess here would be a finding about a site that is fine`);
  } else if (flat.length === 0) {
    reporter.skip(SEC2, 'mdx:reachable', 'no readable glob pattern in content.config.ts — nothing to judge');
  } else {
    reporter.fix(SEC2, 'mdx:reachable', `@astrojs/mdx is installed and no loader pattern admits .mdx — ${flat.join(', ')}; an .mdx file produces no page and no error`,
      "widen a glob (pattern: '**/*.{md,mdx}') and strip either extension in generateId, or drop @astrojs/mdx if the site has no MDX",
      { file: 'src/content.config.ts' });
  }
}

/**
 * Icons are inline SVG, not a package and not a font.
 *
 * An icon package (astro-icon + an Iconify collection, react-icons, a
 * FontAwesome or Tabler bundle) is a dependency for a dozen paths, and its shape
 * invites importing a whole set. An icon FONT is worse: a webfont on the
 * critical path, a flash of missing glyphs, and every icon downloaded whether
 * the page uses it or not. The baseline is a `src/lib/icons.ts` of copied
 * bodies and one component that inlines them — the fixture went from a package
 * to seventeen inline glyphs in one change (issue #31, 2026-09-02).
 *
 * House style: a site is not broken for using a package, so 💡 by default and
 * 🔧 under --strict. The package list is names, so a site that vendors its own
 * SVGs is never flagged; the font check reads the CSS the build actually shipped.
 */
const ICON_PACKAGES = [
  /^astro-icon$/, /^@iconify(-json|-icons)?\//, /^react-icons$/, /^lucide(-[\w-]+)?$/, /^@lucide\//,
  /^@fortawesome\//, /^font-awesome$/, /^@tabler\/icons/, /^@phosphor-icons\//, /^@heroicons\//,
  /^@material-symbols\//, /^material-icons$/, /^bootstrap-icons$/, /^feather-icons$/,
];
const ICON_FONT_RE = /font-family\s*:\s*["']?\s*(Font ?Awesome|Material (Icons|Symbols)|icomoon|Glyphicons|bootstrap-icons|feather|IcoFont|Ionicons|fontello)/i;

function checkIcons(project, deps, reporter) {
  // Runtime dependencies only. A site that follows this baseline by inlining SVG
  // bodies but GENERATES `src/lib/icons.ts` with a tool at build time ships no
  // icon package at all, and reading devDependencies reported it anyway.
  void deps;
  const runtimeDeps = project.packageJson?.dependencies ?? {};
  const packages = Object.keys(runtimeDeps).filter((d) => ICON_PACKAGES.some((re) => re.test(d)));
  if (packages.length) {
    reporter.fix(SEC, 'icons', `icon package(s) in dependencies: ${packages.join(', ')}`, 'copy the bodies of the glyphs the pages actually use into src/lib/icons.ts and inline them through one component — no package, nothing on the critical path');
  } else {
    reporter.pass(SEC, 'icons', 'no icon package in dependencies');
  }

  // An icon font is only visible in the built CSS — it may come from a package
  // above, a CDN stylesheet, or a hand-written @font-face.
  const distDir = join(project.root, 'dist');
  if (!existsSync(distDir)) { reporter.skip(SEC, 'icons:font', 'no dist/ — build the site to check the shipped CSS for an icon font'); return; }
  const found = findInDist(distDir, /\.css$/, ICON_FONT_RE);
  if (found.hit) {
    reporter.fix(SEC, 'icons:font', `an icon font is declared in ${found.hit.file} (${found.hit.match})`, 'replace the font with inline SVG for the glyphs in use — a webfont on the critical path for icons costs a connection, a flash of missing glyphs, and every icon whether used or not');
  } else if (found.truncated) {
    reporter.skip(SEC, 'icons:font', 'too many stylesheets in dist/ to read within budget — this did not look at all of them, so it is not a pass');
  } else {
    reporter.pass(SEC, 'icons:font', 'no icon font in the built CSS');
  }
}

/**
 * First file under `dir` matching `nameRe` whose text matches `re`.
 *
 * `{ hit }` when found, `{ truncated: true }` when the budget ran out before the
 * walk finished, `{}` when it looked everywhere and found nothing. Those last
 * two used to be the same `null`, so on a large adapter build — where thousands
 * of `dist/_worker.js/` entries are visited first — the caller printed "no icon
 * font in the built CSS" for a walk that had never opened a stylesheet.
 *
 * The budget counts files it actually READS, not every directory entry it steps
 * over, so a big build no longer exhausts it before reaching the CSS.
 */
function findInDist(dir, nameRe, re, budget = { n: 400 }) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return {}; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      const r = findInDist(full, nameRe, re, budget);
      if (r.hit || r.truncated) return r;
      continue;
    }
    if (!nameRe.test(e.name)) continue;
    if (budget.n-- <= 0) return { truncated: true };
    let text; try { text = readFileSync(full, 'utf8'); } catch { continue; }
    const m = text.match(re);
    if (m) return { hit: { file: relative(dir, full), match: m[1] ?? m[0] } };
  }
  return {};
}

/**
 * A branded 404 that Cloudflare will never serve.
 *
 * `404:custom` asks whether `src/pages/404.astro` exists. On Workers Static
 * Assets — which Cloudflare now documents as the recommended way to deploy a
 * static site, replacing Pages for new projects — that is not the question. An
 * unmatched request is answered by the Worker if there is one, and otherwise by
 * a bare platform 404: the site's own `404.html` is not consulted unless
 * `assets.not_found_handling` says so. Verified against the Cloudflare docs on 2026-09-03:
 *
 *   "If no matching asset is found and a Worker script is present, the request
 *    will be processed by the Worker. If no Worker script is present, a 404 Not
 *    Found response is returned."
 *   "Setting assets.not_found_handling to 404-page overrides the default
 *    asset-serving behavior [and] Workers automatically serves the contents of
 *    the nearest 404.html file with a 404 Not Found HTTP status."
 *
 * So the baseline's own default shape — `output: 'static'`, no on-demand route,
 * therefore no adapter and no `main` — is exactly the shape where the 404 page
 * builds, ships in dist/, passes `404:custom`, and never renders for a visitor.
 *
 * Read comment-blanked: the starter's own wrangler.jsonc is heavily commented,
 * and a commented-out setting satisfying a check is a failure this repo has
 * fixed three times already. The comment syntax follows the FORMAT, which is
 * why the filename decides: TOML comments with `#` and the JS/JSONC stripper
 * leaves those alone, so `# main = "./dist/_worker.js/index.js"` in a
 * wrangler.toml reported a live Worker entrypoint for a site that has none.
 */
function check404Served(project, reporter) {
  if (!project.wranglerConfig) {
    reporter.skip(SEC, '404:served', 'no wrangler.jsonc/json/toml — nothing here says how a host answers an unmatched URL');
    return;
  }
  const isToml = /\.toml$/i.test(project.wranglerFile ?? '');
  const cfg = stripComments(project.wranglerConfig, { js: !isToml, hash: isToml });
  // A [assets] table in TOML or an "assets" key in JSONC; either way, static
  // assets are being served by the platform rather than by a Worker route.
  if (!/(^|\s|\[)"?assets"?\s*[:=\]]/m.test(cfg)) {
    reporter.skip(SEC, '404:served', 'the wrangler config declares no static-assets directory — not a Workers Static Assets deploy');
    return;
  }
  if (/(?:^|[\s,{])"?main"?\s*[:=]/m.test(cfg)) {
    reporter.pass(SEC, '404:served', 'a Worker entrypoint (`main`) answers unmatched URLs, so the 404 route renders through it');
    return;
  }
  // The key is quoted in JSONC (`"not_found_handling": …`) and bare in TOML, so
  // the closing quote has to be optional — without it this matched neither.
  if (/"?not_found_handling"?\s*[:=]\s*["']404-page["']/.test(cfg)) {
    reporter.pass(SEC, '404:served', 'assets.not_found_handling = "404-page" — an unmatched URL serves the built 404 page');
    return;
  }
  reporter.fix(SEC, '404:served',
    'static assets with no Worker `main` and no assets.not_found_handling — an unmatched URL gets a bare platform 404, never the site\'s own 404 page (which still builds, ships and passes 404:custom)',
    'set "not_found_handling": "404-page" under "assets" in the wrangler config',
    { file: project.wranglerFile ?? 'wrangler.jsonc' });
}
