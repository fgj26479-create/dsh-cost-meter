/**
 * DSH Cost Meter — host half.
 *
 * Folds every durable provider usage sample in a Session into token buckets
 * split by peak/off-peak, then prices those buckets in CNY against the rate
 * card this plugin keeps current from the official pricing page.
 *
 * Deliberate design constraints:
 *
 * - **No imports at all.** The package is mounted from a profile that has no
 *   `node_modules` of its own, so nothing outside Node built-ins may be
 *   resolved. Cordis supplies `ctx`; everything else is `node:` or local.
 * - **Money is not folded.** The projection state stores tokens and the tariff
 *   period only, because a pure fold cannot see a rate card that changes.
 *   `wire.view` prices the stored buckets against the *current* card, so a
 *   pricing refresh reprices the whole session at once and the fold stays
 *   replay-deterministic.
 * - **Provider samples replace, retries add.** Mirrors `dsh-token-meter`: one
 *   usage report per attempt, and a retried attempt contributes again.
 *
 * @module dsh-cost-meter
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUNDLED_CARD,
  PRICING_URL_EN,
  PRICING_URL_ZH,
  addBuckets,
  bucketsFromUsage,
  costOfBuckets,
  emptyBuckets,
  parsePricingHtml,
  periodAt,
  resolveModelRates,
  subtractBuckets,
  totalTokens,
  validateCard,
} from './pricing.js';

/** Plugin identity for the Cordis loader. */
export const name = 'cost-meter';

/** The projection registry is the only hard dependency. */
export const inject = ['sessionProjections'];

/** Peak windows in Beijing minutes-from-midnight, published alongside the tariff. */
const PEAK_WINDOWS = Object.freeze([
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  pricingUrl: PRICING_URL_ZH,
  fallbackPricingUrl: PRICING_URL_EN,
  usdToCny: 7.2,
  refreshHours: 6,
  fetchTimeoutMs: 8000,
  fallbackModel: 'deepseek-flash',
  holidays: Object.freeze([]),
  maxTurns: 60,
  maxRoutes: 12,
  cache: true,
});

/**
 * Merge user config over the defaults, ignoring unknown keys.
 *
 * The plugin ships no Schemastery `Config`, so Cordis hands the raw YAML object
 * straight through; this is where it becomes trustworthy.
 *
 * @param {unknown} raw
 */
function normalizeConfig(raw) {
  const input = typeof raw === 'object' && raw !== null ? /** @type {any} */ (raw) : {};
  const pick = (key, test, fallback) => (test(input[key]) ? input[key] : fallback);
  const isString = (value) => typeof value === 'string' && value.length > 0;
  const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  return {
    enabled: pick('enabled', (v) => typeof v === 'boolean', DEFAULT_CONFIG.enabled),
    pricingUrl: pick('pricingUrl', isString, DEFAULT_CONFIG.pricingUrl),
    fallbackPricingUrl: pick('fallbackPricingUrl', isString, DEFAULT_CONFIG.fallbackPricingUrl),
    usdToCny: pick('usdToCny', isPositive, DEFAULT_CONFIG.usdToCny),
    refreshHours: pick('refreshHours', (v) => isPositive(v) && v <= 720, DEFAULT_CONFIG.refreshHours),
    fetchTimeoutMs: pick('fetchTimeoutMs', (v) => isPositive(v) && v <= 120_000, DEFAULT_CONFIG.fetchTimeoutMs),
    fallbackModel: pick('fallbackModel', isString, DEFAULT_CONFIG.fallbackModel),
    holidays: pick(
      'holidays',
      (v) => Array.isArray(v) && v.every((entry) => typeof entry === 'string'),
      DEFAULT_CONFIG.holidays,
    ),
    maxTurns: pick('maxTurns', (v) => isCount(v) && v >= 1 && v <= 2000, DEFAULT_CONFIG.maxTurns),
    maxRoutes: pick('maxRoutes', (v) => isCount(v) && v >= 1 && v <= 200, DEFAULT_CONFIG.maxRoutes),
    cache: pick('cache', (v) => typeof v === 'boolean', DEFAULT_CONFIG.cache),
  };
}

/** Absolute path of the on-disk rate-card cache, or `null` when unresolvable. */
function cacheFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'cost-meter', 'pricing-cache.json');
}

/** Read the cached card, tolerating a missing or corrupt file. */
function readCache() {
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return validateCard(parsed?.card) ?? null;
  } catch {
    return null;
  }
}

/** Persist the card best-effort; a read-only home must not break billing. */
function writeCache(card) {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ card }, null, 2), 'utf8');
  } catch {
    /* best effort */
  }
}

/**
 * Build a schema-like object exposing only `parse`, which is all the
 * projection registry calls. Avoids depending on a validation library.
 *
 * @param {(value: unknown) => any} parse
 */
function schema(parse) {
  return { parse };
}

/** A bucket set with every key present and finite; unknown shapes repair to zero. */
function normalizeBuckets(value) {
  const source = typeof value === 'object' && value !== null ? /** @type {any} */ (value) : {};
  const num = (entry) => (typeof entry === 'number' && Number.isFinite(entry) && entry > 0 ? entry : 0);
  return {
    cacheMissInput: num(source.cacheMissInput),
    cacheHitInput: num(source.cacheHitInput),
    cacheWriteInput: num(source.cacheWriteInput),
    output: num(source.output),
  };
}

/** Repair a persisted/streamed projection state so a stale cache cannot crash a fold. */
function normalizeState(value) {
  const source = typeof value === 'object' && value !== null ? /** @type {any} */ (value) : {};
  const routes = {};
  if (typeof source.routes === 'object' && source.routes !== null) {
    for (const [route, aggregate] of Object.entries(source.routes)) {
      const entry = typeof aggregate === 'object' && aggregate !== null ? /** @type {any} */ (aggregate) : {};
      routes[route] = {
        idle: normalizeBuckets(entry.idle),
        peak: normalizeBuckets(entry.peak),
        calls: Number.isSafeInteger(entry.calls) && entry.calls > 0 ? entry.calls : 0,
      };
    }
  }
  const turns = Array.isArray(source.turns)
    ? source.turns
        .filter((entry) => typeof entry === 'object' && entry !== null && Number.isSafeInteger(entry.turn))
        .map((entry) => ({
          turn: entry.turn,
          route: typeof entry.route === 'string' ? entry.route : null,
          idle: normalizeBuckets(entry.idle),
          peak: normalizeBuckets(entry.peak),
        }))
    : [];
  const last = typeof source.last === 'object' && source.last !== null && Number.isSafeInteger(source.last.turn)
    ? {
        turn: source.last.turn,
        step: Number.isSafeInteger(source.last.step) ? source.last.step : 0,
        route: typeof source.last.route === 'string' ? source.last.route : null,
        period: source.last.period === 'peak' ? 'peak' : 'idle',
        buckets: normalizeBuckets(source.last.buckets),
      }
    : null;
  return {
    route: typeof source.route === 'string' ? source.route : null,
    routes,
    turns,
    last,
  };
}

/** `provider/model`, or `null` when either half is missing. */
function routeOf(provider, model) {
  if (typeof provider !== 'string' || provider.length === 0) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  return `${provider}/${model}`;
}

/** The model half of a stored route. */
function modelOfRoute(route) {
  if (typeof route !== 'string') return null;
  const index = route.indexOf('/');
  return index === -1 ? route : route.slice(index + 1);
}

/**
 * The usage one durable settlement reports for its attempt, matching
 * `dsh-token-meter`'s rule: an explicit `data.usage` wins, otherwise the last
 * `usage` chunk embedded in the attempt's stream.
 *
 * @param {any} event
 */
function usageOf(event) {
  const data = event?.data;
  if (event?.type === 'assistant/message' && data?.usage !== undefined) return data.usage;
  if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') return undefined;
  const stream = data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage !== undefined) {
      return record.chunk.usage;
    }
  }
  return undefined;
}

/** The route an assistant settlement was produced by, when the log names it. */
function routeOfAssistantEvent(event) {
  const source = event?.data?.message?.source;
  if (source?.kind !== 'model') return null;
  return routeOf(source.provider, source.model);
}

/**
 * Insert or replace one turn's buckets.
 *
 * `previous` is the sample this settlement supersedes (same turn and step
 * within the same attempt); subtracting it first is what makes a streaming
 * usage report followed by a final report bill once rather than twice.
 */
function upsertTurn(turns, { turn, route, period, buckets, previous, maxTurns }) {
  const index = turns.findIndex((entry) => entry.turn === turn);
  let idle = emptyBuckets();
  let peak = emptyBuckets();
  let resolvedRoute = route;
  if (index !== -1) {
    const entry = turns[index];
    idle = entry.idle;
    peak = entry.peak;
    resolvedRoute = route ?? entry.route;
    if (previous !== null) {
      if (previous.period === 'idle') idle = subtractBuckets(idle, previous.buckets);
      else peak = subtractBuckets(peak, previous.buckets);
    }
  } else if (previous !== null) {
    if (previous.period === 'idle') idle = previous.buckets;
    else peak = previous.buckets;
  }
  if (period === 'idle') idle = addBuckets(idle, buckets);
  else peak = addBuckets(peak, buckets);

  const next = { turn, route: resolvedRoute, idle, peak };
  const list = index === -1 ? [...turns, next] : turns.map((entry, at) => (at === index ? next : entry));
  list.sort((left, right) => left.turn - right.turn);
  return list.length > maxTurns ? list.slice(list.length - maxTurns) : list;
}

/** Bound the route table so a pathological log cannot grow the checkpoint without limit. */
function boundRoutes(routes, maxRoutes) {
  const keys = Object.keys(routes);
  if (keys.length <= maxRoutes) return routes;
  const kept = {};
  for (const key of keys.slice(keys.length - maxRoutes)) kept[key] = routes[key];
  return kept;
}

/**
 * Present one bucket set as flat non-negative counts plus its total, which is
 * the shape the browser readout renders and the only shape it should have to
 * know about.
 */
function bucketView(buckets) {
  return {
    missInput: buckets.cacheMissInput,
    hitInput: buckets.cacheHitInput,
    writeInput: buckets.cacheWriteInput,
    output: buckets.output,
    total: totalTokens(buckets),
  };
}

/**
 * Build the `costUsage` projection unit.
 *
 * @param {{ config: ReturnType<typeof normalizeConfig>, card: () => any }} options
 */
function createCostProjection({ config, card }) {
  return {
    key: 'costUsage',
    stateVersion: 1,
    stateSchema: schema(normalizeState),
    init: () => normalizeState(null),
    apply: (state, event) => {
      const type = event?.type;

      if (type === 'request/header') {
        const callConfig = event.data?.header?.config;
        const route = routeOf(callConfig?.provider, callConfig?.model);
        if (route === null || route === state.route) return state;
        return { ...state, route };
      }

      // A retry inside the same step is a fresh billed attempt: drop the
      // replacement slot so the next sample is added rather than substituted.
      if (type === 'llm/retry-started') {
        const last = state.last;
        if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) return { ...state, last: null };
        return state;
      }

      if (type !== 'assistant/message' && type !== 'assistant/attempt') return state;
      const usage = usageOf(event);
      if (usage === undefined) return state;

      const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : 0;
      const step = Number.isSafeInteger(event.data?.step) ? event.data.step : 0;
      const route = routeOfAssistantEvent(event) ?? state.route;
      const period = periodAt(event.time, config.holidays);
      const buckets = bucketsFromUsage(usage);

      const previous =
        state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null;

      let idle = state.routes[route ?? '']?.idle ?? emptyBuckets();
      let peak = state.routes[route ?? '']?.peak ?? emptyBuckets();
      let calls = state.routes[route ?? '']?.calls ?? 0;
      if (previous !== null) {
        if (previous.period === 'idle') idle = subtractBuckets(idle, previous.buckets);
        else peak = subtractBuckets(peak, previous.buckets);
        calls -= 1;
      }
      if (period === 'idle') idle = addBuckets(idle, buckets);
      else peak = addBuckets(peak, buckets);
      calls += 1;

      const routes = boundRoutes(
        { ...state.routes, [route ?? '']: { idle, peak, calls } },
        config.maxRoutes,
      );

      return {
        route,
        routes,
        turns: upsertTurn(state.turns, { turn, route, period, buckets, previous, maxTurns: config.maxTurns }),
        last: { turn, step, route, period, buckets },
      };
    },
    wire: {
      viewSchema: schema((value) => value),
      view: (state) => {
        const current = card();
        const fallback = { fallbackModel: config.fallbackModel };
        /** @type {Set<string>} */
        const models = new Set();
        /** @type {Set<string>} */
        const unknownModels = new Set();

        const priceBuckets = (idle, peak, route) => {
          const resolved = resolveModelRates(current, modelOfRoute(route), fallback);
          models.add(resolved.model);
          if (!resolved.known) unknownModels.add(modelOfRoute(route) ?? String(route ?? 'unknown'));
          const idleCny = costOfBuckets(idle, resolved.rates.idle);
          const peakCny = costOfBuckets(peak, resolved.rates.peak);
          return {
            model: resolved.model,
            known: resolved.known,
            cny: idleCny + peakCny,
            idleCny,
            peakCny,
          };
        };

        const routeRows = Object.entries(state.routes).map(([route, aggregate]) => {
          const priced = priceBuckets(aggregate.idle, aggregate.peak, route);
          return {
            route: route === '' ? null : route,
            model: priced.model,
            known: priced.known,
            calls: aggregate.calls,
            cny: priced.cny,
            idleCny: priced.idleCny,
            peakCny: priced.peakCny,
            idleTokens: bucketView(aggregate.idle),
            peakTokens: bucketView(aggregate.peak),
          };
        });

        const totalsAccumulator = { cny: 0, idleCny: 0, peakCny: 0, calls: 0, idle: emptyBuckets(), peak: emptyBuckets() };
        for (const row of routeRows) {
          const aggregate = state.routes[row.route ?? ''];
          totalsAccumulator.cny += row.cny;
          totalsAccumulator.idleCny += row.idleCny;
          totalsAccumulator.peakCny += row.peakCny;
          totalsAccumulator.calls += row.calls;
          if (aggregate !== undefined) {
            totalsAccumulator.idle = addBuckets(totalsAccumulator.idle, aggregate.idle);
            totalsAccumulator.peak = addBuckets(totalsAccumulator.peak, aggregate.peak);
          }
        }
        const totals = {
          cny: totalsAccumulator.cny,
          idleCny: totalsAccumulator.idleCny,
          peakCny: totalsAccumulator.peakCny,
          calls: totalsAccumulator.calls,
          tokens: bucketView(addBuckets(totalsAccumulator.idle, totalsAccumulator.peak)),
          idleTokens: bucketView(totalsAccumulator.idle),
          peakTokens: bucketView(totalsAccumulator.peak),
        };

        const turns = state.turns.map((entry) => {
          const priced = priceBuckets(entry.idle, entry.peak, entry.route);
          return {
            turn: entry.turn,
            route: entry.route,
            model: priced.model,
            known: priced.known,
            cny: priced.cny,
            idleCny: priced.idleCny,
            peakCny: priced.peakCny,
            idleTokens: bucketView(entry.idle),
            peakTokens: bucketView(entry.peak),
            tokens: bucketView(addBuckets(entry.idle, entry.peak)),
          };
        });

        const last = state.last === null
          ? null
          : (() => {
              const periodBuckets = state.last.period === 'peak' ? state.last.buckets : emptyBuckets();
              const idleBuckets = state.last.period === 'idle' ? state.last.buckets : emptyBuckets();
              const priced = priceBuckets(idleBuckets, periodBuckets, state.last.route);
              return {
                turn: state.last.turn,
                step: state.last.step,
                route: state.last.route,
                model: priced.model,
                known: priced.known,
                period: state.last.period,
                cny: priced.cny,
                tokens: bucketView(state.last.buckets),
              };
            })();

        return {
          currency: 'CNY',
          totals,
          turns,
          last,
          routes: routeRows,
          unknownModels: [...unknownModels].sort(),
          models: [...models].sort(),
          pricing: {
            source: current.source ?? null,
            sourceKind: current.sourceKind ?? 'bundled',
            capturedAt: current.capturedAt ?? null,
            quotedCurrency: current.quotedCurrency ?? 'CNY',
            usdToCny: current.usdToCny ?? null,
            currency: 'CNY',
            unit: current.unit ?? 'per 1M tokens',
            models: Object.keys(current.models).sort(),
            fallbackModel: config.fallbackModel,
            holidays: [...config.holidays],
            peakWindows: PEAK_WINDOWS.map(([start, end]) => [start, end]),
          },
        };
      },
    },
  };
}

/** Fetch one URL as text with a hard timeout, using the runtime's global fetch. */
async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'dsh-cost-meter' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mount the cost meter.
 *
 * @param {any} ctx Cordis context carrying `sessionProjections`.
 * @param {unknown} rawConfig Profile config block for this entry.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const log = (level, message) => {
    const logger = ctx?.logger;
    const fn = logger?.[level];
    if (typeof fn === 'function') fn.call(logger, message);
  };

  const cached = config.cache ? readCache() : null;
  let current = cached ?? BUNDLED_CARD;

  ctx.sessionProjections.register(createCostProjection({ config, card: () => current }));

  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return null;
    refreshing = true;
    try {
      const candidates = [config.pricingUrl, config.fallbackPricingUrl].filter(
        (url, index, all) => typeof url === 'string' && url.length > 0 && all.indexOf(url) === index,
      );
      for (const url of candidates) {
        try {
          const html = await fetchText(url, config.fetchTimeoutMs);
          const parsed = parsePricingHtml(html, { source: url, sourceKind: 'live', usdToCny: config.usdToCny });
          if (parsed === null) {
            log('warn', `cost-meter: ${url} did not contain a complete pricing table`);
            continue;
          }
          current = parsed;
          if (config.cache) writeCache(parsed);
          log(
            'info',
            `cost-meter: pricing refreshed from ${url} (${Object.keys(parsed.models).join(', ')})`,
          );
          return parsed;
        } catch (error) {
          log('warn', `cost-meter: pricing fetch failed for ${url}: ${error?.message ?? String(error)}`);
        }
      }
      log('warn', 'cost-meter: keeping the previous rate card');
      return null;
    } finally {
      refreshing = false;
    }
  };

  ctx.effect(() => {
    const intervalMs = Math.round(config.refreshHours * 3600_000);
    let timer = setTimeout(() => {
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
    }, 1200);
    return () => {
      clearTimeout(timer);
      clearInterval(timer);
    };
  }, 'cost-meter.pricing-refresh');

  // Expose the engine on the context for sibling plugins and future commands.
  if (typeof ctx.set === 'function') {
    try {
      ctx.set('costMeter', {
        rateCard: () => current,
        refresh,
        quote: (usage, options = {}) => {
          const resolved = resolveModelRates(current, options.model, { fallbackModel: config.fallbackModel });
          const period = options.period ?? periodAt(options.at ?? Date.now(), config.holidays);
          return costOfBuckets(bucketsFromUsage(usage), resolved.rates[period]);
        },
      });
    } catch {
      /* an occupied key must not stop the projection from mounting */
    }
  }
}
