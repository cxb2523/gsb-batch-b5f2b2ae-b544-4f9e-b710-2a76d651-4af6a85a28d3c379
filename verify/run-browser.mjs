#!/usr/bin/env node
/**
 * Browser runner: serves the repository over a local HTTP server and loads the
 * verification pages in headless Chrome, reading the result out of the DOM.
 *
 *   node verify/run-browser.mjs            # run both pages
 *   node verify/run-browser.mjs suite      # fake-DOM suite only
 *   node verify/run-browser.mjs webgl      # real WebGL smoke test only
 *   CHROME_PATH=/path/to/chrome node verify/run-browser.mjs
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const here = dirname( fileURLToPath( import.meta.url ) );
const root = resolve( here, '..' );

const PAGES = {
	suite: '/verify/browser.html',
	webgl: '/verify/browser-webgl.html'
};

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8'
};

function findChrome() {

	const candidates = [
		process.env.CHROME_PATH,
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
		'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
	].filter( Boolean );

	for ( const candidate of candidates ) if ( existsSync( candidate ) ) return candidate;

	return null;

}

function serve() {

	const server = createServer( async ( request, response ) => {

		try {

			const url = new URL( request.url, 'http://127.0.0.1' );
			let pathname = decodeURIComponent( url.pathname );
			if ( pathname === '/' ) pathname = '/index.html';

			const target = normalize( join( root, pathname ) );
			if ( ! target.startsWith( root ) ) {

				response.writeHead( 403 ).end( 'forbidden' );
				return;

			}

			const info = await stat( target );
			if ( ! info.isFile() ) {

				response.writeHead( 404 ).end( 'not found' );
				return;

			}

			const body = await readFile( target );
			response.writeHead( 200, { 'content-type': MIME[ extname( target ) ] || 'application/octet-stream' } );
			response.end( body );

		} catch ( error ) {

			response.writeHead( 404 ).end( 'not found' );

		}

	} );

	return new Promise( ( resolvePromise ) => {

		server.listen( 0, '127.0.0.1', () => resolvePromise( server ) );

	} );

}

function launch( chrome, args ) {

	return new Promise( ( resolvePromise, rejectPromise ) => {

		const child = spawn( chrome, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		let stdout = '';
		let stderr = '';

		child.stdout.on( 'data', ( chunk ) => {

			stdout += chunk;

		} );
		child.stderr.on( 'data', ( chunk ) => {

			stderr += chunk;

		} );

		const timer = setTimeout( () => {

			// Only the process this runner started is terminated.
			child.kill();
			rejectPromise( new Error( 'chrome timed out' ) );

		}, 60000 );

		child.on( 'error', ( error ) => {

			clearTimeout( timer );
			rejectPromise( error );

		} );

		child.on( 'close', ( code ) => {

			clearTimeout( timer );
			resolvePromise( { code, stdout, stderr } );

		} );

	} );

}

function extractDump( html ) {

	const match = html.match( /<pre id="dump">([\s\S]*?)<\/pre>/ );
	if ( ! match ) return null;
	return match[ 1 ]
		.replace( /&lt;/g, '<' )
		.replace( /&gt;/g, '>' )
		.replace( /&quot;/g, '"' )
		.replace( /&#39;/g, '\'' )
		.replace( /&amp;/g, '&' );

}

function extractTitle( html ) {

	const match = html.match( /<title>([\s\S]*?)<\/title>/ );
	return match ? match[ 1 ] : '';

}

async function main() {

	const only = process.argv[ 2 ];
	const pages = only ? [ only ] : Object.keys( PAGES );

	for ( const key of pages ) if ( ! PAGES[ key ] ) throw new Error( `unknown page: ${key}` );

	const chrome = findChrome();
	if ( ! chrome ) {

		console.error( 'No Chrome/Edge executable found. Set CHROME_PATH to point at one.' );
		process.exit( 2 );

	}

	const bundle = join( root, 'build', 'three.min.js' );
	if ( ! existsSync( bundle ) ) {

		console.error( 'build/three.min.js is missing. Run "npm run build" first.' );
		process.exit( 2 );

	}

	const server = await serve();
	const port = server.address().port;
	const origin = `http://127.0.0.1:${port}`;

	let failures = 0;

	try {

		for ( const key of pages ) {

			const url = origin + PAGES[ key ];
			const args = [
				'--headless=new',
				'--disable-gpu-sandbox',
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-extensions',
				'--user-data-dir=' + join( root, 'node_modules', '.cache-chrome-verify' ),
				'--virtual-time-budget=15000',
				'--run-all-compositor-stages-before-draw',
				'--enable-unsafe-swiftshader',
				'--use-gl=angle',
				'--use-angle=swiftshader',
				'--dump-dom',
				url
			];

			console.log( `\n== ${key} (${url}) ==` );

			let output;
			try {

				output = await launch( chrome, args );

			} catch ( error ) {

				console.error( `${key}: ${error.message}` );
				failures ++;
				continue;

			}

			const dump = extractDump( output.stdout );
			const title = extractTitle( output.stdout );

			if ( ! dump ) {

				console.error( `${key}: no result dump found (title="${title}")` );
				if ( output.stderr ) console.error( output.stderr.split( '\n' ).slice( - 15 ).join( '\n' ) );
				failures ++;
				continue;

			}

			console.log( dump );

			if ( ! title.startsWith( 'VERIFY-OK' ) ) failures ++;

		}

	} finally {

		await new Promise( ( resolvePromise ) => server.close( resolvePromise ) );

	}

	console.log( failures === 0 ? '\nBrowser verification passed.' : `\nBrowser verification failed (${failures}).` );
	process.exit( failures === 0 ? 0 : 1 );

}

main().catch( ( error ) => {

	console.error( error && error.stack ? error.stack : error );
	process.exit( 1 );

} );
