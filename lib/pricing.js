/**
 * DSH Cost Meter — pricing core (host side).
 *
 * Owns the CNY rate card for the DeepSeek platform, the peak/off-peak calendar
 * that the published prices depend on, and the arithmetic that turns one
 * provider `TokenUsage` sample into money.
 *
 * Everything here is dependency-free and side-effect-free so the plugin can be
 * mounted from a profile with no `node_modules` of its own, and so the parser
 * can be exercised directly from a test harness.
 *
 * @module dsh-cost-meter/pricing
 */

/** Official pricing page (Simplified Chinese — the only locale that quotes CNY). */
export const PRICING_URL_ZH = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/** Same table in English; quoted in USD, so it is only a secondary source. */
export const PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing/';

/** China Standard Time never observes DST, so a fixed offset is exact. */
export const CHINA_TZ_OFFSET_MINUTES = 480;

/**
 * The rate card captured when this plugin was written.
 *
 * It is the offline authority: a live fetch that fails to parse falls back to
 * this table, and the UI reports which of the two is in effect.
 *
 * @type {Readonly<RateCard>}
 */
export const BUNDLED_CARD = Object.freeze({
  currency: 'CNY',
  unit: 'per 1M tokens',
  source: PRICING_URL_ZH,
  sourceKind: 'bundled',
  capturedAt: '2026-09-30T01:21:00Z',
  models: Object.freeze({
    'deepseek-flash': Object.freeze({
      idle: Object.freeze({ cacheHitInput: 0.02, cacheMissInput: 1, output: 4 }),
      peak: Object.freeze({ cacheHitInput: 0.04, cacheMissInput: 2, output: 8 }),
    }),
    'deepseek-v4-pro': Object.freeze({
      idle: Object.freeze({ cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 }),
      peak: Object.freeze({ cacheHitInput: 0.3, cacheMissInput: 9, output: 27 }),
    }),
  }),
  aliases: Object.freeze({
    // Retired ids documented as served by DeepSeek-V4.1-Flash and billed at Flash prices.
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  }),
});

/** Bucket keys, in a fixed order so every fold is deterministic. */
export const BUCKET_KEYS = Object.freeze(['cacheMissInput', 'cacheHitInput', 'cacheWriteInput', 'output']);

/** @returns {{ cacheMissInput: number, cacheHitInput: number, cacheWriteInput: number, output: number }} */
export function emptyBuckets() {
  return { cacheMissInput: 0, cacheHitInput: 0, cacheWriteInput: 0, output: 0 };
}

/**
 * Build buckets from one durable provider usage report.
 *
 * DSH normalizes DeepSeek's prompt cache into Anthropic-style fields, so
 * `inputTokens` is already the uncached remainder and cache traffic arrives
 * separately. DeepSeek publishes no separate cache-write tariff, so written
 * tokens are billed at the cache-miss rate.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
 * @returns {ReturnType<typeof emptyBuckets>}
 */
export function bucketsFromUsage(usage) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
  return {
    cacheMissInput: num(usage?.inputTokens),
    cacheHitInput: num(usage?.cacheReadTokens),
    cacheWriteInput: num(usage?.cacheWriteTokens),
    output: num(usage?.outputTokens),
  };
}

/**
 * @param {ReturnType<typeof emptyBuckets>} left
 * @param {ReturnType<typeof emptyBuckets>} right
 */
export function addBuckets(left, right) {
  return {
    cacheMissInput: left.cacheMissInput + right.cacheMissInput,
    cacheHitInput: left.cacheHitInput + right.cacheHitInput,
    cacheWriteInput: left.cacheWriteInput + right.cacheWriteInput,
    output: left.output + right.output,
  };
}

/**
 * @param {ReturnType<typeof emptyBuckets>} left
 * @param {ReturnType<typeof emptyBuckets>} right
 */
export function subtractBuckets(left, right) {
  return {
    cacheMissInput: Math.max(0, left.cacheMissInput - right.cacheMissInput),
    cacheHitInput: Math.max(0, left.cacheHitInput - right.cacheHitInput),
    cacheWriteInput: Math.max(0, left.cacheWriteInput - right.cacheWriteInput),
    output: Math.max(0, left.output - right.output),
  };
}

/** @param {ReturnType<typeof emptyBuckets>} buckets */
export function totalTokens(buckets) {
  return buckets.cacheMissInput + buckets.cacheHitInput + buckets.cacheWriteInput + buckets.output;
}

/**
 * Cost of one bucket set under one tariff, in the card's currency.
 *
 * @param {ReturnType<typeof emptyBuckets>} buckets
 * @param {{ cacheHitInput: number, cacheMissInput: number, output: number }} rates
 * @returns {number}
 */
export function costOfBuckets(buckets, rates) {
  const missSide = buckets.cacheMissInput + buckets.cacheWriteInput;
  return (
    (missSide * rates.cacheMissInput + buckets.cacheHitInput * rates.cacheHitInput + buckets.output * rates.output) / 1e6
  );
}

/** Zero-pad a positive integer to two digits. */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Decompose an instant into Beijing wall-clock parts.
 *
 * @param {number} epochMs
 * @returns {{ year: number, month: number, day: number, weekday: number, minutes: number, date: string }}
 */
export function beijingParts(epochMs) {
  const shifted = new Date(epochMs + CHINA_TZ_OFFSET_MINUTES * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    date: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

/**
 * Whether one instant falls in a peak window.
 *
 * Per the published tariff: Beijing time Monday–Friday, excluding Chinese
 * public holidays, 09:00–12:00 and 14:00–18:00. Every other instant is
 * off-peak and half price. Chinese public holidays move every year, so the
 * caller supplies them; an unknown holiday over-charges rather than
 * under-charges, which is the safe direction.
 *
 * @param {number} epochMs
 * @param {readonly string[]} [holidays] `YYYY-MM-DD` dates in Beijing time.
 * @returns {boolean}
 */
export function isPeakBeijing(epochMs, holidays = []) {
  if (!Number.isFinite(epochMs)) return true;
  const parts = beijingParts(epochMs);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  if (holidays.includes(parts.date)) return false;
  return (parts.minutes >= 9 * 60 && parts.minutes < 12 * 60) || (parts.minutes >= 14 * 60 && parts.minutes < 18 * 60);
}

/**
 * @param {number} epochMs
 * @param {readonly string[]} [holidays]
 * @returns {'peak' | 'idle'}
 */
export function periodAt(epochMs, holidays = []) {
  return isPeakBeijing(epochMs, holidays) ? 'peak' : 'idle';
}

/** Strip tags, decode the few entities the page uses, and collapse whitespace. */
function textOf(html) {
  return String(html)
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split one `<tr>` into its normalized cell texts. */
function cellsOf(rowHtml) {
  const cells = [];
  for (const match of String(rowHtml).matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(textOf(match[1]));
  return cells;
}

const MODEL_ID = /^[A-Za-z][A-Za-z0-9._-]*$/;
const PRICE_CELL = /^([$¥])?\s*(\d+(?:\.\d+)?)\s*(元)?$/;

/**
 * Parse the published model/pricing table out of the docs page.
 *
 * The page renders one table whose first row names the models and whose price
 * block uses `rowspan` to group "input (cache hit) / input (cache miss) /
 * output" against "off-peak / peak". Rather than trust the rowspan
 * arithmetic, the two groupings are tracked statefully while walking rows,
 * and a row only contributes when its labels, its period, and a value for
 * every model column all line up — anything else leaves the card incomplete
 * and the caller keeps its fallback.
 *
 * @param {string} html
 * @param {{ source?: string, sourceKind?: string, usdToCny?: number }} [meta]
 * @returns {RateCard | null}
 */
export function parsePricingHtml(html, meta = {}) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const tables = String(html).match(/<table[^>]*>[\s\S]*?<\/table>/gi) ?? [];

  for (const table of tables) {
    const tableText = textOf(table);
    const hasQuota = /缓存命中|CACHE\s*HIT/i.test(tableText);
    const isCny = tableText.includes('元') || /CNY|RMB|人民币/i.test(tableText);
    const isUsd = /\$\s*\d/.test(tableText) || /USD/i.test(tableText);
    if (!hasQuota || (!isCny && !isUsd)) continue;

    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => cellsOf(match[1]));
    const headerIndex = rows.findIndex((cells) => cells.some((cell) => /模型|MODEL/i.test(cell)));
    if (headerIndex === -1) continue;

    // The leading cells of the header row are the localized column label
    // ("模型" / "MODEL"), which is itself a plausible identifier token; drop it
    // explicitly so the two locales yield the same model list.
    const models = rows[headerIndex].filter((cell) => MODEL_ID.test(cell) && !/^(model|models|pricing)$/i.test(cell));
    if (models.length < 1) continue;

    /** @type {Record<string, any>} */
    const parsed = {};
    for (const model of models) parsed[model] = { idle: {}, peak: {} };

    let dimension = null;
    for (const cells of rows.slice(headerIndex + 1)) {
      const text = cells.join(' ');
      // Only the token-price rows rename the dimension; `输出长度` and other
      // informational rows carry no "tokens" marker and must not retarget it.
      if (/tokens/i.test(text)) {
        if (/缓存命中|CACHE\s*HIT/i.test(text)) dimension = 'cacheHitInput';
        else if (/缓存未命中|CACHE\s*MISS/i.test(text)) dimension = 'cacheMissInput';
        else if (/输出|OUTPUT/i.test(text)) dimension = 'output';
      }
      let period = null;
      if (/空闲|OFF[-\s]?PEAK/i.test(text)) period = 'idle';
      else if (/高峰|PEAK/i.test(text)) period = 'peak';
      if (dimension === null || period === null) continue;

      const values = [];
      for (const cell of cells) {
        const match = cell.match(PRICE_CELL);
        if (match === null) continue;
        values.push({ currency: match[1], value: Number(match[2]) });
      }
      if (values.length !== models.length) continue;
      if (values.some((entry) => !Number.isFinite(entry.value))) continue;
      for (const [index, model] of models.entries()) parsed[model][period][dimension] = values[index].value;
    }

    // Reject partial parses: a card missing a dimension would silently under-bill.
    const complete = models.every((model) =>
      ['idle', 'peak'].every((period) =>
        ['cacheHitInput', 'cacheMissInput', 'output'].every(
          (key) => typeof parsed[model][period][key] === 'number' && Number.isFinite(parsed[model][period][key]),
        ),
      ),
    );
    if (!complete) continue;

    const currency = isCny ? 'CNY' : 'USD';
    const usdToCny = Number.isFinite(meta.usdToCny) && meta.usdToCny > 0 ? meta.usdToCny : 0;
    if (currency === 'USD' && usdToCny <= 0) continue;

    /** @type {Record<string, any>} */
    const tariff = {};
    for (const model of models) {
      tariff[model] = { idle: {}, peak: {} };
      for (const period of ['idle', 'peak']) {
        for (const key of ['cacheHitInput', 'cacheMissInput', 'output']) {
          const raw = parsed[model][period][key];
          tariff[model][period][key] = currency === 'CNY' ? raw : round6(raw * usdToCny);
        }
      }
    }

    return {
      currency: 'CNY',
      unit: 'per 1M tokens',
      source: meta.source ?? null,
      sourceKind: meta.sourceKind ?? 'live',
      capturedAt: new Date().toISOString(),
      quotedCurrency: currency,
      usdToCny: currency === 'USD' ? usdToCny : undefined,
      models: tariff,
      aliases: { ...BUNDLED_CARD.aliases },
    };
  }
  return null;
}

/** Round to nanoyuan precision so a converted card stays reproducible. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Shape-check a rate card read back from the on-disk cache.
 *
 * @param {unknown} value
 * @returns {RateCard | null}
 */
export function validateCard(value) {
  if (typeof value !== 'object' || value === null) return null;
  const card = /** @type {any} */ (value);
  if (card.currency !== 'CNY' || typeof card.models !== 'object' || card.models === null) return null;
  const models = Object.keys(card.models);
  if (models.length === 0) return null;
  for (const model of models) {
    const entry = card.models[model];
    if (typeof entry !== 'object' || entry === null) return null;
    for (const period of ['idle', 'peak']) {
      const rates = entry[period];
      if (typeof rates !== 'object' || rates === null) return null;
      for (const key of ['cacheHitInput', 'cacheMissInput', 'output']) {
        if (typeof rates[key] !== 'number' || !Number.isFinite(rates[key]) || rates[key] < 0) return null;
      }
    }
  }
  return card;
}

/**
 * Resolve a route's model id onto a tariff, following the documented aliases.
 *
 * Unknown ids are deliberately priced at the configured fallback model and
 * flagged, so an unrecognized route shows a visibly approximate figure
 * instead of silently costing nothing.
 *
 * @param {RateCard} card
 * @param {string | null | undefined} modelId
 * @param {{ fallbackModel?: string }} [options]
 * @returns {{ model: string, known: boolean, rates: { idle: any, peak: any } }}
 */
export function resolveModelRates(card, modelId, options = {}) {
  const fallbackModel = options.fallbackModel ?? 'deepseek-flash';
  const requested = typeof modelId === 'string' && modelId.length > 0 ? modelId : null;
  const aliases = card.aliases ?? {};
  const direct = requested === null ? undefined : (card.models[requested] ?? card.models[aliases[requested]]);
  if (direct !== undefined) {
    const model = card.models[requested] !== undefined ? requested : aliases[requested];
    return { model, known: true, rates: { idle: direct.idle, peak: direct.peak } };
  }
  const fallback = card.models[fallbackModel] ?? card.models[Object.keys(card.models)[0]];
  return {
    model: card.models[fallbackModel] !== undefined ? fallbackModel : Object.keys(card.models)[0],
    known: false,
    requested,
    rates: { idle: fallback.idle, peak: fallback.peak },
  };
}

/**
 * @typedef {object} RateCard
 * @property {'CNY'} currency
 * @property {string} unit
 * @property {string | null} source
 * @property {string} sourceKind
 * @property {string} capturedAt
 * @property {string} [quotedCurrency]
 * @property {number} [usdToCny]
 * @property {Record<string, { idle: Record<string, number>, peak: Record<string, number> }>} models
 * @property {Record<string, string>} [aliases]
 */
