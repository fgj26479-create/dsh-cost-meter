/**
 * Host-half integration tests.
 *
 * Drives the real `apply()` with a stub Cordis context and synthetic durable
 * events, then prices the resulting projection the way the browser reads it.
 * This is the cheapest check that the fold, the tariff window, and the wire
 * view agree before anything is installed into the live profile.
 *
 * Run: node dsh-cost-meter/test/projection.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject, name as pluginName } from '../lib/index.js';

/** 2026-09-30 is a Wednesday; 01:00Z is 09:00 Beijing, inside the morning peak. */
const PEAK_AT = Date.parse('2026-09-30T01:00:00Z');
/** 10:00Z is 18:00 Beijing, the first off-peak minute. */
const IDLE_AT = Date.parse('2026-09-30T10:00:00Z');

const FLASH = 'deepseek-account/deepseek-flash';

/**
 * Mount the plugin against a stub context and return the captured projection
 * unit plus a disposer that clears the refresh timer.
 */
function mount(config = {}) {
  let captured;
  const cleanups = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    sessionProjections: {
      register(definition) {
        captured = definition;
        return () => {};
      },
    },
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
    set(key, value) {
      this[key] = value;
      return value;
    },
  };
  apply(ctx, { cache: false, ...config });
  assert.ok(captured, 'apply() must register a projection unit');
  return {
    unit: captured,
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
    ctx,
  };
}

/** Fold events through the unit and return the projected value. */
function project(unit, events) {
  let state = unit.init();
  for (const event of events) state = unit.apply(state, event);
  const view = unit.wire.view(state);
  // The registry validates both boundaries before serving them.
  const validated = unit.wire.viewSchema.parse(view);
  unit.stateSchema.parse(state);
  return { state, view: validated };
}

const requestHeader = (model = 'deepseek-flash') => ({
  type: 'request/header',
  seq: 0,
  time: 0,
  data: { header: { config: { provider: 'deepseek-account', model } }, reason: 'initial' },
});

/** One durable assistant settlement carrying provider-reported usage. */
const assistant = ({ turn, step, time, usage, model = 'deepseek-flash', seq = 1 }) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    turn,
    step,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model } },
    stream: [],
    usage,
  },
});

test('the plugin declares its identity and hard dependency', () => {
  assert.equal(pluginName, 'cost-meter');
  assert.deepEqual(inject, ['sessionProjections']);
});

test('peak cache-miss input is billed at the published peak rate', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, [
      requestHeader(),
      // 1M cache-miss input at the peak rate of 2 CNY.
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 1_000_000 } }),
    ]);
    assert.equal(view.currency, 'CNY');
    assert.equal(view.totals.cny, 2);
    assert.equal(view.totals.calls, 1);
    assert.equal(view.totals.tokens.total, 1_000_000);
    assert.equal(view.turns.length, 1);
    assert.equal(view.turns[0].turn, 1);
    assert.equal(view.turns[0].cny, 2);
    assert.equal(view.turns[0].peakTokens.total, 1_000_000);
    assert.equal(view.turns[0].idleTokens.total, 0);
    assert.deepEqual(view.unknownModels, []);
    assert.equal(view.pricing.sourceKind, 'bundled');
  } finally {
    dispose();
  }
});

test('the same tokens cost half as much off-peak', () => {
  const { unit, dispose } = mount();
  try {
    const peak = project(unit, [
      requestHeader(),
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
    ]).view;
    const idle = project(unit, [
      requestHeader(),
      assistant({ turn: 1, step: 1, time: IDLE_AT, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
    ]).view;
    assert.equal(peak.totals.cny, 10); // 2 (miss) + 8 (output)
    assert.equal(idle.totals.cny, 5); // 1 (miss) + 4 (output)
    assert.equal(idle.totals.idleCny, 5);
    assert.equal(peak.totals.peakCny, 10);
  } finally {
    dispose();
  }
});

test('cache hits, cache writes, and output are billed on their own sides', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, [
      requestHeader(),
      // 1M cache read at the peak hit rate of 0.04.
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { cacheReadTokens: 1_000_000 } }),
      // Cache writes have no separate tariff, so they bill as cache-miss input.
      assistant({ turn: 1, step: 2, time: PEAK_AT, usage: { cacheWriteTokens: 1_000_000 } }),
      // 1M output at 8.
      assistant({ turn: 1, step: 3, time: PEAK_AT, usage: { outputTokens: 1_000_000 } }),
    ]);
    // 1M cache-hit at 0.04 + 1M cache-write at the 2 miss rate + 1M output at 8.
    assert.equal(view.totals.cny, 10.04);
    assert.equal(view.totals.tokens.hitInput, 1_000_000);
    assert.equal(view.totals.tokens.writeInput, 1_000_000);
    assert.equal(view.totals.tokens.output, 1_000_000);
    // Cache-hit rate counts the prompt side only.
    assert.equal(view.totals.tokens.hitInput / (view.totals.tokens.hitInput + view.totals.tokens.missInput), 1);
  } finally {
    dispose();
  }
});

test('a re-reported step replaces its sample; a retry adds a second attempt', () => {
  const { unit, dispose } = mount();
  try {
    const run = (events) => project(unit, [requestHeader(), ...events]).view;
    // Streaming sample then a final sample for the same step: billed once.
    const replaced = run([
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 100, outputTokens: 10 } }),
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 300, outputTokens: 30 } }),
    ]);
    assert.equal(replaced.totals.calls, 1);
    assert.equal(replaced.totals.tokens.total, 330);
    assert.equal(replaced.totals.cny, (300 * 2 + 30 * 8) / 1e6);

    // A retry clears the replacement slot, so the next sample is added.
    const retried = run([
      assistant({ turn: 2, step: 1, time: PEAK_AT, usage: { inputTokens: 300, outputTokens: 30 } }),
      { type: 'llm/retry-started', seq: 2, time: PEAK_AT, data: { turn: 2, step: 1 } },
      assistant({ turn: 2, step: 1, time: PEAK_AT, usage: { inputTokens: 500, outputTokens: 50 } }),
    ]);
    assert.equal(retried.totals.calls, 2);
    assert.equal(retried.totals.tokens.total, 880);
    assert.equal(retried.totals.cny, (300 * 2 + 30 * 8 + 500 * 2 + 50 * 8) / 1e6);
  } finally {
    dispose();
  }
});

test('turns are priced separately and stay attributable', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, [
      requestHeader(),
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 1_000_000 } }),
      assistant({ turn: 2, step: 1, time: IDLE_AT, usage: { inputTokens: 1_000_000 } }),
      assistant({ turn: 3, step: 1, time: PEAK_AT, usage: { outputTokens: 1_000_000 } }),
    ]);
    assert.deepEqual(
      view.turns.map((entry) => entry.turn),
      [1, 2, 3],
    );
    assert.deepEqual(
      view.turns.map((entry) => entry.cny),
      [2, 1, 8],
    );
    assert.equal(view.totals.cny, 11);
    assert.equal(view.totals.peakCny, 10);
    assert.equal(view.totals.idleCny, 1);
    // `last` answers for the newest settlement only.
    assert.equal(view.last.turn, 3);
    assert.equal(view.last.cny, 8);
    assert.equal(view.last.period, 'peak');
  } finally {
    dispose();
  }
});

test('an unknown model is priced at the fallback tariff and reported', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, [
      requestHeader('mystery-model'),
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 1_000_000 }, model: 'mystery-model' }),
    ]);
    assert.deepEqual(view.unknownModels, ['mystery-model']);
    assert.equal(view.routes[0].model, 'deepseek-flash');
    assert.equal(view.routes[0].known, false);
    // Still a real number rather than a silent zero.
    assert.equal(view.totals.cny, 2);
    assert.equal(view.pricing.fallbackModel, 'deepseek-flash');
  } finally {
    dispose();
  }
});

test('a retired model id follows the documented alias to its billing model', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, [
      requestHeader('deepseek-v4-flash-vision-exp'),
      assistant({
        turn: 1,
        step: 1,
        time: PEAK_AT,
        usage: { inputTokens: 1_000_000 },
        model: 'deepseek-v4-flash-vision-exp',
      }),
    ]);
    assert.deepEqual(view.unknownModels, []);
    assert.equal(view.models[0], 'deepseek-flash');
    assert.equal(view.totals.cny, 2);
  } finally {
    dispose();
  }
});

test('a configured holiday converts a weekday peak window to off-peak', () => {
  const { unit, dispose } = mount({ holidays: ['2026-09-30'] });
  try {
    const { view } = project(unit, [
      requestHeader(),
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 1_000_000 } }),
    ]);
    assert.equal(view.totals.cny, 1);
    assert.equal(view.totals.idleCny, 1);
    assert.deepEqual(view.pricing.holidays, ['2026-09-30']);
  } finally {
    dispose();
  }
});

test('the fold is pure: ignored events keep the state reference', () => {
  const { unit, dispose } = mount();
  try {
    let state = unit.init();
    for (const event of [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' } },
      { type: 'step/end', seq: 2, time: 0, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'assistant/message', seq: 4, time: 0, data: { turn: 1, step: 1, message: {}, stream: [] } },
    ]) {
      const next = unit.apply(state, event);
      assert.equal(next, state, `${event.type} must not change state`);
      state = next;
    }
  } finally {
    dispose();
  }
});

test('a retry-started event for another step leaves the replacement slot intact', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, [
      requestHeader(),
      assistant({ turn: 1, step: 1, time: PEAK_AT, usage: { inputTokens: 1_000_000 } }),
      { type: 'llm/retry-started', seq: 2, time: PEAK_AT, data: { turn: 1, step: 9 } },
    ]);
    assert.equal(view.totals.calls, 1);
    assert.equal(view.totals.cny, 2);
  } finally {
    dispose();
  }
});

test('the state schema repairs a stale checkpoint instead of throwing', () => {
  const { unit, dispose } = mount();
  try {
    const repaired = unit.stateSchema.parse({ routes: { bad: { idle: { cacheMissInput: -5 } } }, turns: 'nope' });
    assert.deepEqual(repaired.turns, []);
    assert.equal(repaired.routes.bad.idle.cacheMissInput, 0);
    assert.equal(repaired.routes.bad.calls, 0);
    assert.equal(repaired.last, null);
    assert.equal(repaired.route, null);
    // The repaired state still projects.
    const view = unit.wire.view(repaired);
    assert.equal(view.totals.cny, 0);
    assert.equal(view.totals.tokens.total, 0);
  } finally {
    dispose();
  }
});

test('peak windows and the fallback model are published for the browser', () => {
  const { unit, dispose } = mount();
  try {
    const { view } = project(unit, []);
    assert.deepEqual(view.pricing.peakWindows, [
      [540, 720],
      [840, 1080],
    ]);
    assert.equal(view.pricing.fallbackModel, 'deepseek-flash');
    assert.deepEqual(view.pricing.models, ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(view.pricing.unit, 'per 1M tokens');
  } finally {
    dispose();
  }
});
