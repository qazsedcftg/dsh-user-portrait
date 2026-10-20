/**
 * Guard the inlined icon geometry against the official product icon set.
 *
 * The panel copies its SVG path data instead of importing the primitives
 * package (that package cannot be required from a client plugin: its own
 * top-level imports are not platform seed words). A copy can drift or be
 * mistyped, so this check re-reads the installed primitives source and proves
 * every inlined glyph matches the official artwork exactly.
 */
import { readFile } from 'node:fs/promises';

import { CLIENT, PRIMITIVES, skip } from './_paths.mjs';

if (PRIMITIVES === undefined) skip('no DSH application found; set DSH_APP_ROOT to run the icon check');
const OFFICIAL = PRIMITIVES;

import { check, finish } from './_harness.mjs';

/** Glyph key in the panel -> artwork constant in the primitives source. */
const ARTWORK = {
  sparkle: 'IconSparkleArtwork',
  archive: 'IconArchiveOutlineArtwork',
  refresh: 'IconRefreshOutlineArtwork',
  settings: 'IconSettingsOutlineArtwork',
  search: 'IconSearchOutlineArtwork',
  trash: 'IconTrashOutlineArtwork',
  user: 'IconUserOutlineArtwork',
  plus: 'IconPlusOutlineArtwork',
  close: 'IconCloseOutlineArtwork',
  chevronUp: 'IconChevronUpOutlineArtwork',
};

const clientSource = await readFile(CLIENT, 'utf8');
const officialSource = await readFile(OFFICIAL, 'utf8');

/**
 * Slice one balanced `{...}` block starting at the first `{` at or after `from`,
 * skipping braces that appear inside single- or double-quoted strings.
 * @param text - source to search.
 * @param from - index to start scanning from.
 * @returns the inner text between the braces, or undefined.
 */
function balancedBlock(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) return undefined;
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== '') {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return undefined;
}

/** Every path `d` attribute inside one artwork constant, in declaration order. */
function officialPaths(constant) {
  const start = officialSource.indexOf(`const ${constant} = `);
  if (start === -1) return undefined;
  // The parameter list (`({ size = 16 })`) is also a braced block, so scan from
  // the arrow that ends it.
  const arrow = officialSource.indexOf('=>', start);
  if (arrow === -1) return undefined;
  return [...(balancedBlock(officialSource, arrow) ?? '').matchAll(/d:\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** The panel's inlined path list for one glyph key. */
function inlinedPaths(key) {
  const start = clientSource.indexOf(`      ${key}: {`);
  if (start === -1) return undefined;
  const body = balancedBlock(clientSource, start) ?? '';
  // Only the strings that look like SVG path data; the block also carries the
  // optional `miterlimit` literal.
  return [...body.matchAll(/'([^']*[A-Za-z][^']*)'/g)]
    .map((match) => match[1])
    .filter((value) => /^[Mm]/.test(value));
}

const glyphBlock = /const GLYPHS = \{([\s\S]*?)\n    \};/.exec(clientSource)?.[1] ?? '';
const declaredKeys = [...glyphBlock.matchAll(/^      ([A-Za-z]+): \{/gm)].map((match) => match[1]);
check('the panel declares its glyph set', declaredKeys.length >= 8, declaredKeys);
check(
  'every declared glyph has an official counterpart in this guard',
  declaredKeys.every((key) => ARTWORK[key] !== undefined),
  declaredKeys.filter((key) => ARTWORK[key] === undefined),
);

for (const [key, constant] of Object.entries(ARTWORK)) {
  const expected = officialPaths(constant);
  const actual = inlinedPaths(key);
  check(`the official artwork exists for "${constant}"`, Array.isArray(expected) && expected.length > 0, expected);
  check(
    `the inlined "${key}" glyph matches ${constant} exactly`,
    JSON.stringify(actual) === JSON.stringify(expected),
    { inlined: actual, official: expected },
  );
}

check(
  'the inline miterlimit matches the official settings glyph',
  /miterlimit: '10'/.test(glyphBlock) && /strokeMiterlimit: "10"/.test(officialSource),
);

finish('ICON GEOMETRY CHECK PASSED');
