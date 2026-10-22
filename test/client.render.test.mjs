/**
 * Client-half render test.
 *
 * Loads the real `lib/client.js` through a stand-in `window.__ModuleLoader__`,
 * materializes the returned plugin with the real React runtime, and renders the
 * slot occupants against a realistic `costUsage` projection value.
 *
 * This does not replace looking at the running page; it exists because a
 * throwing slot component is silently blanked in the browser, so every mount
 * path is exercised here against real React instead.
 *
 * Requires a sibling React install. Prepare it once with:
 *   mkdir tmp/rendertest && cd tmp/rendertest
 *   npm install --cache ../../tmp/npm-cache react@18 react-dom@18
 * Without it, this file reports SKIP.
 *
 * Run: node dsh-cost-meter/test/client.render.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

/** Resolve React from the scratch install; report SKIP when it is absent. */
function loadReact() {
  try {
    const require = createRequire(path.resolve(here, '..', '..', 'tmp', 'rendertest', 'package.json'));
    return { React: require('react'), server: require('react-dom/server'), requireReact: require };
  } catch {
    return null;
  }
}

const reactRuntime = loadReact();

/** Load the shipped client bundle exactly as the shell's module loader would. */
function loadClientBundle(requireReact) {
  const source = fs.readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8');
  let entry;
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration) {
        entry = registration;
      },
    },
  };
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    // The bundle is a classic script; evaluating it registers its factory.
    // eslint-disable-next-line no-new-func
    new Function('window', 'require', source)(fakeWindow, requireReact);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.ok(entry, 'the bundle must call window.__ModuleLoader__.load');
  return entry;
}

/** A `costUsage` value shaped exactly like the host `wire.view` output. */
const usage = {
  currency: 'CNY',
  totals: {
    cny: 0.0384,
    idleCny: 0.001,
    peakCny: 0.0374,
    calls: 3,
    tokens: { missInput: 12000, hitInput: 48000, writeInput: 0, output: 3000, total: 63000 },
    idleTokens: { missInput: 1000, hitInput: 0, writeInput: 0, output: 0, total: 1000 },
    peakTokens: { missInput: 11000, hitInput: 48000, writeInput: 0, output: 3000, total: 62000 },
  },
  turns: [
    {
      turn: 1,
      route: 'deepseek-account/deepseek-flash',
      model: 'deepseek-flash',
      known: true,
      cny: 0.0123,
      idleCny: 0,
      peakCny: 0.0123,
      idleTokens: { missInput: 0, hitInput: 0, writeInput: 0, output: 0, total: 0 },
      peakTokens: { missInput: 4000, hitInput: 20000, writeInput: 0, output: 1000, total: 25000 },
      tokens: { missInput: 4000, hitInput: 20000, writeInput: 0, output: 1000, total: 25000 },
    },
  ],
  last: {
    turn: 1,
    step: 1,
    route: 'deepseek-account/deepseek-flash',
    model: 'deepseek-flash',
    known: true,
    period: 'peak',
    cny: 0.0123,
    tokens: { missInput: 4000, hitInput: 20000, writeInput: 0, output: 1000, total: 25000 },
  },
  routes: [
    {
      route: 'deepseek-account/deepseek-flash',
      model: 'deepseek-flash',
      known: true,
      calls: 3,
      cny: 0.0384,
      idleCny: 0.001,
      peakCny: 0.0374,
      idleTokens: { missInput: 1000, hitInput: 0, writeInput: 0, output: 0, total: 1000 },
      peakTokens: { missInput: 11000, hitInput: 48000, writeInput: 0, output: 3000, total: 62000 },
    },
  ],
  unknownModels: [],
  models: ['deepseek-flash'],
  pricing: {
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    sourceKind: 'live',
    capturedAt: new Date().toISOString(),
    quotedCurrency: 'CNY',
    usdToCny: null,
    currency: 'CNY',
    unit: 'per 1M tokens',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    fallbackModel: 'deepseek-flash',
    holidays: [],
    peakWindows: [
      [540, 720],
      [840, 1080],
    ],
  },
};

const projectionFace = (value) => (key) => (key === 'costUsage' ? value : undefined);

/** Collect the slot registrations the plugin's apply() performs. */
function registrations(client, React) {
  const captured = [];
  const ctx = {
    slots: {
      inject(key, callback) {
        assert.equal(typeof callback, 'function');
        return callback();
      },
      register(definition, Component) {
        captured.push({ definition, Component });
        return () => {};
      },
    },
  };
  client.apply(ctx);
  return captured;
}

test('the bundle registers itself under the installed package name', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const entry = loadClientBundle(reactRuntime.requireReact);
  assert.equal(entry.id, 'dsh-cost-meter');
  assert.equal(typeof entry.factory, 'function');
});

test('apply() contributes both occupants with the intended ids and order', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const entry = loadClientBundle(reactRuntime.requireReact);
  const client = entry.factory(reactRuntime.requireReact);
  assert.deepEqual(client.inject, ['slots']);
  assert.equal(typeof client.apply, 'function');

  const found = registrations(client, reactRuntime.React);
  assert.deepEqual(
    found.map((row) => [row.definition.name, row.definition.id, row.definition.order]),
    [
      ['conversation.chat.turnTail', 'cost-meter-turn', 40],
      ['conversation.composer.dock', 'cost-meter-session', 20],
    ],
  );
});

test('a finished turn renders its own cost in yuan', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const turnCost = registrations(client, React)[0].Component;

  const html = server.renderToStaticMarkup(
    React.createElement(turnCost, {
      useProjection: projectionFace(usage),
      turn: { turn: 1, steps: [], status: 'closed' },
    }),
  );
  assert.match(html, /¥0\.0123/, 'the turn cost must be rendered in yuan');
  assert.match(html, /2\.50万 tok/);
  assert.match(html, /data-cost-meter-turn="1"/);
  assert.match(html, /title="[^"]*本轮费用 ¥0\.0123/);
});

test('the turn occupant accepts a bare numeric turn as well as a Turn record', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const turnCost = registrations(client, React)[0].Component;
  const html = server.renderToStaticMarkup(
    React.createElement(turnCost, { useProjection: projectionFace(usage), turn: 1 }),
  );
  assert.match(html, /¥0\.0123/);
});

test('the turn occupant stays silent for a turn it cannot attribute', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const turnCost = registrations(client, React)[0].Component;

  for (const turn of [undefined, null, {}, { turn: 99 }, { steps: [] }]) {
    const html = server.renderToStaticMarkup(
      React.createElement(turnCost, { useProjection: projectionFace(usage), turn }),
    );
    assert.equal(html, '', `turn ${JSON.stringify(turn)} must render nothing`);
  }
});

test('the session total renders the running cost, token count, and tariff badge', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const sessionCost = registrations(client, React)[1].Component;

  const html = server.renderToStaticMarkup(
    React.createElement(sessionCost, { useProjection: projectionFace(usage) }),
  );
  assert.match(html, /¥0\.0384/);
  assert.match(html, /6\.30万 tok/);
  assert.match(html, /data-cost-meter-session="true"/);
  // Either tariff badge is acceptable; the clock decides which.
  assert.match(html, /高峰|闲时/);
  assert.match(html, /aria-expanded="false"/);
});

test('both occupants render nothing before the projection carries a value', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const [turnCost, sessionCost] = registrations(client, React).map((row) => row.Component);

  for (const absent of [undefined, null]) {
    assert.equal(
      server.renderToStaticMarkup(
        React.createElement(turnCost, { useProjection: projectionFace(absent), turn: { turn: 1 } }),
      ),
      '',
    );
    assert.equal(
      server.renderToStaticMarkup(React.createElement(sessionCost, { useProjection: projectionFace(absent) })),
      '',
    );
  }
});

test('a partially shaped projection value cannot crash a slot', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const [turnCost, sessionCost] = registrations(client, React).map((row) => row.Component);

  const partials = [
    {},
    { totals: {} },
    { totals: null, turns: null },
    { totals: { tokens: { total: 0 } } },
    { totals: { tokens: { total: 5 } } },
    { totals: { tokens: { total: 5 } }, turns: 'nope', pricing: null },
  ];
  for (const value of partials) {
    for (const element of [
      React.createElement(turnCost, { useProjection: projectionFace(value), turn: { turn: 1 } }),
      React.createElement(sessionCost, { useProjection: projectionFace(value) }),
    ]) {
      assert.doesNotThrow(() => server.renderToStaticMarkup(element));
    }
  }
});

test('a zero-token session and a zero-cost turn render nothing', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const [turnCost, sessionCost] = registrations(client, React).map((row) => row.Component);

  const empty = {
    ...usage,
    totals: { ...usage.totals, cny: 0, tokens: { ...usage.totals.tokens, total: 0 } },
    turns: [{ ...usage.turns[0], cny: 0, tokens: { ...usage.turns[0].tokens, total: 0 } }],
  };
  assert.equal(
    server.renderToStaticMarkup(
      React.createElement(turnCost, { useProjection: projectionFace(empty), turn: { turn: 1 } }),
    ),
    '',
  );
  assert.equal(
    server.renderToStaticMarkup(React.createElement(sessionCost, { useProjection: projectionFace(empty) })),
    '',
  );
});

test('an unknown model is priced but labelled and warned about', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const { React, server, requireReact } = reactRuntime;
  const client = loadClientBundle(requireReact).factory(requireReact);
  const turnCost = registrations(client, React)[0].Component;

  const unknown = {
    ...usage,
    turns: [{ ...usage.turns[0], known: false, route: 'other/mystery-model' }],
  };
  const html = server.renderToStaticMarkup(
    React.createElement(turnCost, { useProjection: projectionFace(unknown), turn: { turn: 1 } }),
  );
  assert.match(html, /按替代价估算/);
  assert.match(html, /mystery-model/);
});

test('the stylesheet tag carries the plugin and tag identity', (t) => {
  if (reactRuntime === null) return t.skip('React scratch install is absent');
  const source = fs.readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8');
  assert.match(source, /tag\.dataset\.plugin = PACKAGE_NAME/);
  assert.match(source, /tag\.dataset\.pluginCss = CSS_TAG_ID/);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  assert.ok(source.includes(`const PACKAGE_NAME = '${manifest.name}'`));
  // Only theme tokens, never a literal colour, in the plugin stylesheet.
  const css = source.slice(source.indexOf('const CSS = ['), source.indexOf('].join'));
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
  assert.deepEqual(literals, [], `stylesheet must use theme tokens, found ${literals.join(', ')}`);
});
