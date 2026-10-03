// analytics — measured privately, and measured at all.
//
// The baseline's default is **Cloudflare Web Analytics**: free, cookieless, no
// consent banner to build or maintain, one script tag. Cloudflare Zaraz stays
// fully supported and is the right answer when you need a tag *manager* — GA
// plus other tools, gated by a Consent Management Platform — but it is a
// dashboard project, and requiring it meant a site measured nothing until
// someone finished configuring it.
//
// Two rules live here:
//
//   provider        what delivers analytics on this site. ADVISORY BY
//                   CONSTRUCTION — it only ever reports ✅/💡/⏭, never 🔧/🛑,
//                   in either mode. Whether a site measures anything at all is
//                   a business decision, not a defect the tool gets to assert.
//   no-hardcoded-ga a Google Analytics / GTM snippet pasted into the source.
//                   That one IS a finding: it fires before any consent gate.
//
// Offline can only ever be advisory about the *presence* of Cloudflare's
// beacon, and not because of the rule's severity: Cloudflare injects the beacon
// at the edge for proxied sites (automatic install is on by default), so a site
// that is correctly measured can have no trace of it in src/ or dist/. The live
// probe is the authoritative reader — see live.mjs.
//
// This check reads `code`, not raw text: comments are blanked first. A
// `{/* Cloudflare Web Analytics beacon */}` note above an unwired block would
// otherwise satisfy the positive check — the tool reporting *verified good*
// where nothing is emitted, which is the worst failure it has and the one this
// repo has now fixed three times.

import { readSrcFiles } from '../lib/src-scan.mjs';
import { eachDistHtml } from '../lib/html.mjs';
import {
  BEACON_SIGNALS, RUM_SIGNALS, ZARAZ_SIGNALS, GA_SIGNALS,
  matchSignals, hasSignal,
} from '../lib/analytics-signals.mjs';

const SEC = 'analytics';

// Markdown is prose: a post that *writes about* gtag() is not a site that ships
// it. `.html` is in, because a script tag in a static HTML file under src/ ships
// like any other.
const SCAN_EXTS = /\.(astro|tsx?|jsx?|html)$/;

export async function run({ project, reporter }) {
  const srcFiles = readSrcFiles(project.root, { exts: SCAN_EXTS });
  const distPages = [];
  if (project.hasDist) eachDistHtml(project.root, (rel, html) => distPages.push({ path: rel, code: html }));

  checkNoHardcodedGa(srcFiles, distPages, reporter);
  checkProvider(srcFiles, distPages, reporter);
}

// --- the finding: a snippet that fires outside any consent gate --------------

function checkNoHardcodedGa(srcFiles, distPages, reporter) {
  const scanned = srcFiles.length + distPages.length;
  const hits = [];
  const seen = new Set();
  for (const f of [...srcFiles, ...distPages]) {
    for (const label of matchSignals(f.code, GA_SIGNALS)) {
      const key = `${f.path}::${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ where: f.path, label });
    }
  }

  if (scanned === 0) {
    // A project with no scannable source and no dist/ used to report ✅ — a
    // clean bill of health for a scan that opened nothing.
    reporter.skip(SEC, 'no-hardcoded-ga', 'no scannable source files and no dist/ — nothing was read, so this is not a pass');
  } else if (hits.length === 0) {
    reporter.pass(SEC, 'no-hardcoded-ga', `no hardcoded Google Analytics / GTM snippet in ${scanned} file(s)`);
  } else {
    const sample = hits.slice(0, 3).map((h) => `${h.label} in ${h.where}`).join('; ');
    reporter.fix(
      SEC,
      'no-hardcoded-ga',
      `${hits.length} hardcoded analytics signal(s) — ${sample}${hits.length > 3 ? ' …' : ''}`,
      'a pasted GA/GTM snippet fires before the visitor agrees to anything. Either drop it for Cloudflare Web Analytics (cookieless, so no consent gate is needed), or deliver GA through Cloudflare Zaraz, whose CMP holds every tag until consent',
      { file: hits[0].where },
    );
  }
}

// --- the report: what delivers analytics here --------------------------------

const SUGGEST_WEB_ANALYTICS =
  'Cloudflare Web Analytics is the cheapest way to start measuring: free, cookieless (so no consent banner), one <script> in the root layout. For a proxied site the dashboard can inject it for you. Use Zaraz instead when you need a tag manager — GA plus other tools behind a consent CMP';

const ALL_CF_SIGNALS = [...BEACON_SIGNALS, ...RUM_SIGNALS, ...ZARAZ_SIGNALS];

function checkProvider(srcFiles, distPages, reporter) {
  const wiredInSrc = srcFiles.filter((f) => hasSignal(f.code, BEACON_SIGNALS));
  const zarazInSrc = srcFiles.some((f) => hasSignal(f.code, ZARAZ_SIGNALS));

  if (srcFiles.length === 0 && distPages.length === 0) {
    reporter.skip(SEC, 'provider', 'no scannable source files and no dist/ — nothing was read');
    return;
  }

  // Built output is the better evidence: it is what actually ships.
  if (distPages.length > 0) {
    const measured = distPages.filter((p) => hasSignal(p.code, ALL_CF_SIGNALS));
    if (measured.length === distPages.length) {
      reporter.pass(SEC, 'provider', `${matchSignals(measured[0].code, ALL_CF_SIGNALS).join(', ')} on all ${distPages.length} built page(s)`);
      return;
    }
    if (measured.length > 0) {
      const without = distPages.filter((p) => !measured.includes(p));
      reporter.suggest(
        SEC,
        'provider',
        `analytics on ${measured.length}/${distPages.length} built page(s) — missing from ${without.slice(0, 3).map((p) => p.path).join('; ')}${without.length > 3 ? ' …' : ''}`,
        'emit the beacon from the shared root layout so every page is measured, not just the ones that happen to use one layout',
      );
      return;
    }
    if (wiredInSrc.length > 0) {
      reporter.suggest(
        SEC,
        'provider',
        `the Cloudflare Web Analytics beacon is wired in ${wiredInSrc[0].path} but reaches none of the ${distPages.length} built page(s) — it sits behind a falsy token. That measures nothing unless Cloudflare's automatic setup injects the beacon at the edge (it does, Worker-served sites included), which is invisible here; --url settles it`,
        'use one install: leave the token unset if automatic setup is on, or set it (Cloudflare dashboard → Web Analytics → your site) and turn automatic setup off — both at once double-counts',
        { file: wiredInSrc[0].path },
      );
      return;
    }
    if (zarazInSrc) {
      reporter.suggest(SEC, 'provider', 'a Zaraz reference in src/ but no loader in any built page — Zaraz injects at the edge, so only --url can confirm it', 'run the audit again with --url against the deployed site (or a wrangler dev of dist/)');
      return;
    }
    reporter.suggest(
      SEC,
      'provider',
      `no analytics on any of the ${distPages.length} built page(s) — so this site measures nothing, unless Cloudflare injects the beacon at the edge (automatic install is on by default for proxied sites and is invisible here; --url settles it)`,
      SUGGEST_WEB_ANALYTICS,
    );
    return;
  }

  // No build to read. Source is a weaker signal, so say so rather than pass.
  if (wiredInSrc.length > 0) {
    reporter.suggest(SEC, 'provider', `Cloudflare Web Analytics beacon wired in ${wiredInSrc[0].path} — no dist/, so whether it actually renders (the token may be unset) is unverified`, 'build the site and re-run, or use --url', { file: wiredInSrc[0].path });
  } else if (zarazInSrc) {
    reporter.suggest(SEC, 'provider', 'a Zaraz reference in src/ — the loader is edge-injected, so only --url can confirm it', 'run the audit again with --url against the deployed site');
  } else {
    reporter.suggest(SEC, 'provider', `no analytics wiring in ${srcFiles.length} source file(s), and no dist/ to check what ships`, SUGGEST_WEB_ANALYTICS);
  }
}
