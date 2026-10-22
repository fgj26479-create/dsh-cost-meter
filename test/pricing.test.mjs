/**
 * Pricing-core tests.
 *
 * The live-source parser is the only part of this plugin that depends on
 * markup we do not control, so it is tested against the real page bodies
 * captured under `tmp/pricing/` as well as against synthetic regressions.
 *
 * Run: node --test dsh-cost-meter/test/
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_CARD,
  addBuckets,
  bucketsFromUsage,
  costOfBuckets,
  emptyBuckets,
  isPeakBeijing,
  parsePricingHtml,
  periodAt,
  resolveModelRates,
  subtractBuckets,
  totalTokens,
  validateCard,
} from '../lib/pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const capturedHtml = path.join(here, '..', '..', 'tmp', 'pricing');

function readCaptured(name) {
  const file = path.join(capturedHtml, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

test('bundled card matches the published CNY tariff', () => {
  assert.equal(BUNDLED_CARD.currency, 'CNY');
  assert.deepEqual(BUNDLED_CARD.models['deepseek-flash'], {
    idle: { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 },
    peak: { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 },
  });
  assert.deepEqual(BUNDLED_CARD.models['deepseek-v4-pro'], {
    idle: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
    peak: { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 },
  });
});

test('live parser reads the captured Simplified-Chinese page as CNY', (t) => {
  const html = readCaptured('pricing.zh.html');
  if (html === null) return t.skip('tmp/pricing/pricing.zh.html not captured');
  const card = parsePricingHtml(html, { source: 'zh', sourceKind: 'live' });
  assert.ok(card, 'expected the zh table to parse');
  assert.equal(card.currency, 'CNY');
  assert.equal(card.quotedCurrency, 'CNY');
  assert.equal(card.usdToCny, undefined);
  assert.deepEqual(Object.keys(card.models).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(card.models['deepseek-flash'].idle, { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 });
  assert.deepEqual(card.models['deepseek-flash'].peak, { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 });
  assert.deepEqual(card.models['deepseek-v4-pro'].idle, { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 });
  assert.deepEqual(card.models['deepseek-v4-pro'].peak, { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 });
  assert.ok(validateCard(card), 'parsed card must survive validateCard');
});

test('live parser converts the captured English page from USD', (t) => {
  const html = readCaptured('pricing.en.html');
  if (html === null) return t.skip('tmp/pricing/pricing.en.html not captured');
  const card = parsePricingHtml(html, { source: 'en', sourceKind: 'live', usdToCny: 7.2 });
  assert.ok(card, 'expected the en table to parse');
  assert.equal(card.quotedCurrency, 'USD');
  // Column order matches the zh table (deepseek-flash first), so the English
  // 1M cache-miss input row ($0.15 / $0.66) converts to 1.08 / 4.752 CNY.
  assert.equal(card.models['deepseek-flash'].idle.cacheMissInput, 1.08);
  assert.equal(card.models['deepseek-v4-pro'].idle.cacheMissInput, 4.752);
  assert.equal(card.models['deepseek-flash'].peak.output, 8.64);
});

test('USD source without a conversion rate is refused', (t) => {
  const html = readCaptured('pricing.en.html');
  if (html === null) return t.skip('tmp/pricing/pricing.en.html not captured');
  assert.equal(parsePricingHtml(html, { source: 'en' }), null);
});

test('parser refuses partial tables instead of under-billing', () => {
  const partial = `
    <table>
      <tr><td colspan="3">模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
      <tr><td>价格</td><td>百万tokens输入 （缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
      <tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
    </table>`;
  assert.equal(parsePricingHtml(partial, { source: 'synthetic' }), null);
});

test('parser ignores non-price rows that merely mention 输出', () => {
  const html = `
    <table>
      <tr><td colspan="3">模型</td><td>m-one</td><td>m-two</td></tr>
      <tr><td colspan="3">输出长度</td><td colspan="2">最大 384K</td></tr>
      <tr><td>价格</td><td>百万tokens输入 （缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
      <tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
      <tr><td>百万tokens输入 （缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
      <tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
      <tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
      <tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
      <tr><td>并发限制(3)</td><td>2500</td><td>500</td></tr>
    </table>`;
  const card = parsePricingHtml(html, { source: 'synthetic' });
  assert.ok(card);
  assert.deepEqual(card.models['m-one'].peak, { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 });
});

test('buckets follow the Anthropic-normalized cache split', () => {
  assert.deepEqual(bucketsFromUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 30 }), {
    cacheMissInput: 100,
    cacheHitInput: 900,
    cacheWriteInput: 30,
    output: 20,
  });
  assert.deepEqual(bucketsFromUsage(undefined), emptyBuckets());
  assert.deepEqual(bucketsFromUsage({ inputTokens: -5, outputTokens: Number.NaN }), emptyBuckets());
  assert.equal(totalTokens({ cacheMissInput: 1, cacheHitInput: 2, cacheWriteInput: 3, output: 4 }), 10);
});

test('cache writes are billed at the cache-miss rate (no separate write tariff)', () => {
  const rates = BUNDLED_CARD.models['deepseek-flash'].peak;
  // 1M cache-miss + 1M cache-write at 2 CNY, 1M cache-hit at 0.04, 1M output at 8.
  const cost = costOfBuckets(
    { cacheMissInput: 1_000_000, cacheHitInput: 1_000_000, cacheWriteInput: 1_000_000, output: 1_000_000 },
    rates,
  );
  assert.equal(Math.round(cost * 100) / 100, 12.04);
});

test('a one-million-token miss sample costs exactly the published rate', () => {
  const cost = costOfBuckets(
    { cacheMissInput: 1_000_000, cacheHitInput: 0, cacheWriteInput: 0, output: 0 },
    BUNDLED_CARD.models['deepseek-v4-pro'].idle,
  );
  assert.equal(cost, 4.5);
});

test('peak windows follow Beijing wall clock, and off-peak is half price', () => {
  // 2026-09-30 is a Wednesday.
  const at = (iso) => Date.parse(iso);
  assert.equal(periodAt(at('2026-09-30T01:00:00Z')), 'peak'); // 09:00 Beijing
  assert.equal(periodAt(at('2026-09-30T03:59:00Z')), 'peak'); // 11:59
  assert.equal(periodAt(at('2026-09-30T04:00:00Z')), 'idle'); // 12:00 lunch
  assert.equal(periodAt(at('2026-09-30T06:00:00Z')), 'peak'); // 14:00
  assert.equal(periodAt(at('2026-09-30T09:59:00Z')), 'peak'); // 17:59
  assert.equal(periodAt(at('2026-09-30T10:00:00Z')), 'idle'); // 18:00
  assert.equal(periodAt(at('2026-09-30T00:00:00Z')), 'idle'); // 08:00
  // Saturday 2026-10-03 and Sunday 2026-10-04 are idle all day.
  assert.equal(periodAt(at('2026-10-03T02:00:00Z')), 'idle');
  assert.equal(periodAt(at('2026-10-04T02:00:00Z')), 'idle');
  // A configured public holiday on a weekday is idle.
  assert.equal(isPeakBeijing(at('2026-10-01T02:00:00Z')), true); // Thursday, not yet declared
  assert.equal(isPeakBeijing(at('2026-10-01T02:00:00Z'), ['2026-10-01']), false);
  // Off-peak is exactly half of peak for every model in the card.
  for (const model of Object.values(BUNDLED_CARD.models)) {
    for (const key of ['cacheHitInput', 'cacheMissInput', 'output']) {
      assert.equal(model.idle[key] * 2, model.peak[key], `${key} off-peak must be half of peak`);
    }
  }
});

test('an unknown route is priced at the fallback model and flagged', () => {
  const resolved = resolveModelRates(BUNDLED_CARD, 'some-other-vendor/model-x');
  assert.equal(resolved.known, false);
  assert.equal(resolved.model, 'deepseek-flash');
  assert.equal(resolved.requested, 'some-other-vendor/model-x');
  const aliased = resolveModelRates(BUNDLED_CARD, 'deepseek-v4-flash-vision-exp');
  assert.equal(aliased.known, true);
  assert.equal(aliased.model, 'deepseek-flash');
  const unknownFallback = resolveModelRates(BUNDLED_CARD, null);
  assert.equal(unknownFallback.known, false);
  assert.equal(unknownFallback.model, 'deepseek-flash');
});

test('bucket arithmetic replaces a retried attempt without going negative', () => {
  const first = { cacheMissInput: 10, cacheHitInput: 1, cacheWriteInput: 0, output: 2 };
  const second = { cacheMissInput: 12, cacheHitInput: 1, cacheWriteInput: 0, output: 3 };
  assert.deepEqual(addBuckets(emptyBuckets(), first), first);
  assert.deepEqual(subtractBuckets(first, second), emptyBuckets());
  assert.deepEqual(subtractBuckets(second, first), {
    cacheMissInput: 2,
    cacheHitInput: 0,
    cacheWriteInput: 0,
    output: 1,
  });
});

test('validateCard rejects malformed cached cards', () => {
  assert.equal(validateCard(null), null);
  assert.equal(validateCard({ currency: 'USD', models: {} }), null);
  assert.equal(validateCard({ currency: 'CNY', models: { a: { idle: {}, peak: {} } } }), null);
  assert.ok(validateCard(BUNDLED_CARD));
});
