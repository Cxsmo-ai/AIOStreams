import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const extensionsDir = path.join(root, 'src', 'extensions');

const GITHUB_RELEASE_BASE =
  'https://github.com/Viren070/AIOStreams/releases/download/seanime-extensions-latest';

function getExtensions() {
  const entries = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const key = entry.name;
      const extensionDir = path.join(extensionsDir, key);
      return {
        key,
        dir: extensionDir,
        entry: path.join(extensionDir, 'main.ts'),
        manifest: path.join(extensionDir, 'manifest.json'),
      };
    })
    .filter((ext) => fs.existsSync(ext.entry) && fs.existsSync(ext.manifest));

  if (entries.length === 0) {
    throw new Error('No buildable extensions found in src/extensions');
  }

  return entries;
}

function normalizeWinPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

// Seanime plugins re-evaluate the `$ui.register` callback (and `$app.onXxx`
// hook callbacks) as a stringified function inside fresh runtimes that have no
// access to the loader VM's top-level scope. esbuild bundles ES module imports
// as top-level definitions, so anything imported from `lib/` is invisible
// inside those callbacks at runtime.
//
// This rewriter takes the IIFE-formatted bundle, captures every statement
// between the IIFE opening and `function init() {`, and injects that block at
// the top of each stringified callback body so the imports come along for the
// ride. The duplicated definitions in the loader VM are dead code, but
// harmless — the loader only ever runs `init()`.
function inlineHelpersIntoStringifiedCallbacks(src, extKey) {
  const iifeMatch = src.match(/^"use strict";\s*\r?\n\(\(\) => \{\r?\n/);
  if (!iifeMatch) return src;
  const iifeEnd = iifeMatch.index + iifeMatch[0].length;

  const initMatch = src.match(/^  function init\(\) \{\r?\n/m);
  if (!initMatch) return src;
  const initStart = initMatch.index;

  const helpers = src.slice(iifeEnd, initStart);
  if (!helpers.trim()) return src;

  // Strip helpers from their original top-level location — they're dead code
  // there (the loader VM only ever calls `init()`) and removing them shrinks
  // the payload.
  const stripped = src.slice(0, iifeEnd) + src.slice(initStart);

  // Re-indent helpers from IIFE-body indent (2 spaces) to register-callback
  // body indent (6 spaces) by adding 4 spaces to each non-empty line.
  const reindented = helpers
    .split('\n')
    .map((line) => (line.length > 0 ? '    ' + line : line))
    .join('\n');

  const callbackOpenings =
    /\$ui\.register\(\s*\(([^)]*)\)\s*=>\s*\{\r?\n/g;

  let result = '';
  let cursor = 0;
  let injected = 0;

  let m;
  while ((m = callbackOpenings.exec(stripped)) !== null) {
    const insertPos = m.index + m[0].length;
    result += stripped.slice(cursor, insertPos);
    result += reindented;
    cursor = insertPos;
    injected += 1;
  }
  result += stripped.slice(cursor);

  if (injected === 0) {
    console.warn(
      `[inline-libs] ${extKey}: found 'function init' but no $ui.register callback — skipped`
    );
    return src;
  }

  console.log(
    `[inline-libs] ${extKey}: inlined ${helpers.length} bytes of helpers into ${injected} callback${injected === 1 ? '' : 's'}`
  );
  return result;
}

fs.rmSync(distDir, { recursive: true, force: true });

const extensions = getExtensions();

for (const ext of extensions) {
  const outFolder = path.join(distDir, ext.key);
  const outFile = path.join(outFolder, 'main.js');
  const outManifest = path.join(outFolder, 'manifest.json');

  fs.mkdirSync(outFolder, { recursive: true });

  await build({
    entryPoints: [ext.entry],
    bundle: true,
    outfile: outFile,
    platform: 'neutral',
    format: 'iife',
    target: ['es2020'],
    legalComments: 'none',
    charset: 'utf8',
    minify: false,
    logLevel: 'info',
  });

  const manifest = JSON.parse(fs.readFileSync(ext.manifest, 'utf8'));
  if (manifest.id !== ext.key) {
    throw new Error(
      `Extension folder name must match manifest.id. Found folder '${ext.key}' with manifest.id '${manifest.id}'`
    );
  }

  let payload = fs.readFileSync(outFile, 'utf8');
  const rewritten = inlineHelpersIntoStringifiedCallbacks(payload, ext.key);
  if (rewritten !== payload) {
    fs.writeFileSync(outFile, rewritten, 'utf8');
    payload = rewritten;
  }
  manifest.payloadURI = undefined;
  manifest.payload = payload;
  manifest.language = 'javascript';
  manifest.isDevelopment = false;
  manifest.manifestURI = `${GITHUB_RELEASE_BASE}/${ext.key}-manifest.json`;

  fs.writeFileSync(outManifest, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Built ${ext.key}: ${normalizeWinPath(outManifest)}`);
}

console.log('All extensions built.');
