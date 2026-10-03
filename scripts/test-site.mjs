#!/usr/bin/env node
/**
 * Deploy the starter to a public URL, and audit it there.
 *
 *   node scripts/test-site.mjs deploy
 *   node scripts/test-site.mjs audit [extra audit flags…]
 *
 * ## Why this exists
 *
 * The `lighthouse` domain calls PageSpeed Insights, and PSI fetches the URL from
 * Google's side. It can never reach `127.0.0.1`, so the gate's local serve gets a
 * 400 and the whole domain returns after one skip — and CI has no API key, so
 * there it takes the no-key branch instead. Nine payload-parsing rules had
 * therefore never run outside one manual check in August 2026, which is issue #30.
 *
 * A deployed copy is the only thing that exercises them. The first run against
 * this site immediately found a real defect the offline gate structurally cannot
 * see: the starter's homepage hero was the LCP element and was lazy-loaded.
 *
 * ## What it deploys
 *
 * `examples/starter`, copied verbatim and edited exactly the way create mode
 * edits it — four files, no more. Deriving it from the starter rather than
 * keeping a separate site is the point: the thing under test has to BE the
 * reference, or the measurement is of something else.
 *
 * This is ours, for testing. Nothing in the plugin asks a user to set one up.
 * It runs on the Cloudflare free tier. Redeploy after any change to the starter.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HOST = 'piy-rider-test1.promptityourself.com';
const WORKER = 'piy-rider-test1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STARTER = join(root, 'examples', 'starter');

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'audit') {
  const r = spawnSync(process.execPath, [join(root, 'tools', 'audit.mjs'), '--url', `https://${HOST}/`, ...rest],
    { cwd: STARTER, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (cmd !== 'deploy') {
  console.error('usage: node scripts/test-site.mjs deploy | audit [audit flags…]');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'rider-test-site-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// The starter's own .gitignore is the list of what not to copy, read rather than
// restated so the two cannot drift — the same rule create mode follows.
const ignored = readFileSync(join(STARTER, '.gitignore'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/\/$/, ''));
cpSync(STARTER, dir, {
  recursive: true,
  filter: (src) => !ignored.some((i) => src === join(STARTER, i) || src.startsWith(join(STARTER, i) + '/')),
});

const edit = (rel, pairs) => {
  const p = join(dir, rel);
  let s = readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error(`test-site: ${rel} no longer contains ${JSON.stringify(a.slice(0, 48))} — the starter changed; update this script`); process.exit(1); }
    s = s.replace(a, b);
  }
  writeFileSync(p, s);
};

edit('scripts/og.config.mjs', [
  ["siteName: 'Example Site'", "siteName: 'rider test site'"],
  ["siteUrl: 'https://example.com'", `siteUrl: 'https://${HOST}'`],
  ["tagline: 'A small site about something worth writing down.'", "tagline: 'A deployed copy of the rider starter, so the lighthouse domain has a public URL to measure.'"],
  ["authorUrl: 'https://example.com'", `authorUrl: 'https://${HOST}'`],
]);
edit('wrangler.jsonc', [
  ['"name": "rider-starter"', `"name": "${WORKER}"`],
  ['"compatibility_flags": ["nodejs_compat"],',
    `"compatibility_flags": ["nodejs_compat"],\n  "routes": [{ "pattern": "${HOST}", "custom_domain": true }],`],
]);
edit('public/logo.svg', [['aria-label="Example Site"', 'aria-label="rider test site"'], ['>Example Site</text>', '>rider test site</text>']]);
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
pkg.name = WORKER;
writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

for (const [label, args] of [['npm install', ['install', '--no-audit', '--no-fund']], ['npm run build', ['run', 'build']]]) {
  console.log(`test-site: ${label}…`);
  const r = spawnSync('npm', args, { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const r = spawnSync('npx', ['wrangler', 'deploy'], { cwd: dir, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`\ntest-site: https://${HOST}/\n  audit it: node scripts/test-site.mjs audit --strict`);
if (!existsSync(join(dir, 'dist'))) process.exit(1);
