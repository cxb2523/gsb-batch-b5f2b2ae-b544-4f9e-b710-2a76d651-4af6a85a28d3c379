import '@/views/css/discover.css';
import { useEffect, useReducer, useRef } from 'react';
import { type ReelPayload, nextIndex } from '../../../discover/model.js';
import { useAutoHeight } from '../../hooks.js';
import { ICON, coverArt } from '../cover.js';
import { Icon } from '../Icon.js';
import { PreviewPlayerLazy } from './PreviewPlayerLazy.js';
import { ADVANCE_DELAY_MS, initialReelState, reelReducer, shouldAdvance } from './reelState.js';
import { Credits, FilmMeta, ModelContext, Topbar, WatchButton } from './shared.js';

/**
 * The Trailer Reel: previews played back to back, built for the side panel
 * next to a conversation (ChatGPT's thread entry point), where it keeps
 * running while the user chats. Each preview ends on a hand-off to the full
 * film; after a short beat the reel moves to the next one, and it stops after
 * the last.
 *
 * Which preview plays and whether a beat is due lives in `reelState.ts`; this
 * component only arms the beat for the current preview and clears it the
 * moment the reel moves on, so a leftover timer can never push a freshly
 * selected film away.
 */
export function TrailerReel({ payload, licenseKey }: { payload?: ReelPayload; licenseKey: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoHeight(rootRef);
  const [state, dispatch] = useReducer(reelReducer, initialReelState);

  const films = payload?.films ?? [];
  const film = films[state.index];
  const advance = film !== undefined && shouldAdvance(state, films.length);

  // One beat per card, owned by this effect: leaving the card, moving on,
  // switching auto-advance off or reaching the failure limit all clear it.
  useEffect(() => {
    if (!advance) {
      return;
    }
    const from = state.index;
    const count = films.length;
    const timer = setTimeout(() => dispatch({ type: 'advance', from, count }), ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [advance, state.index, films.length]);

  const goTo = (i: number) => {
    dispatch({ type: 'select', index: nextIndex(i, films.length, 0) });
  };
  // A finished preview and one that cannot play here both move the reel on, so a
  // single broken stream never stalls it; the card in between keeps the hand-off.
  const onEnded = () => dispatch({ type: 'ended' });
  const onError = () => dispatch({ type: 'error' });
  const onReplay = () => dispatch({ type: 'replay' });
  const toggleAuto = (on: boolean) => dispatch({ type: 'auto', on });

  if (!payload || !film) {
    return (
      <div ref={rootRef} className="bitflix-root reel-root">
        <div className="empty">Loading the Trailer Reel…</div>
      </div>
    );
  }

  const provider = payload.brand.watchProvider;

  return (
    <div ref={rootRef} className="bitflix-root reel-root">
      <Topbar
        brand={payload.brand}
        label="Trailer Reel"
        right={
          <span className="reel-count" aria-live="polite">
            {state.index + 1} / {films.length}
          </span>
        }
      />

      <div className="player-shell">
        <PreviewPlayerLazy
          key={film.id}
          film={film}
          licenseKey={licenseKey}
          onEnded={onEnded}
          onError={onError}
          onReplay={onReplay}
          handoff={<WatchButton film={film} provider={provider} />}
        />
      </div>

      <div className="film-bar reel-bar">
        <div className="titleblock">
          <h2>{film.title}</h2>
          <FilmMeta film={film} showPreviewBadge={false} />
          <p className="syn">{film.logline}</p>
        </div>
        <div className="controls">
          <WatchButton film={film} provider={provider} />
          {films.length > 1 ? (
            <button className="iconbtn" onClick={() => goTo(state.index + 1)}>
              <Icon html={ICON.next} />
              Next preview
            </button>
          ) : null}
        </div>
      </div>

      <label className="reel-auto">
        <input type="checkbox" checked={state.auto} onChange={e => toggleAuto(e.target.checked)} />
        Play the next preview automatically
      </label>

      <ol className="reel-queue" aria-label="Up next in the reel">
        {films.map((f, i) => (
          <li key={f.id}>
            <button
              className={`reel-item ${i === state.index ? 'is-current' : ''}`}
              aria-current={i === state.index ? 'true' : undefined}
              onClick={() => goTo(i)}
            >
              <span
                className="reel-thumb"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: coverArt(f.cover, f.title.charAt(0)) }}
              />
              <span className="reel-text">
                <span className="t">{f.title}</span>
                <span className="k">
                  {f.year} · {f.genre}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <Credits text={payload.credits} />
      <ModelContext
        text={`The ${payload.brand.name} Trailer Reel is playing the "${film.title}" preview (${state.index + 1} of ${films.length}). Full film: ${film.watchUrl}.`}
      />
    </div>
  );
}
