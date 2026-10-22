// One-off check: fetch the real pricing page through the plugin's own code path.
import { parsePricingHtml, PRICING_URL_ZH, PRICING_URL_EN, validateCard } from '../lib/pricing.js';

for (const [url, usdToCny] of [
  [PRICING_URL_ZH, undefined],
  [PRICING_URL_EN, 7.2],
]) {
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'dsh-cost-meter' } });
    const html = await response.text();
    const card = parsePricingHtml(html, { source: url, sourceKind: 'live', usdToCny });
    if (card === null) {
      console.log(`FAIL ${url}: no complete table`);
      continue;
    }
    console.log(
      `OK   ${url}\n     quoted=${card.quotedCurrency} currency=${card.currency} valid=${Boolean(validateCard(card))}`,
    );
    for (const [model, rates] of Object.entries(card.models)) {
      console.log(
        `     ${model}: idle(hit=${rates.idle.cacheHitInput} miss=${rates.idle.cacheMissInput} out=${rates.idle.output})` +
          ` peak(hit=${rates.peak.cacheHitInput} miss=${rates.peak.cacheMissInput} out=${rates.peak.output})`,
      );
    }
  } catch (error) {
    console.log(`ERR  ${url}: ${error.message}`);
  }
}
