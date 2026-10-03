// fonts-config — the `fonts: [...]` entries declared in astro.config, read as
// TEXT (this tool never executes a project's code — see lib/project.mjs).
//
// The defaults below are read off the installed package rather than recalled:
// `astro/dist/assets/fonts/constants.js` in astro@7.1.6 declares
//   DEFAULTS = { weights: ['400'], styles: ['normal','italic'], subsets: ['latin'],
//                fallbacks: ['sans-serif'], optimizedFallbacks: true, formats: ['woff2'] }
// The one that costs bytes silently is `styles`: a family declared without it
// gets italic faces built and shipped whether or not anything renders italic.
import { configString } from './config-string.mjs';

export const FONT_DEFAULT_STYLES = ['normal', 'italic'];

/**
 * Every family in the config's `fonts:` array, as
 * { name, cssVariable, hasStyles, hasWeights, hasSubsets, local }.
 *
 * `local` is a family that names its own files — `fontProviders.local()`, whose
 * faces are `options.variants`, each with its own style. The styles/weights
 * defaults belong to the remote providers and never apply to one (#39).
 *
 * Returns [] when there is no fonts array — which is not the same as an empty
 * one, but no caller distinguishes them and both mean "nothing to judge".
 */
export function fontFamilies(configText) {
  if (!configText) return [];
  const start = configText.search(/\bfonts\s*:\s*\[/);
  if (start === -1) return [];
  const open = configText.indexOf('[', start);
  const block = balanced(configText, open, '[', ']');
  if (block == null) return [];

  const out = [];
  for (const entry of objectsIn(block)) {
    const name = configString(entry, 'name');
    const cssVariable = configString(entry, 'cssVariable');
    if (!name && !cssVariable) continue;
    out.push({
      name,
      cssVariable,
      hasStyles: /\bstyles\s*:/.test(entry),
      hasWeights: /\bweights\s*:/.test(entry),
      hasSubsets: /\bsubsets\s*:/.test(entry),
      local: /\bfontProviders\s*\.\s*local\s*\(/.test(entry) || /\bvariants\s*:/.test(entry),
    });
  }
  return out;
}

/** The substring from `open` to its matching close, exclusive of both. */
function balanced(text, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Top-level `{ … }` objects in an array body. */
function objectsIn(block) {
  const out = [];
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== '{') continue;
    const body = balanced(block, i, '{', '}');
    if (body == null) break;
    out.push(body);
    i += body.length + 1;
  }
  return out;
}
