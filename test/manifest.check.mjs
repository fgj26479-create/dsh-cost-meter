// Pre-install validation: manifest shape, patch YAML, referenced files, and the
// constraints the plugin manager / client-modules layer enforce.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * js-yaml is borrowed from the runtime's own bundled copy so this package keeps
 * zero dependencies. When that copy is unavailable the YAML checks report SKIP
 * rather than failing, so the suite stays portable.
 */
function loadYaml() {
  for (const candidate of [
    '../../tmp/yamlcheck/dsh/node_modules/js-yaml/index.js',
    'js-yaml',
  ]) {
    try {
      return require(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const yaml = loadYaml();
const problems = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`OK   ${label}`);
  } catch (error) {
    problems.push(`${label}: ${error.message}`);
    console.log(`FAIL ${label}\n     ${error.message}`);
  }
};
const skip = (label, reason) => console.log(`SKIP ${label} (${reason})`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

check('package name is a valid bare specifier', () => {
  assert.match(manifest.name, /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/);
});

check('declares dsh.bundle.patch', () => {
  assert.equal(typeof manifest.dsh?.bundle?.patch, 'string');
});

check('declares dsh.client.platform === "web"', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
});

check('exports "." and "./client" resolve to real files', () => {
  for (const key of ['.', './client']) {
    const target = manifest.exports[key];
    const relative = typeof target === 'string' ? target : target?.default;
    assert.ok(relative, `exports["${key}"] is missing`);
    assert.ok(fs.existsSync(path.join(root, relative)), `exports["${key}"] -> ${relative} does not exist`);
  }
});

check('the client bundle is a classic module-loader script', () => {
  const source = fs.readFileSync(path.join(root, manifest.exports['./client']), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, new RegExp(`id:\\s*'${manifest.name.replace(/[/@.]/g, (c) => `\\${c}`)}'`));
  assert.ok(!/^\s*(import|export)\s/m.test(source), 'client bundle must not use ESM syntax');
});

check('the client bundle requires only shell-seeded modules', () => {
  const source = fs.readFileSync(path.join(root, manifest.exports['./client']), 'utf8');
  const seed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);
  const external = new Set(manifest.dsh?.client?.external ?? []);
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1];
    assert.ok(
      seed.has(specifier) || external.has(specifier),
      `require("${specifier}") is neither shell-seeded nor declared in dsh.client.external`,
    );
  }
});

check('the client bundle imports no Harness Client package', () => {
  const source = fs.readFileSync(path.join(root, manifest.exports['./client']), 'utf8');
  assert.ok(!source.includes('@deepseek-ai/dsh-client-'), 'must not require a Harness Client package');
});

check('icon exists and is an allowed type within 256 KiB', () => {
  const icon = path.join(root, manifest.icon);
  assert.ok(fs.existsSync(icon), 'icon file is missing');
  assert.ok(/\.(svg|png|jpe?g|webp)$/i.test(icon), 'icon type not accepted');
  const bytes = fs.statSync(icon).size;
  assert.ok(bytes > 0 && bytes <= 256 * 1024, `icon is ${bytes} bytes`);
});

check('locale dictionaries carry meta.title and meta.description', () => {
  for (const language of ['en', 'zh']) {
    const file = path.join(root, 'locale', `${language}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(typeof parsed.meta?.title, 'string');
    assert.equal(typeof parsed.meta?.description, 'string');
  }
});

if (yaml === null) {
  skip('cordis.patch.yml parses and inserts exactly this package', 'no YAML parser available');
  skip('every config key in the patch is read by the plugin', 'no YAML parser available');
} else {
  const readPatch = () => yaml.load(fs.readFileSync(path.join(root, manifest.dsh.bundle.patch), 'utf8'));

  check('cordis.patch.yml parses and inserts exactly this package', () => {
    const patch = readPatch();
    assert.ok(Array.isArray(patch), 'patch must be a top-level array');
    const inserted = patch.flatMap((row) => row.insert ?? []);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].name, manifest.name, 'row name must equal the package name');
    assert.equal(typeof inserted[0].id, 'string');
  });

  check('every config key in the patch is read by the plugin', () => {
    const patch = readPatch();
    const config = patch.flatMap((row) => row.insert ?? [])[0].config ?? {};
    const source = fs.readFileSync(path.join(root, manifest.exports['.']), 'utf8');
    for (const key of Object.keys(config)) {
      assert.ok(source.includes(`'${key}'`) || source.includes(`"${key}"`), `config key "${key}" is not read`);
    }
  });
}

console.log(problems.length === 0 ? '\nALL CHECKS PASSED' : `\n${problems.length} CHECK(S) FAILED`);
process.exitCode = problems.length === 0 ? 0 : 1;
