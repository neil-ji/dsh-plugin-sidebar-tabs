/**
 * Build the two entry points this plugin ships.
 *
 * There is no bundler here on purpose. The browser half is a single source file
 * written as a *fragment* that runs inside the client module loader's factory,
 * so building means wrapping it in that envelope and nothing else — the same
 * shape the shipped client packages use. The Host half's three media modules are
 * inlined into it the same way: each becomes an IIFE returning its own
 * definitions, destructured once by the Host body. That keeps `lib/` — which is
 * committed, because a git install runs no build step — self-contained, so a
 * partial checkout, a tarball, or an unpacked `files` list still loads.
 *
 *   src/host/client.js      + src/host/media-*.js -> lib/index.js  (ESM, loaded by Cordis)
 *   src/client.js                                 -> lib/client.js (window.__ModuleLoader__ envelope)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const checkOnly = process.argv.includes('--check');

const manifest = JSON.parse(read('package.json'));
const { name, version } = manifest;

/** The loader id must be the package name: the client resolves the module by it. */
const LOADER_ID = name;

/**
 * Host modules inlined into `lib/index.js`, in order, each as its own IIFE.
 * A module may not rely on a sibling: it declares exactly one implementation
 * closure, so its `export` keywords are the only thing standing between the
 * source and the bundle.
 */
const HOST_MODULES = ['media-token.js', 'media-range.js', 'media-types.js'];

/** Turn one Host module into an expression yielding its exported definitions. */
const inlineHostModule = (file) => {
  const source = read(`src/host/${file}`);
  const imports = [...source.matchAll(/^\s*import\s+(?:[\w$*{][^'"]*?from\s+)?['"]([^'"]+)['"]/gmu)].map((match) => match[1]);
  const escaping = imports.filter((specifier) => !specifier.startsWith('node:'));
  if (escaping.length > 0) {
    throw new Error(
      `src/host/${file} imports ${escaping.join(', ')}, which the inliner cannot carry.\n` +
        'An inlined Host module may import Node builtins (`node:…`) only; anything else belongs\n' +
        'in the Host body, which is a real module and is left alone.',
    );
  }
  if (!/^\s*export\b/mu.test(source)) {
    throw new Error(`src/host/${file} exports nothing, so inlining it would define nothing.`);
  }
  const body = source
    .replace(/^\s*import\s+[^;]*?['"][^'"]+['"];\s*$/gmu, '')
    .replace(/^export (?=(?:const|let|function|class)\b)/gmu, '');
  return `\n(() => {\n${body}\nreturn { ${exportedNames(source).join(', ')} };\n})()`;
};

/** Named exports one Host module declares, for the destructuring the bundle performs. */
function exportedNames(source) {
  const names = [];
  for (const match of source.matchAll(/^export (?:const|let|function|class) ([A-Za-z_$][\w$]*)/gmu)) names.push(match[1]);
  if (names.length === 0) throw new Error('an inlined Host module declared no named export');
  return names;
}

const hostBody = read('src/host/client.js');
const inlinedNames = HOST_MODULES.flatMap((file) => exportedNames(read(`src/host/${file}`)));
// One hoisted import block: a module's `import` statement is a module-level
// declaration, so it cannot stay where the IIFE put it. The bindings are in
// scope for every inlined body below, which is why only `node:` specifiers are
// admitted in the first place.
const hostImports = [
  ...new Set(
    HOST_MODULES.flatMap((file) => read(`src/host/${file}`).match(/^\s*import\s+[^;]*?['"][^'"]+['"];\s*$/gmu) ?? []).map((line) => line.trim()),
  ),
];
const host =
  `// The media modules below are inlined from src/host/; keep them import-free.\n` +
  `${hostImports.join('\n')}${hostImports.length > 0 ? '\n' : ''}` +
  `const { ${inlinedNames.join(', ')} } = Object.assign(\n` +
  HOST_MODULES.map((file) => `  {},${inlineHostModule(file)},`).join('\n') +
  `\n);\n` +
  hostBody;

const body = read('src/client.js');

// Guard the two ways a client bundle silently fails to compose.
//
// `dsh.client.inject` lists *dynamic* client bundle providers this bundle needs
// loaded first — the packages that own the Client Services it injects. It must
// NOT list the frozen platform base: composition rejects a declared request with
// no provider row, and a package that ships no `dsh.client` declaration (like
// the UI primitives, which are part of the base) has no row to point at. A wrong
// entry here means the plugin's bundle is never published at all, with no route
// and no error in the UI — so the build checks both directions.
const BASE_MODULES = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-store',
]);
const declared = new Set(manifest.dsh?.client?.inject ?? []);

const wrongfullyDeclared = [...declared].filter((spec) => BASE_MODULES.has(spec));
if (wrongfullyDeclared.length > 0) {
  throw new Error(
    `dsh.client.inject lists platform-base module(s): ${wrongfullyDeclared.join(', ')}\n` +
      'These ship inside the frozen client base and have no bundle row of their own, so the\n' +
      'composition stage rejects the request and the plugin never loads. Remove them; list only\n' +
      'the dynamic client packages that provide the services this bundle injects.',
  );
}

const required = new Set();
for (const match of body.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) required.add(match[1]);
const undeclared = [...required].filter((spec) => !declared.has(spec) && !BASE_MODULES.has(spec) && !spec.startsWith('.'));
if (undeclared.length > 0) {
  throw new Error(
    `src/client.js requires package(s) that are neither base modules nor declared in dsh.client.inject: ${undeclared.join(', ')}\n` +
      'Add them to package.json so the client loads them before this bundle.',
  );
}

// Parse the fragment the same way the browser will: as a function body.
try {
  // eslint-disable-next-line no-new-func
  new Function('require', `${body}\n;return typeof createPlugin === 'function';`);
} catch (error) {
  throw new Error(`src/client.js does not parse as a factory body: ${error.message}`);
}

/** Byte-identical output on every build, so HMR does not churn on no-op builds. */
const banner = (what, note = '') => `// Generated by tools/build.mjs from src/${what}. Do not edit by hand.${note}\n`;

const hostOut = `${banner('host/client.js', ' The src/host/media-*.js modules are inlined below.')}${host}`;
const clientOut =
  banner('client.js', ' Uses the existing authenticated DSH connection only.') +
  `window.__ModuleLoader__.load({id:${JSON.stringify(LOADER_ID)},factory:function(require){\n` +
  `'use strict';\n` +
  `${body}\n` +
  `return createPlugin();\n` +
  `}});\n`;

const writeIfChanged = (rel, contents) => {
  const target = path.join(root, rel);
  const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  if (previous === contents) return false;
  if (!checkOnly) fs.writeFileSync(target, contents);
  return true;
};

fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
const hostChanged = writeIfChanged('lib/index.js', hostOut);
const clientChanged = writeIfChanged('lib/client.js', clientOut);

const changed = [hostChanged && 'lib/index.js', clientChanged && 'lib/client.js'].filter(Boolean);

if (checkOnly && changed.length > 0) {
  // `lib/` is committed because a git install runs no build step, so a stale
  // bundle ships a plugin that silently differs from its source. CI must fail
  // on drift rather than merely reporting it.
  console.error(`stale: ${changed.join(', ')} ${changed.length === 1 ? 'does' : 'do'} not match src/. Run: npm run build`);
  process.exit(1);
}

console.log(
  checkOnly
    ? `check ok — v${version}, loader id ${LOADER_ID}, ${required.size} require(s) declared, outputs up to date`
    : `built v${version} — loader id ${LOADER_ID}${changed.length ? `, wrote ${changed.join(', ')}` : ', outputs already up to date'}`,
);
