import { html, useState, useEffect, useRef, useContext, createContext, reducedMotion } from '../ui.js';
import { tweenTo, monotonePath, fmtFull } from '../util.js';
import { scopeOf } from '../api.js';

export { scopeOf };
export const Ctx = createContext({});

// Loads one endpoint. While the same question is asked again (a refresh, a retry) the previous answer stays on screen,
// so cards do not jump. When the question changes (another site, another page filter, another range) the card drops
// straight to its loading state: an old site's numbers are never shown under a new site's name.
export function useApi(api, endpoint, { ttl = 60_000, enabled = true, epoch: given } = {}) {
  const ctx = useContext(Ctx);
  const id = scopeOf(api) + '\n' + (endpoint || '');
  const blank = { id, data: null, error: null, loading: enabled, stale: false };
  const [st, setSt] = useState(blank);
  const [n, setN] = useState(0);
  // Bumped by Refresh data: every mounted card fetches again and keeps its old answer on screen meanwhile. Dashboard's own
  // calls sit above the provider that carries the epoch, so they are handed it directly.
  const epoch = given !== undefined ? given : ctx.epoch || 0;
  // Every answer carries the question it belongs to; one for another site, filter or range is never painted, even for
  // the single frame before the effect below runs.
  const s = st.id === id ? st : blank;
  const live = useRef(id); // the question this card asks now, for a request that is still in flight
  live.current = id;
  // What was on screen before this request. The hourly cap is about the key, not about the answer, so a copy already
  // shown for this very question (a refresh, a retry, a revalidation) is still worth keeping; a copy for another
  // range, page filter or site is not, because its numbers would sit under the wrong heading.
  const kept = useRef({ id: null, data: null });
  if (s.data) kept.current = { id, data: s.data };
  useEffect(() => {
    if (!enabled || !endpoint) return;
    let dead = false;
    const stale = () => dead || live.current !== id; // a replaced card (another site, filter or range) sends nothing more
    setSt((p) => (p.id === id ? { ...p, loading: true, error: null } : { ...blank, loading: true }));
    api.get(endpoint, { ttl, force: n > 0 || epoch > 0, skip: stale, onStale: (d) => { if (!stale()) setSt({ id, data: d, error: null, loading: true, stale: true }); } })
      .then((d) => { if (!stale()) setSt({ id, data: d, error: null, loading: false, stale: false }); })
      .catch((e) => {
        if (stale()) return;
        if (e.kind === 'auth' && ctx.onAuthError) ctx.onAuthError(e);
        if (e.kind !== 'limit') return setSt({ id, data: null, error: e, loading: false, stale: false });
        // a limit while the same answer is being refreshed: keep it on screen, saying it is old, instead of an error page
        if (kept.current.data && kept.current.id === id) return setSt({ id, data: kept.current.data, error: null, loading: false, stale: true });
        setSt({ id, data: null, error: e, loading: false, stale: false });
      });
    return () => { dead = true; };
  }, [api, id, enabled, n, ttl, epoch]);
  return { ...s, retry: () => setN((x) => x + 1) };
}

// A number that springs to its target. instant skips the spring (used while the pointer scrubs the chart).
// One ticker should stay mounted, so a change of target animates from where it is now, never from zero.
// A null target means "there is no number yet" (another site, filter or range is loading): the ticker forgets its old
// value, so the next answer never briefly shows the last site's figure. key names the data behind the number: when it
// changes (a new site or page filter), the first value is set outright instead of counting up from zero.
export function useTicker(target, { instant = false, key = '' } = {}) {
  const cur = useRef(0); // where the last tween got to, so the next one carries on from there
  const live = useRef({ k: key, v: null }); // what the ticker is showing, and for which site, filter and range
  const [, bump] = useState(0);
  const paint = (k, v) => { live.current = { k, v }; bump((n) => n + 1); };
  useEffect(() => {
    if (target === null || target === undefined) { cur.current = 0; live.current = { k: key, v: null }; return; }
    // The first value of a site, filter or range appears as it is; a later one counts from wherever it is, so a
    // refresh or a new date range does not flatten the card.
    if (instant || live.current.v === null || live.current.k !== key || reducedMotion()) { cur.current = target; paint(key, target); return; }
    return tweenTo(cur.current, target, (x) => { cur.current = x; paint(key, x); }, 320);
  }, [target, instant, key]);
  if (target === null || target === undefined) return null;
  // Nothing has been drawn for this answer yet: show the value itself, never a zero or an earlier figure.
  const now = live.current;
  if (now.v === null || now.k !== key || instant) return target;
  return now.v;
}
export const Num = ({ value, resetKey }) => { const v = useTicker(value, { key: resetKey }); return html`<span class="num">${v === null ? '-' : fmtFull(v)}</span>`; };

export function Skeleton({ h = 16, w = '100%', r }) { return html`<div class="skeleton" style=${{ height: h + 'px', width: w, borderRadius: r }} aria-hidden="true"></div>`; }
export const SkeletonRows = ({ n = 5 }) => html`<div aria-busy="true" role="status"><span class="sr">Loading</span>${Array.from({ length: n }, (_, i) => html`<div style="padding:9px 8px"><${Skeleton} h=${12} w=${70 - i * 6 + '%'} /><div style="height:8px"></div><${Skeleton} h=${4} /></div>`)}</div>`;

export function ErrorBox({ error, retry }) {
  return html`<div class="err" role="alert">${error && error.message ? error.message : 'Something went wrong.'}${retry ? html`<div><button type="button" onClick=${retry}>Try again</button></div>` : null}</div>`;
}

export function Sparkline({ values, w = 96, h = 26, label }) {
  const max = Math.max(1, ...values), n = values.length;
  if (n < 2) return null;
  const pts = values.map((v, i) => [2 + (i * (w - 4)) / (n - 1), h - 3 - (v / max) * (h - 6)]);
  const last = pts[n - 1];
  return html`<svg class="spark" viewBox=${`0 0 ${w} ${h}`} width=${w} height=${h} role="img" aria-label=${label || 'trend'}>
    <path d=${monotonePath(pts)} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
    <circle cx=${last[0]} cy=${last[1]} r="2.4" fill="currentColor"/></svg>`;
}

// The credit line under both footers. The links open in a new tab and send no referrer, in keeping with a dashboard that says it does not track.
export const Credit = () => html`<p class="credit">Built with <span class="heart" role="img" aria-label="love">❤️</span> by <a href="https://abhishekhsingh.github.io/" target="_blank" rel="noopener noreferrer">Abhishekh Singh</a><span class="sep" aria-hidden="true">·</span><a href="https://github.com/abhishekhsingh/goatcounter-dashboard" target="_blank" rel="noopener noreferrer">Source code</a></p>`;
export const Delta = ({ pct }) => (pct === null || !Number.isFinite(pct) ? null : html`<span class=${'delta ' + (pct >= 0 ? 'up' : 'down')}>${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%</span>`);
