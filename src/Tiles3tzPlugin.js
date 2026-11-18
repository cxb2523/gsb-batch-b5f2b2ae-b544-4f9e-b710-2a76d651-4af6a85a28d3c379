import { Archive3tz } from './Archive3tz.js';
import { blobSource, httpSource } from './sources.js';

/**
 * A 3DTilesRendererJS plugin that reads a tileset from a .3tz archive,
 * fetching only the parts of the archive that are needed (HTTP Range).
 *
 * The plugin presents the archive as if it were a folder: the archive
 * `https://example.org/site.3tz` is served under `https://example.org/site.3tz/`,
 * its `tileset.json` at `https://example.org/site.3tz/tileset.json`, and each
 * tile at the path it has inside the archive. Relative tile URLs therefore
 * resolve exactly as they do in an unpacked tileset, and the renderer is not
 * aware that an archive is involved.
 *
 * ```js
 * const tiles = new TilesRenderer( 'https://example.org/site.3tz' );
 * tiles.registerPlugin( new Tiles3tzPlugin() );
 * ```
 *
 * For a file already in the browser (file picker, drag and drop):
 *
 * ```js
 * const plugin = new Tiles3tzPlugin();
 * const tiles = new TilesRenderer( plugin.addFile( file ) );
 * tiles.registerPlugin( plugin );
 * ```
 *
 * Requests answer the renderer's `AbortSignal`: when it aborts, `fetchData`
 * rejects with an AbortError and the Range request in flight is cancelled.
 * `release( url )` drops one archive (its cache and its requests in flight);
 * the next request for the same URL opens it again. `dispose()` releases all.
 */
export class Tiles3tzPlugin {

	/**
	 * @param {object} [options]
	 * @param {typeof fetch} [options.fetch]  used for the Range requests (default: global fetch)
	 * @param {object} [options.archiveOptions]  passed to `Archive3tz.open` (e.g. `maxEntryBytes`)
	 * @param {number} [options.maxDownloadBytes]  when a server ignores `Range`, the most it may send
	 * @param {boolean} [options.archiveOnly]  answer 403 to every request the renderer makes outside
	 *   the registered archives (for archives from an untrusted source: their tileset.json cannot
	 *   point the browser elsewhere). Default false, as for an unpacked tileset.
	 */
	constructor( options = {} ) {

		this.name = '3TZ_PLUGIN';
		// run before other plugins' fetchData, so archive URLs never reach the network
		this.priority = - 1;
		this.tiles = null;
		this.fetch = options.fetch || null;
		this.archiveOptions = options.archiveOptions || {};
		this.maxDownloadBytes = options.maxDownloadBytes;
		this.archiveOnly = !! options.archiveOnly;
		/** @type {Map<string, Promise<Archive3tz>>} base URL (ending in "/") → archive */
		this.archives = new Map();
		// base → controller that aborts the archive's requests (on release/dispose)
		this._controllers = new Map();
		// base → how to open it; kept after a release, so the URL can open again
		this._openers = new Map();
		this._fileCount = 0;

	}

	init( tiles ) {

		this.tiles = tiles;

	}

	/**
	 * Register an archive held in a File or Blob. Returns the URL of its
	 * tileset.json, to give to the TilesRenderer.
	 * @param {Blob} blob
	 */
	addFile( blob ) {

		const origin = globalThis.location && /^https?:$/.test( globalThis.location.protocol ) ? globalThis.location.origin : 'https://3tz.invalid';
		const base = `${ origin }/__3tz__/${ ++ this._fileCount }/`;
		this._openers.set( base, signal => Archive3tz.open( blobSource( blob ), { ...this.archiveOptions, signal } ) );
		this._open( base );
		return base + 'tileset.json';

	}

	/**
	 * Register an archive behind a URL. Returns the URL of its tileset.json.
	 * Called for you when the root URL given to the renderer ends in ".3tz".
	 * @param {string} url
	 */
	addURL( url ) {

		const absolute = resolve( url );
		const base = absolute.split( /[?#]/ )[ 0 ] + '/';
		if ( ! this._openers.has( base ) ) {

			this._openers.set( base, signal => {

				const fetchOptions = this.tiles ? this.tiles.fetchOptions : {};
				const source = httpSource( absolute, { fetch: this.fetch || undefined, fetchOptions, maxDownloadBytes: this.maxDownloadBytes } );
				return Archive3tz.open( source, { ...this.archiveOptions, signal } );

			} );

		}

		if ( ! this.archives.has( base ) ) this._open( base );
		return base + 'tileset.json';

	}

	// Open the archive behind `base`, its requests tied to a controller that
	// release() and dispose() abort. A failed or aborted open rejects quietly
	// for anyone not awaiting it.
	_open( base ) {

		const controller = new AbortController();
		const open = this._openers.get( base )( controller.signal );
		open.catch( () => {} );
		this._controllers.set( base, controller );
		this.archives.set( base, open );

	}

	/** The base URL of the archive serving `url` (open, opening, or released), or null. */
	baseFor( url ) {

		for ( const base of this._openers.keys() ) {

			if ( url.startsWith( base ) ) return base;

		}

		return null;

	}

	// renderer hook: a root URL ending in .3tz becomes the URL of its tileset.json
	preprocessURL( url, tile ) {

		if ( tile !== null ) return url;
		const path = String( url ).split( /[?#]/ )[ 0 ];
		return /\.3tz$/i.test( path ) ? this.addURL( String( url ) ) : url;

	}

	// renderer hook: answer requests under an archive's base from the archive
	fetchData( url, options ) {

		const base = this.baseFor( url );
		if ( base === null ) {

			if ( ! this.archiveOnly ) return null;
			return Promise.resolve( new Response( null, { status: 403, statusText: `${ url } is outside the archive (archiveOnly)` } ) );

		}

		const signal = options && options.signal;
		if ( ! this.archives.has( base ) ) this._open( base ); // released meanwhile: open it again
		const open = this.archives.get( base );
		const released = this._controllers.get( base ).signal;
		const path = decodeURIComponent( url.slice( base.length ).split( /[?#]/ )[ 0 ] );

		return waitFor( open, signal ).then( async archive => {

			// the read stops when the renderer's signal aborts, and also when
			// the archive is released while the read is in flight
			const linked = linkSignals( [ signal, released ] );
			try {

				if ( linked.signal && linked.signal.aborted ) throw abortError();
				const bytes = await archive.read( path, linked.signal );
				if ( linked.signal && linked.signal.aborted ) throw abortError();
				if ( bytes === null ) return new Response( null, { status: 404, statusText: `${ path } is not in the archive` } );
				return new Response( bytes, { status: 200 } );

			} finally {

				linked.detach();

			}

		} );

	}

	/**
	 * Release the archive serving `url` — its base URL (`.../site.3tz/`, or the
	 * `.3tz` URL itself) or the root address `addFile`/`addURL` returned. Its
	 * cache is dropped and its requests in flight are aborted; the next request
	 * for the same URL opens the archive again.
	 * @param {string} url
	 * @returns {boolean} false when no archive serves `url`
	 */
	release( url ) {

		const u = resolve( String( url ) );
		const base = this.baseFor( u ) || this.baseFor( u.split( /[?#]/ )[ 0 ] + '/' );
		if ( base === null ) return false;
		const controller = this._controllers.get( base );
		this.archives.delete( base );
		this._controllers.delete( base );
		if ( controller ) controller.abort();
		return true;

	}

	/** Release every archive: all caches dropped, all requests in flight aborted. */
	dispose() {

		for ( const base of [ ...this._controllers.keys() ] ) this.release( base );
		this._openers.clear();
		this.tiles = null;

	}

}

const abortError = () => new DOMException( 'Aborted', 'AbortError' );

// `promise`, but rejected with an AbortError as soon as `signal` aborts. The
// promise itself is left running: an open shared with other requests is not
// cancelled because one waiter went away.
function waitFor( promise, signal ) {

	if ( ! signal ) return promise;
	if ( signal.aborted ) return Promise.reject( abortError() );
	return new Promise( ( resolve, reject ) => {

		const onAbort = () => reject( abortError() );
		signal.addEventListener( 'abort', onAbort, { once: true } );
		promise.then(
			value => { signal.removeEventListener( 'abort', onAbort ); resolve( value ); },
			error => { signal.removeEventListener( 'abort', onAbort ); reject( error ); },
		);

	} );

}

// One signal out of several: it aborts when the first of them does. `detach`
// removes the listeners (a long-lived signal would otherwise collect one per
// read).
function linkSignals( signals ) {

	const list = signals.filter( s => s );
	if ( list.some( s => s.aborted ) ) return { signal: AbortSignal.abort(), detach() {} };
	if ( list.length === 0 ) return { signal: undefined, detach() {} };
	if ( list.length === 1 ) return { signal: list[ 0 ], detach() {} };
	const controller = new AbortController();
	const abort = () => controller.abort();
	for ( const s of list ) s.addEventListener( 'abort', abort, { once: true } );
	return { signal: controller.signal, detach: () => list.forEach( s => s.removeEventListener( 'abort', abort ) ) };

}

function resolve( url ) {

	try {

		return new URL( url, globalThis.location ? globalThis.location.href : undefined ).href;

	} catch {

		return url;

	}

}
