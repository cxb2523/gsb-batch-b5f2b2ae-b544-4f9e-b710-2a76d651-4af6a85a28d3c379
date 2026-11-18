// Aborting and releasing: a request whose signal aborts stops at once, a
// released archive drops its cache and its requests in flight, and the next
// request for the same URL opens the archive again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tiles3tzPlugin } from '../src/index.js';
import { make3tz, fakeServer, sampleFiles } from './helpers.js';

const URL3TZ = 'https://example.org/data/site.3tz';
const tick = () => new Promise( r => setTimeout( r, 5 ) );
const isAbort = error => error.name === 'AbortError';

const makePlugin = fetch => {

	const plugin = new Tiles3tzPlugin( { fetch } );
	plugin.init( { fetchOptions: {} } );
	return plugin;

};

// a fetch wrapper that holds matching requests until release() is called; a
// held request rejects with an AbortError when its signal aborts (as fetch does)
function holdable( fetchFn, hold ) {

	const held = [];
	const fetch2 = ( url, init = {} ) => {

		if ( ! hold( init ) ) return fetchFn( url, init );
		return new Promise( ( resolve, reject ) => {

			const signal = init.signal;
			if ( signal && signal.aborted ) {

				reject( new DOMException( 'Aborted', 'AbortError' ) );
				return;

			}

			const entry = { resolve: () => fetchFn( url, init ).then( resolve, reject ), reject };
			if ( signal ) signal.addEventListener( 'abort', () => entry.reject( new DOMException( 'Aborted', 'AbortError' ) ), { once: true } );
			held.push( entry );

		} );

	};
	fetch2.release = () => held.splice( 0 ).forEach( e => e.resolve() );
	return fetch2;

}

const theArchive = plugin => [ ...plugin.archives.values() ][ 0 ];
const tailRequests = log => log.filter( e => /^bytes=-/.test( e.range || '' ) ).length;

test( 'plugin: aborting a tile request cancels its Range request and empties pending', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3 ) ) );
	let armed = false;
	const fetch = holdable( server.fetch, () => armed );
	const plugin = makePlugin( fetch );
	const root = plugin.preprocessURL( URL3TZ, null );
	await ( await plugin.fetchData( root, {} ) ).json();
	const archive = await theArchive( plugin );

	armed = true;
	const controller = new AbortController();
	const request = plugin.fetchData( URL3TZ + '/tiles/1.glb', { signal: controller.signal } );
	await tick();
	assert.equal( archive.source.stats().pending.length, 1, 'the Range request is in flight' );
	controller.abort();
	await assert.rejects( request, isAbort );
	assert.deepEqual( archive.source.stats().pending, [], 'nothing pending after the abort' );

	armed = false;
	const res = await plugin.fetchData( URL3TZ + '/tiles/1.glb', {} );
	assert.equal( res.status, 200, 'the archive still serves after an aborted request' );

} );

test( 'plugin: aborting while the archive opens rejects at once; the open completes and is reused', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3 ) ) );
	let armed = true;
	const fetch = holdable( server.fetch, init => armed && /^bytes=-\d+$/.test( ( init.headers && init.headers.Range ) || '' ) );
	const plugin = makePlugin( fetch );
	const root = plugin.preprocessURL( URL3TZ, null ); // the open starts, its tail request is held

	const controller = new AbortController();
	const request = plugin.fetchData( root, { signal: controller.signal } );
	await tick();
	controller.abort();
	await assert.rejects( request, isAbort );

	// the open itself was not aborted: let it finish, the next request uses it
	armed = false;
	fetch.release();
	const res = await plugin.fetchData( root, {} );
	assert.equal( res.status, 200 );
	assert.equal( server.log.length, 2, 'one request to open, one to read the tileset' );

} );

test( 'plugin: an open archive is reused — reads cost no extra open', async () => {

	const server = fakeServer( make3tz( sampleFiles( 4 ) ) );
	const plugin = makePlugin( server.fetch );
	const root = plugin.preprocessURL( URL3TZ, null );
	assert.equal( plugin.preprocessURL( URL3TZ, null ), root, 'preprocessing again opens nothing new' );
	await ( await plugin.fetchData( root, {} ) ).json();
	for ( let i = 0; i < 3; i ++ ) await plugin.fetchData( `${ URL3TZ }/tiles/${ i }.glb`, {} );

	const archive = await theArchive( plugin );
	const stats = archive.source.stats();
	assert.equal( tailRequests( server.log ), 1, 'the archive was opened once' );
	assert.equal( stats.requests, 5, 'one request to open, one per file read' );
	assert.equal( server.log.length, 5 );

} );

test( 'plugin: release() drops the cache; the next request opens the archive again', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3 ) ) );
	const plugin = makePlugin( server.fetch );
	const root = plugin.preprocessURL( URL3TZ, null );
	await ( await plugin.fetchData( root, {} ) ).json();
	const archive = await theArchive( plugin );
	assert.equal( tailRequests( server.log ), 1 );

	assert.equal( plugin.release( root ), true, 'found by the root address addURL returned' );
	assert.equal( plugin.archives.size, 0, 'the cache is gone' );

	// the same URL opens the archive again instead of serving the released one
	const res = await plugin.fetchData( root, {} );
	assert.equal( res.status, 200 );
	assert.equal( tailRequests( server.log ), 2, 'opened again' );
	assert.notEqual( await theArchive( plugin ), archive, 'a new archive, not the released one' );

	// release finds the archive by its base URL and by the .3tz URL too
	assert.equal( plugin.release( URL3TZ + '/' ), true );
	assert.equal( plugin.release( URL3TZ ), true );
	assert.equal( plugin.release( 'https://elsewhere.example/x.3tz' ), false, 'no archive there' );

} );

test( 'plugin: release() aborts requests in flight and pending empties', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3 ) ) );
	let armed = false;
	const fetch = holdable( server.fetch, () => armed );
	const plugin = makePlugin( fetch );
	const root = plugin.preprocessURL( URL3TZ, null );
	await ( await plugin.fetchData( root, {} ) ).json();
	const archive = await theArchive( plugin );

	armed = true;
	const request = plugin.fetchData( URL3TZ + '/tiles/1.glb', {} );
	await tick();
	assert.equal( archive.source.stats().pending.length, 1, 'the Range request is in flight' );
	plugin.release( URL3TZ + '/' );
	await assert.rejects( request, isAbort );
	assert.deepEqual( archive.source.stats().pending, [], 'nothing pending after the release' );

} );

test( 'plugin: an archive from addFile is released by its root address', async () => {

	const plugin = new Tiles3tzPlugin();
	const root = plugin.addFile( new Blob( [ make3tz( sampleFiles( 2 ) ) ] ) );
	assert.equal( ( await plugin.fetchData( root, {} ) ).status, 200 );

	assert.equal( plugin.release( root ), true );
	assert.equal( plugin.archives.size, 0 );
	assert.equal( ( await plugin.fetchData( root, {} ) ).status, 200, 'opened again on demand' );

} );

test( 'plugin: dispose() releases every archive and aborts an open in flight', async () => {

	const server = fakeServer( make3tz( sampleFiles( 3 ) ) );
	let armed = true;
	const fetch = holdable( server.fetch, () => armed );
	const plugin = makePlugin( fetch );
	const root = plugin.preprocessURL( URL3TZ, null ); // the open starts, its tail request is held
	const root2 = plugin.addFile( new Blob( [ make3tz( sampleFiles( 1 ) ) ] ) );

	const request = plugin.fetchData( root, {} );
	await tick();
	plugin.dispose();
	await assert.rejects( request, isAbort, 'the open in flight is aborted' );
	assert.equal( plugin.archives.size, 0, 'every archive is released' );
	assert.equal( plugin.baseFor( root ), null );
	assert.equal( plugin.baseFor( root2 ), null );
	assert.equal( plugin.fetchData( root, {} ), null, 'after dispose the URL is no longer served' );

} );
