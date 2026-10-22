window.__ModuleLoader__.load({
  id: 'dsh-cost-meter',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const PACKAGE_NAME = 'dsh-cost-meter';

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    /** Yuan with enough precision to stay meaningful at DeepSeek's unit prices. */
    function formatCny(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '\u2014';
      if (value === 0) return '0.00';
      const magnitude = Math.abs(value);
      if (magnitude >= 1) return value.toFixed(2);
      if (magnitude >= 0.01) return value.toFixed(4);
      return value.toFixed(6);
    }

    /** Always carries the currency mark, so the unit is never implied. */
    function yuan(value) {
      return '\u00a5' + formatCny(value);
    }

    /** Compact token counts using Chinese myriad grouping. */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '\u2014';
      if (value >= 1e8) return (value / 1e8).toFixed(2) + '\u4ebf';
      if (value >= 1e4) return (value / 1e4).toFixed(2) + '\u4e07';
      return String(Math.round(value));
    }

    /** `provider/model` -> `model`, for display only. */
    function modelOf(route) {
      if (typeof route !== 'string' || route.length === 0) return '\u672a\u77e5\u6a21\u578b';
      const index = route.indexOf('/');
      return index === -1 ? route : route.slice(index + 1);
    }

    /** Cache efficiency of the prompt side, or `null` when nothing was billed. */
    function cacheHitPercent(tokens) {
      const prompt = tokens.hitInput + tokens.missInput;
      if (!(prompt > 0)) return null;
      return Math.round((tokens.hitInput / prompt) * 100);
    }

    /** How stale the rate card is, in whole hours. */
    function cardAgeHours(pricing) {
      if (!pricing || typeof pricing.capturedAt !== 'string') return null;
      const captured = Date.parse(pricing.capturedAt);
      if (!Number.isFinite(captured)) return null;
      return Math.max(0, Math.round((Date.now() - captured) / 3600000));
    }

    function sourceLabel(pricing) {
      if (!pricing) return '\u672a\u77e5';
      if (pricing.sourceKind === 'live') return '\u5b98\u65b9\u5b9e\u65f6\u4ef7\u683c';
      if (pricing.sourceKind === 'cache') return '\u672c\u5730\u7f13\u5b58\u4ef7\u683c';
      return '\u5185\u7f6e\u4ef7\u683c\u8868';
    }

    /**
     * Beijing peak/off-peak, recomputed locally from the windows the host
     * publishes so the badge follows the clock without another host round-trip.
     */
    function peakNow(pricing) {
      if (!pricing || !Array.isArray(pricing.peakWindows)) return null;
      const shifted = new Date(Date.now() + 8 * 3600 * 1000);
      const weekday = shifted.getUTCDay();
      if (weekday === 0 || weekday === 6) return false;
      const date =
        shifted.getUTCFullYear() +
        '-' +
        String(shifted.getUTCMonth() + 1).padStart(2, '0') +
        '-' +
        String(shifted.getUTCDate()).padStart(2, '0');
      if (Array.isArray(pricing.holidays) && pricing.holidays.indexOf(date) !== -1) return false;
      const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
      return pricing.peakWindows.some(
        (window_) => Array.isArray(window_) && minutes >= window_[0] && minutes < window_[1],
      );
    }

    /**
     * The `turn` owner prop has no shipped type declaration; accept the
     * plausible shapes and give up rather than attribute a cost to a wrong turn.
     */
    function turnNumberOf(turn) {
      if (typeof turn === 'number' && Number.isFinite(turn)) return turn;
      if (turn !== null && typeof turn === 'object') {
        for (const key of ['turn', 'index', 'number', 'value']) {
          if (typeof turn[key] === 'number' && Number.isFinite(turn[key])) return turn[key];
        }
      }
      return null;
    }

    // ---------------------------------------------------------------------
    // Plugin-owned stylesheet, registered the way the shipped UI does so the
    // module system removes it when this plugin unloads.
    // ---------------------------------------------------------------------

    const CSS_TAG_ID = PACKAGE_NAME + '/cost-meter.css';
    const CSS = [
      '.dcm-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:999px;',
      'background:transparent;border:none;cursor:pointer;white-space:nowrap;font:inherit;',
      'font-variant-numeric:tabular-nums;line-height:18px;color:var(--dsw-alias-label-tertiary);',
      'transition:background-color .12s ease,color .12s ease}',
      '.dcm-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dcm-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dcm-static{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;',
      'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
      '.dcm-amount{color:var(--dsw-alias-state-success-primary);font-weight:600}',
      '.dcm-badge{font-size:11px;padding:0 5px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.dcm-badge[data-peak="true"]{color:var(--dsw-alias-state-warn-primary);',
      'border-color:var(--dsw-alias-state-warn-primary)}',
      '.dcm-panel{position:fixed;z-index:2147483000;min-width:268px;max-width:344px;',
      'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'box-shadow:0 8px 28px rgba(0,0,0,.28);padding:10px 12px;',
      'font-size:12px;line-height:1.65}',
      '.dcm-panel h4{margin:0 0 6px;font-size:12px;font-weight:600}',
      '.dcm-panel hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}',
      '.dcm-row{display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}',
      '.dcm-row>span:first-child{color:var(--dsw-alias-label-tertiary)}',
      '.dcm-row[data-emphasis="true"]>span{font-weight:600}',
      '.dcm-note{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dcm-warn{margin-top:6px;color:var(--dsw-alias-state-warn-primary);font-size:11px}',
    ].join('');

    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_NAME;
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // Shared readout surfaces
    // ---------------------------------------------------------------------

    function Row(props) {
      return h(
        'div',
        { className: 'dcm-row', 'data-emphasis': props.emphasis ? 'true' : undefined },
        h('span', { key: 'label' }, props.label),
        h('span', { key: 'value' }, props.value),
      );
    }

    /** The full billing split, built from one `costUsage` projection value. */
    function breakdown(usage, scope) {
      const pricing = usage.pricing;
      const totals = usage.totals;
      const tokens = totals.tokens;
      const lines = [];

      lines.push(h(Row, { key: 'total', label: '\u672c\u4f1a\u8bdd\u5408\u8ba1', value: yuan(totals.cny), emphasis: true }));
      lines.push(h('hr', { key: 'hr1' }));
      lines.push(h(Row, { key: 'hit', label: '\u8f93\u5165\u00b7\u7f13\u5b58\u547d\u4e2d', value: formatTokens(tokens.hitInput) + ' tok' }));
      lines.push(h(Row, { key: 'miss', label: '\u8f93\u5165\u00b7\u7f13\u5b58\u672a\u547d\u4e2d', value: formatTokens(tokens.missInput) + ' tok' }));
      if (tokens.writeInput > 0) {
        lines.push(h(Row, { key: 'write', label: '\u8f93\u5165\u00b7\u7f13\u5b58\u5199\u5165', value: formatTokens(tokens.writeInput) + ' tok' }));
      }
      lines.push(h(Row, { key: 'out', label: '\u8f93\u51fa', value: formatTokens(tokens.output) + ' tok' }));
      const hitRate = cacheHitPercent(tokens);
      if (hitRate !== null) lines.push(h(Row, { key: 'rate', label: '\u7f13\u5b58\u547d\u4e2d\u7387', value: hitRate + '%' }));
      lines.push(h('hr', { key: 'hr2' }));
      lines.push(h(Row, { key: 'peak', label: '\u9ad8\u5cf0\u65f6\u6bb5\u8d39\u7528', value: yuan(totals.peakCny) }));
      lines.push(h(Row, { key: 'idle', label: '\u95f2\u65f6\u6bb5\u8d39\u7528', value: yuan(totals.idleCny) }));
      lines.push(h(Row, { key: 'calls', label: '\u8ba1\u8d39\u8bf7\u6c42\u6570', value: String(totals.calls) }));
      if (scope === 'session' && Array.isArray(usage.routes) && usage.routes.length > 0) {
        lines.push(h('hr', { key: 'hr3' }));
        for (const route of usage.routes) {
          lines.push(
            h(Row, {
              key: 'route:' + String(route.route),
              label: modelOf(route.route) + (route.known ? '' : ' \u00b7 \u4f30\u7b97'),
              value: yuan(route.cny),
            }),
          );
        }
      }
      lines.push(h('hr', { key: 'hr4' }));
      lines.push(h(Row, { key: 'src', label: '\u4ef7\u683c\u6765\u6e90', value: sourceLabel(pricing) }));
      if (pricing && Array.isArray(pricing.models) && pricing.models.length > 0) {
        lines.push(h(Row, { key: 'book', label: '\u4ef7\u683c\u8868\u6db5\u76d6', value: pricing.models.join('\u3001') }));
      }
      const age = cardAgeHours(pricing);
      if (age !== null) {
        lines.push(h(Row, { key: 'age', label: '\u4ef7\u683c\u5df2\u66f4\u65b0', value: age === 0 ? '\u521a\u521a' : age + ' \u5c0f\u65f6\u524d' }));
      }
      if (Array.isArray(usage.unknownModels) && usage.unknownModels.length > 0) {
        lines.push(
          h(
            'div',
            { key: 'unknown', className: 'dcm-warn' },
            '\u672a\u77e5\u6a21\u578b ' +
              usage.unknownModels.join(', ') +
              '\uff0c\u5df2\u6309 ' +
              (pricing && pricing.fallbackModel ? pricing.fallbackModel : '\u9ed8\u8ba4') +
              ' \u4ef7\u683c\u4f30\u7b97',
          ),
        );
      }
      lines.push(
        h(
          'div',
          { key: 'basis', className: 'dcm-note' },
          '\u6309\u5b98\u65b9\u516c\u5f00\u4ef7\u683c\u4e0e\u670d\u52a1\u5546\u8fd4\u56de\u7684 usage \u4f30\u7b97\uff0c\u4ec5\u4f9b\u53c2\u8003\uff1b\u5b9e\u9645\u6263\u8d39\u4ee5\u8d26\u5355\u4e3a\u51c6\u3002',
        ),
      );
      return lines;
    }

    /** Anchored popover; closes on Escape, outside press, scroll, or resize. */
    function DetailsPanel(props) {
      const panelRef = React.useRef(null);
      const [style, setStyle] = React.useState({ visibility: 'hidden', top: 0, left: 0 });

      React.useLayoutEffect(() => {
        const anchor = props.anchorRef.current;
        const panel = panelRef.current;
        if (!anchor || !panel) return undefined;
        const place = () => {
          const rect = anchor.getBoundingClientRect();
          const height = panel.offsetHeight || 0;
          const width = panel.offsetWidth || 268;
          setStyle({
            visibility: 'visible',
            top: Math.max(8, rect.top - height - 8),
            left: Math.min(Math.max(8, rect.left - 8), Math.max(8, window.innerWidth - width - 8)),
          });
        };
        place();
        // The first pass can measure a panel that has not been laid out yet.
        const frame = requestAnimationFrame(place);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          cancelAnimationFrame(frame);
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [props.anchorRef]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose();
        };
        const onPointer = (event) => {
          const panel = panelRef.current;
          if (panel && panel.contains(event.target)) return;
          const anchor = props.anchorRef.current;
          if (anchor && anchor.contains(event.target)) return;
          props.onClose();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointer, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPointer, true);
        };
      }, [props]);

      const content = h(
        'div',
        { ref: panelRef, className: 'dcm-panel', role: 'dialog', 'aria-label': '\u8d39\u7528\u660e\u7ec6', style },
        props.children,
      );
      // The composer dock lives inside a scroll container; a body-level portal
      // keeps the popover unclipped, matching the shipped stats pill.
      if (typeof document === 'undefined') return content;
      const host = document.body || document.documentElement;
      return host ? ReactDOM.createPortal(content, host) : content;
    }

    // ---------------------------------------------------------------------
    // Slot occupants
    // ---------------------------------------------------------------------

    /** Finished-turn cost, rendered statically so it reads as part of the turn. */
    function TurnCost(props) {
      const usage = props.useProjection('costUsage');
      if (usage === undefined || usage === null) return null;
      const turnNumber = turnNumberOf(props.turn);
      if (turnNumber === null || !Array.isArray(usage.turns)) return null;
      const row = usage.turns.find((entry) => entry.turn === turnNumber);
      if (row === undefined || !(row.tokens.total > 0)) return null;

      const title = [
        '\u672c\u8f6e\u8d39\u7528 ' + yuan(row.cny),
        '\u6a21\u578b ' + modelOf(row.route) + (row.known ? '' : '\uff08\u6309\u66ff\u4ee3\u4ef7\u4f30\u7b97\uff09'),
        '\u8f93\u5165 ' + formatTokens(row.tokens.hitInput + row.tokens.missInput + row.tokens.writeInput) + ' tok',
        '\u8f93\u51fa ' + formatTokens(row.tokens.output) + ' tok',
      ].join('\n');

      return h(
        'span',
        { className: 'dcm-static', title, 'data-cost-meter-turn': String(turnNumber) },
        h('span', { key: 'amount', className: 'dcm-amount' }, yuan(row.cny)),
        h('span', { key: 'tokens' }, formatTokens(row.tokens.total) + ' tok'),
      );
    }

    /** Session total plus the live tariff posture; click for the full split. */
    function SessionCost(props) {
      const usage = props.useProjection('costUsage');
      const anchorRef = React.useRef(null);
      const [open, setOpen] = React.useState(false);
      const totals = usage === undefined || usage === null ? undefined : usage.totals;
      const tokens = totals === undefined || totals === null ? undefined : totals.tokens;
      if (tokens === undefined || tokens === null || !(tokens.total > 0)) return null;

      const peak = peakNow(usage.pricing);
      return h(React.Fragment, null, [
        h(
          'button',
          {
            key: 'pill',
            ref: anchorRef,
            type: 'button',
            className: 'dcm-pill',
            'data-cost-meter-session': 'true',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
            title:
              '\u672c\u4f1a\u8bdd\u7d2f\u8ba1\u8d39\u7528\uff08\u4eba\u6c11\u5e01\uff09\u2014\u2014\u70b9\u51fb\u67e5\u770b\u660e\u7ec6',
          },
          [
            h('span', { key: 'amount', className: 'dcm-amount' }, yuan(totals.cny)),
            h('span', { key: 'tokens' }, formatTokens(tokens.total) + ' tok'),
            peak === null
              ? null
              : h(
                  'span',
                  { key: 'badge', className: 'dcm-badge', 'data-peak': peak ? 'true' : undefined },
                  peak ? '\u9ad8\u5cf0' : '\u95f2\u65f6',
                ),
          ],
        ),
        open
          ? h(
              DetailsPanel,
              { key: 'panel', anchorRef, onClose: () => setOpen(false) },
              [h('h4', { key: 'title' }, '\u672c\u4f1a\u8bdd\u8d39\u7528\u660e\u7ec6'), ...breakdown(usage, 'session')],
            )
          : null,
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `inject` defers until the owning plugin declares the slot, so this
        // survives a re-declaration instead of racing it.
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'cost-meter-turn', order: 40 }, TurnCost),
        );
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'cost-meter-session', order: 20 }, SessionCost),
        );
      },
    };
  },
});
