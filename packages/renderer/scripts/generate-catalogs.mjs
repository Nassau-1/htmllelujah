import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedRoot = path.join(packageRoot, 'src', 'catalog', 'generated');
const checkOnly = process.argv.includes('--check');

const sourceContracts = Object.freeze({
  '@twemoji/svg': {
    version: '15.0.0',
    packageLicense: 'MIT',
    assetLicense: 'CC-BY-4.0',
    integrity:
      'sha512-ZSPef2B6nBaYnfgdTbAy4jgW95o7pi2xPGwGCU+WMTxo7J6B1lMPTWwSq/wTuiMq+N0khQ90CcvYp1wFoQpo/w==',
  },
  'circle-flags': {
    version: '2.8.3',
    packageLicense: 'MIT',
    assetLicense: 'MIT',
    integrity:
      'sha512-62gm4tY7evXzNdLP+nFOzxEtCagbY4nSnrPNn/yOWFAvApvOWCAvyqL+NeLN+nfhGOGc4L+oSgEheqM3XE5w7g==',
  },
  'emojibase-data': {
    version: '17.0.0',
    packageLicense: 'MIT',
    assetLicense: 'MIT',
    integrity:
      'sha512-Yvgb5AWoHViHV/gq1qr5ZAarcBip+B27/ZLRsUJkbgAEaLlZ/fof9g882LTpmEpyhBNEC0m2SEmItljHsTygjA==',
  },
});

const allowedSvgTags = new Set([
  'circle',
  'clipPath',
  'defs',
  'ellipse',
  'g',
  'mask',
  'path',
  'rect',
]);
const allowedSvgAttributes = new Set([
  'class',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'cx',
  'cy',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'height',
  'id',
  'mask',
  'opacity',
  'r',
  'rx',
  'ry',
  'stroke',
  'stroke-linecap',
  'stroke-miterlimit',
  'transform',
  'width',
  'x',
  'xml:space',
  'y',
]);
const groupNames = Object.freeze([
  'smileys-emotion',
  'people-body',
  'component',
  'animals-nature',
  'food-drink',
  'travel-places',
  'activities',
  'objects',
  'symbols',
  'flags',
]);

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalizeLineEndings = (value) => value.replaceAll('\r\n', '\n');

const resolvePackageRoot = (packageName) => {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = readJson(manifestPath);
  const contract = sourceContracts[packageName];
  if (manifest.version !== contract.version || manifest.license !== contract.packageLicense) {
    throw new Error(
      `${packageName} source contract mismatch: expected ${contract.version} / ${contract.packageLicense}.`,
    );
  }
  return path.dirname(manifestPath);
};

const listFiles = (directory, predicate) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, 'en'));

const hashFiles = (root, files) => {
  const hash = createHash('sha256');
  for (const filePath of files) {
    hash.update(path.relative(root, filePath).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
};

const prefixSvgIds = (markup, prefix) => {
  const identifiers = [...markup.matchAll(/\bid="([A-Za-z_][A-Za-z0-9_.:-]*)"/g)].map(
    (match) => match[1],
  );
  let result = markup;
  for (const identifier of new Set(identifiers)) {
    const replacement = `${prefix}-${identifier}`;
    result = result.replaceAll(`id="${identifier}"`, `id="${replacement}"`);
    result = result.replaceAll(`url(#${identifier})`, `url(#${replacement})`);
  }
  return result;
};

const parseTrustedSvg = (source, sourceName, identity) => {
  const normalized = normalizeLineEndings(source).trim();
  if (/<!DOCTYPE|<!--|<script|<style|<foreignObject|<image|<use|\son[a-z]+\s*=/i.test(normalized)) {
    throw new Error(`${sourceName} contains a forbidden SVG construct.`);
  }
  const root = normalized.match(/^<svg\b([^>]*)>([\s\S]*)<\/svg>$/);
  if (root === null) throw new Error(`${sourceName} is not one closed SVG root.`);
  const markup = root[2].replaceAll(' xmlns="http://www.w3.org/2000/svg"', '');
  if (!/\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(root[1])) {
    throw new Error(`${sourceName} does not use the SVG namespace.`);
  }
  if (/(?:https?|file|data|javascript):/i.test(markup)) {
    throw new Error(`${sourceName} contains an invalid namespace or external reference.`);
  }
  const viewBox = root[1].match(/\bviewBox="([^"]+)"/)?.[1];
  if (viewBox === undefined || !/^-?\d+(?:\.\d+)?(?: +-?\d+(?:\.\d+)?){3}$/.test(viewBox)) {
    throw new Error(`${sourceName} has an invalid viewBox.`);
  }
  for (const match of markup.matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/g)) {
    if (!allowedSvgTags.has(match[1])) {
      throw new Error(`${sourceName} contains unsupported <${match[1]}> markup.`);
    }
    for (const attribute of match[0].matchAll(/\s([A-Za-z_:][A-Za-z0-9:._-]*)=/g)) {
      if (!allowedSvgAttributes.has(attribute[1])) {
        throw new Error(`${sourceName} contains unsupported ${attribute[1]} SVG data.`);
      }
    }
  }
  if (/\burl\((?!#[A-Za-z_][A-Za-z0-9_.:-]*\))/i.test(markup)) {
    throw new Error(`${sourceName} contains a non-local SVG reference.`);
  }
  return [viewBox, prefixSvgIds(markup, `hl-${identity}`)];
};

const flattenEmojiData = (items) => {
  const flattened = [];
  const visit = (item, parent) => {
    const inheritedTags = Array.isArray(parent?.tags) ? parent.tags : [];
    const ownTags = Array.isArray(item.tags) ? item.tags : [];
    flattened.push({
      ...parent,
      ...item,
      tags: [...new Set([...inheritedTags, ...ownTags])],
      group: item.group ?? parent?.group,
      subgroup: item.subgroup ?? parent?.subgroup,
    });
    if (Array.isArray(item.skins)) {
      for (const skin of item.skins) visit(skin, item);
    }
  };
  for (const item of items) visit(item);
  return flattened;
};

const normalizeCodepointIdentity = (value) =>
  value
    .trim()
    .toLowerCase()
    .split('-')
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join('-');

const unicodeFromCodepointIdentity = (identity) =>
  String.fromCodePoint(...identity.split('-').map((part) => Number.parseInt(part, 16)));

const flagHexcode = (countryCode) =>
  [...countryCode.toUpperCase()]
    .map((character) => (0x1f1e6 + character.charCodeAt(0) - 65).toString(16))
    .join('-');

const cleanFlagLabel = (label, fallback) =>
  typeof label === 'string'
    ? label.replace(/^(?:flag|drapeau)\s*:\s*/i, '').trim() || fallback
    : fallback;

const generatedBanner = (sources) =>
  `/* Generated by scripts/generate-catalogs.mjs. Do not edit by hand.\n * Sources: ${sources}.\n */\n`;

const makeAssetModule = (exportName, entries, sources) => {
  const rows = entries
    .map(
      ([name, [viewBox, markup]]) =>
        `  ${JSON.stringify(name)}: [${JSON.stringify(viewBox)}, ${JSON.stringify(markup)}],`,
    )
    .join('\n');
  return `${generatedBanner(sources)}export const ${exportName}: Readonly<Record<string, readonly [viewBox: string, markup: string]>> = Object.freeze({\n${rows}\n});\n`;
};

const makeCatalogModule = (exportName, entries, sources) => {
  const rows = entries.map((entry) => `  ${JSON.stringify(entry)},`).join('\n');
  return `${generatedBanner(sources)}export const ${exportName}: readonly (readonly [iconName: string, label: string, localizedLabel: string, category: string, unicode: string, keywords: readonly string[]])[] = Object.freeze([\n${rows}\n]);\n`;
};

const twemojiRoot = resolvePackageRoot('@twemoji/svg');
const circleFlagsRoot = resolvePackageRoot('circle-flags');
const emojibaseRoot = resolvePackageRoot('emojibase-data');
const twemojiFiles = listFiles(twemojiRoot, (name) => /^[0-9a-f-]+\.svg$/i.test(name));
const circleFlagFiles = listFiles(path.join(circleFlagsRoot, 'flags'), (name) =>
  /^[a-z]{2}\.svg$/.test(name),
);
const englishEmoji = flattenEmojiData(readJson(path.join(emojibaseRoot, 'en', 'data.json')));
const frenchEmoji = flattenEmojiData(readJson(path.join(emojibaseRoot, 'fr', 'data.json')));
const englishByCodepoint = new Map(
  englishEmoji.map((entry) => [normalizeCodepointIdentity(entry.hexcode), entry]),
);
const frenchByCodepoint = new Map(
  frenchEmoji.map((entry) => [normalizeCodepointIdentity(entry.hexcode), entry]),
);

const twemojiAssets = [];
const twemojiCatalog = [];
for (const filePath of twemojiFiles) {
  const identity = path.basename(filePath, '.svg').toLowerCase();
  const english = englishByCodepoint.get(identity);
  const french = frenchByCodepoint.get(identity);
  const unicode = unicodeFromCodepointIdentity(identity);
  const label = english?.label ?? `Emoji ${unicode}`;
  const localizedLabel = french?.label ?? '';
  const category =
    Number.isInteger(english?.group) && groupNames[english.group] !== undefined
      ? groupNames[english.group]
      : 'other';
  const keywords = [
    identity,
    unicode,
    label,
    localizedLabel,
    ...(english?.tags ?? []),
    ...(french?.tags ?? []),
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim());
  twemojiAssets.push([
    identity,
    parseTrustedSvg(readFileSync(filePath, 'utf8'), filePath, `twemoji-${identity}`),
  ]);
  twemojiCatalog.push([
    identity,
    label,
    localizedLabel,
    category,
    unicode,
    [...new Set(keywords)],
    english?.order ?? Number.MAX_SAFE_INTEGER,
  ]);
}
twemojiCatalog.sort((left, right) => left[6] - right[6] || left[0].localeCompare(right[0], 'en'));

const circleFlagAssets = [];
const circleFlagCatalog = [];
for (const filePath of circleFlagFiles) {
  const countryCode = path.basename(filePath, '.svg').toLowerCase();
  const hexcode = flagHexcode(countryCode);
  const english = englishByCodepoint.get(hexcode);
  const french = frenchByCodepoint.get(hexcode);
  const label = cleanFlagLabel(english?.label, countryCode.toUpperCase());
  const localizedLabel = cleanFlagLabel(french?.label, '');
  const unicode = unicodeFromCodepointIdentity(hexcode);
  const keywords = [
    countryCode,
    countryCode.toUpperCase(),
    unicode,
    label,
    localizedLabel,
    ...(english?.tags ?? []),
    ...(french?.tags ?? []),
    'flag',
    'drapeau',
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim());
  circleFlagAssets.push([
    countryCode,
    parseTrustedSvg(readFileSync(filePath, 'utf8'), filePath, `flag-${countryCode}`),
  ]);
  circleFlagCatalog.push([
    countryCode,
    label,
    localizedLabel,
    'countries',
    unicode,
    [...new Set(keywords)],
  ]);
}
circleFlagCatalog.sort(
  (left, right) => left[1].localeCompare(right[1], 'en') || left[0].localeCompare(right[0], 'en'),
);

const sourceDescription = '@twemoji/svg@15.0.0, circle-flags@2.8.3, emojibase-data@17.0.0';
const outputs = new Map([
  [
    'twemoji-assets.ts',
    makeAssetModule('TWEMOJI_ASSET_DATA', twemojiAssets, '@twemoji/svg@15.0.0'),
  ],
  [
    'twemoji-catalog.ts',
    makeCatalogModule(
      'TWEMOJI_CATALOG_DATA',
      twemojiCatalog.map((entry) => entry.slice(0, 6)),
      sourceDescription,
    ),
  ],
  [
    'circle-flag-assets.ts',
    makeAssetModule('CIRCLE_FLAG_ASSET_DATA', circleFlagAssets, 'circle-flags@2.8.3'),
  ],
  [
    'circle-flag-catalog.ts',
    makeCatalogModule('CIRCLE_FLAG_CATALOG_DATA', circleFlagCatalog, sourceDescription),
  ],
]);

const manifest = {
  schemaVersion: 1,
  generatedBy: 'packages/renderer/scripts/generate-catalogs.mjs',
  sources: Object.entries(sourceContracts).map(([packageName, contract]) => ({
    package: packageName,
    ...contract,
    sourceTreeSha256:
      packageName === '@twemoji/svg'
        ? hashFiles(twemojiRoot, twemojiFiles)
        : packageName === 'circle-flags'
          ? hashFiles(path.join(circleFlagsRoot, 'flags'), circleFlagFiles)
          : sha256(
              [
                normalizeLineEndings(
                  readFileSync(path.join(emojibaseRoot, 'en', 'data.json'), 'utf8'),
                ),
                normalizeLineEndings(
                  readFileSync(path.join(emojibaseRoot, 'fr', 'data.json'), 'utf8'),
                ),
              ].join('\0'),
            ),
  })),
  catalogs: {
    twemoji: { count: twemojiCatalog.length },
    circleFlags: { count: circleFlagCatalog.length },
  },
  generatedFiles: Object.fromEntries(
    [...outputs].map(([fileName, contents]) => [fileName, { sha256: sha256(contents) }]),
  ),
};
outputs.set('catalog-integrity.json', `${JSON.stringify(manifest, null, 2)}\n`);

const mismatches = [];
for (const [fileName, contents] of outputs) {
  const outputPath = path.join(generatedRoot, fileName);
  if (checkOnly) {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== contents) {
      mismatches.push(fileName);
    }
  } else {
    mkdirSync(generatedRoot, { recursive: true });
    writeFileSync(outputPath, contents, 'utf8');
  }
}

if (mismatches.length > 0) {
  throw new Error(
    `Generated catalog integrity mismatch: ${mismatches.join(', ')}. Run pnpm --filter @htmllelujah/renderer catalogs:generate.`,
  );
}

process.stdout.write(
  `${checkOnly ? 'Verified' : 'Generated'} ${twemojiCatalog.length} Twemoji and ${circleFlagCatalog.length} circular flags from pinned offline sources.\n`,
);
