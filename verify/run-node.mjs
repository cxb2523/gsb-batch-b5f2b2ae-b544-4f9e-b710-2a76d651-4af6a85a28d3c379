#!/usr/bin/env node
/**
 * Node runner for the view-controller verification suite.
 *
 * Loads the freshly built UMD bundle in a sandbox (no DOM required), then
 * drives the loop with a manual frame scheduler.
 *
 *   node verify/run-node.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

import { createScheduler, runSuite } from './suite.js';

const here = dirname( fileURLToPath( import.meta.url ) );
const bundlePath = resolve( here, '..', 'build', 'three.min.js' );

let source;

try {

	source = readFileSync( bundlePath, 'utf8' );

} catch ( error ) {

	console.error( `Cannot read ${bundlePath}. Run "npm run build" first.` );
	process.exit( 2 );

}

// Minimal DOM-ish globals: the bundle only needs to load, the suite injects
// fake renderers/containers so no real WebGL context is created.
const sandbox = {
	console,
	setTimeout,
	clearTimeout,
	performance: typeof performance !== 'undefined' ? performance : undefined,
	document: undefined,
	window: undefined,
	self: undefined,
	navigator: { userAgent: 'node' }
};

sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;

const context = vm.createContext( sandbox );

try {

	vm.runInContext( source, context, { filename: 'build/three.min.js' } );

} catch ( error ) {

	console.error( 'Failed to evaluate build/three.min.js:', error && error.message ? error.message : error );
	process.exit( 2 );

}

const THREE = sandbox.THREE;

if ( ! THREE ) {

	console.error( 'The bundle did not expose a global THREE namespace.' );
	process.exit( 2 );

}

const scheduler = createScheduler( sandbox );
const results = runSuite( THREE, scheduler );

scheduler.restore();

for ( const name of results.tests ) {

	const failure = results.failed.find( ( entry ) => entry.name === name );
	console.log( `${failure ? 'FAIL' : 'PASS'}  ${name}` );
	if ( failure ) console.log( `        ${failure.message}` );

}

console.log( `\n${results.passed} passed, ${results.failed.length} failed, ${results.tests.length} total` );

process.exit( results.failed.length === 0 ? 0 : 1 );
