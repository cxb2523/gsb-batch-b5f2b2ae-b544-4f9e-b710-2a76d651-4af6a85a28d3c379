/**
 * Shared verification suite for the view controller.
 *
 * The suite is intentionally environment-agnostic: it uses fake containers,
 * fake DOM elements and a fake renderer, so it runs identically in Node and in
 * a browser. Only `requestAnimationFrame`/`cancelAnimationFrame` come from the
 * host (see createScheduler), which lets a single flush step drive the loop
 * deterministically.
 */

function makeContainer( width, height ) {

	const container = {
		children: [],
		parentNode: null,
		_w: width,
		_h: height,

		getBoundingClientRect() {

			return { width: this._w, height: this._h, top: 0, left: 0, right: this._w, bottom: this._h };

		},

		appendChild( element ) {

			this.children.push( element );
			element.parentNode = this;
			return element;

		},

		removeChild( element ) {

			const index = this.children.indexOf( element );
			if ( index !== - 1 ) this.children.splice( index, 1 );
			element.parentNode = null;
			return element;

		},

		querySelector() {

			return null;

		}

	};

	Object.defineProperty( container, 'clientWidth', { get() {

		return this._w;

	} } );
	Object.defineProperty( container, 'clientHeight', { get() {

		return this._h;

	} } );
	Object.defineProperty( container, 'offsetWidth', { get() {

		return this._w;

	} } );
	Object.defineProperty( container, 'offsetHeight', { get() {

		return this._h;

	} } );

	return container;

}

function setContainerSize( container, width, height ) {

	container._w = width;
	container._h = height;

}

function makeElement() {

	const listeners = [];
	const ownerDocument = {
		listeners: [],
		addEventListener( type, fn ) {

			this.listeners.push( { type, fn } );

		},
		removeEventListener( type, fn ) {

			for ( let i = this.listeners.length - 1; i >= 0; i -- ) {

				if ( this.listeners[ i ].type === type && this.listeners[ i ].fn === fn ) this.listeners.splice( i, 1 );

			}

		}
	};

	const element = {
		style: {},
		listeners,
		ownerDocument,
		addEventListener( type, fn ) {

			listeners.push( { type, fn } );

		},
		removeEventListener( type, fn ) {

			for ( let i = listeners.length - 1; i >= 0; i -- ) {

				if ( listeners[ i ].type === type && listeners[ i ].fn === fn ) listeners.splice( i, 1 );

			}

		},
		setPointerCapture() {},
		releasePointerCapture() {},
		getBoundingClientRect() {

			return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 };

		},
		clientWidth: 800,
		clientHeight: 600,
		contains() {

			return false;

		}
	};

	element.listenerCount = () => listeners.length + ownerDocument.listeners.length;

	return element;

}

function makeRenderer( container ) {

	const element = makeElement();
	const records = {
		setSize: [],
		setPixelRatio: [],
		setClearColor: [],
		render: 0,
		dispose: 0,
		forceContextLoss: 0
	};

	const renderer = {
		isFakeRenderer: true,
		domElement: element,
		records,
		setPixelRatio( value ) {

			records.setPixelRatio.push( value );

		},
		setClearColor( color, alpha ) {

			records.setClearColor.push( [ color, alpha ] );

		},
		setSize( width, height ) {

			records.setSize.push( [ width, height ] );

		},
		render() {

			records.render ++;

		},
		dispose() {

			records.dispose ++;

		},
		forceContextLoss() {

			records.forceContextLoss ++;

		}
	};

	if ( container ) container.appendChild( element );

	return renderer;

}

/**
 * Replaces the host's requestAnimationFrame with a manually-driven scheduler.
 *
 * @param {Object} globalObject - window in a browser, the vm sandbox in Node.
 * @return {Object} scheduler with pendingCount/flushNext/reset/restore.
 */
export function createScheduler( globalObject ) {

	const pending = new Map();
	let nextId = 1;

	const original = {
		raf: globalObject.requestAnimationFrame,
		caf: globalObject.cancelAnimationFrame
	};

	globalObject.requestAnimationFrame = ( callback ) => {

		const id = nextId ++;
		pending.set( id, callback );
		return id;

	};

	globalObject.cancelAnimationFrame = ( id ) => {

		pending.delete( id );

	};

	return {
		pendingCount() {

			return pending.size;

		},
		flushNext() {

			const entry = pending.entries().next();
			if ( entry.done ) return false;

			const [ id, callback ] = entry.value;
			pending.delete( id );
			callback( 16 );
			return true;

		},
		reset() {

			pending.clear();

		},
		restore() {

			if ( original.raf ) globalObject.requestAnimationFrame = original.raf;
			else delete globalObject.requestAnimationFrame;
			if ( original.caf ) globalObject.cancelAnimationFrame = original.caf;
			else delete globalObject.cancelAnimationFrame;

			pending.clear();

		}
	};

}

const TOLERANCE = 1e-6;

/**
 * @param {Object} THREE - the built namespace (with createViewController).
 * @param {Object} scheduler - from createScheduler().
 * @return {{ passed: number, failed: Array<{name: string, message: string}>, tests: string[] }}
 */
export function runSuite( THREE, scheduler ) {

	if ( ! THREE || typeof THREE.createViewController !== 'function' ) {

		throw new Error( 'THREE.createViewController is not exported by the build' );

	}

	const results = { passed: 0, failed: [], tests: [] };

	function test( name, fn ) {

		scheduler.reset();

		try {

			fn();
			results.passed ++;

		} catch ( error ) {

			results.failed.push( { name, message: error && error.message ? error.message : String( error ) } );

		}

		results.tests.push( name );

	}

	const ok = ( condition, message ) => {

		if ( ! condition ) throw new Error( message );

	};

	const near = ( actual, expected, message ) => {

		ok( Math.abs( actual - expected ) <= TOLERANCE, `${message} (expected ${expected}, got ${actual})` );

	};

	// ---------------------------------------------------------------------
	test( 'creates renderer, scene, camera and controls; starts one loop', () => {

		const container = makeContainer( 800, 600 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, {
			camera: { fov: 45, position: [ 0, 0, 3 ], lookAt: [ 0, 0, 0 ] },
			renderer,
			pixelRatio: 2,
			clearColor: 0x112233
		} );

		try {

			ok( view.renderer === renderer, 'renderer instance is reused' );
			ok( view.scene && view.scene.isScene, 'scene created' );
			ok( view.camera && view.camera.isPerspectiveCamera, 'perspective camera created' );
			ok( view.controls && typeof view.controls.update === 'function', 'OrbitControls created' );
			ok( renderer.domElement.parentNode === container, 'canvas appended to container' );

			near( view.camera.fov, 45, 'camera fov applied' );
			near( view.camera.aspect, 800 / 600, 'camera aspect from container' );
			near( view.camera.position.z, 3, 'camera position applied' );

			ok( renderer.records.setPixelRatio.length === 1 && renderer.records.setPixelRatio[ 0 ] === 2, 'pixel ratio applied' );
			ok( renderer.records.setClearColor.length === 1, 'clear color applied' );
			ok( renderer.records.setSize.length === 1, 'initial size applied once' );
			ok( renderer.records.setSize[ 0 ][ 0 ] === 800 && renderer.records.setSize[ 0 ][ 1 ] === 600, 'initial size is container size' );

			ok( scheduler.pendingCount() === 1, 'exactly one frame pending' );
			ok( view.running === true, 'view reports running' );

		} finally {

			view.destroy();

		}

	} );

	// ---------------------------------------------------------------------
	test( 'zero-sized container skips resize without throwing', () => {

		const container = makeContainer( 0, 0 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, {
			camera: { aspect: 1.5 },
			renderer,
			autoStart: false
		} );

		try {

			ok( renderer.records.setSize.length === 0, 'no size applied for zero container' );
			near( view.camera.aspect, 1.5, 'falls back to provided aspect' );
			ok( view.size === null, 'no measured size stored' );

			view.resize();
			ok( renderer.records.setSize.length === 0, 'resize on zero container still skipped' );
			ok( scheduler.pendingCount() === 0, 'no frame requested while paused' );
			ok( view.camera.aspect === 1.5, 'aspect unchanged after skipped resize' );

			view.pause();
			view.resize();
			ok( scheduler.pendingCount() === 0, 'no frame requested after pause + zero resize' );

			// Growing the container should now take effect.
			setContainerSize( container, 640, 320 );
			view.resize();
			ok( renderer.records.setSize.length === 1, 'size applied once container has extent' );
			ok( renderer.records.setSize[ 0 ][ 0 ] === 640 && renderer.records.setSize[ 0 ][ 1 ] === 320, 'size matches container' );
			near( view.camera.aspect, 2, 'aspect follows resize' );

		} finally {

			view.destroy();

		}

	} );

	// ---------------------------------------------------------------------
	test( 'pause cancels the frame; resume keeps a single loop', () => {

		const container = makeContainer( 320, 240 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, { renderer, autoStart: false } );

		try {

			const rendersAfterCreate = renderer.records.render;

			view.resume();
			ok( scheduler.pendingCount() === 1, 'resume schedules one frame' );

			view.resume();
			ok( scheduler.pendingCount() === 1, 'double resume still has one frame' );

			view.pause();
			ok( scheduler.pendingCount() === 0, 'pause cancels pending frame' );

			ok( scheduler.flushNext() === false, 'nothing left to flush after pause' );
			ok( renderer.records.render === rendersAfterCreate, 'no frame rendered after pause' );

			view.resume();
			ok( scheduler.pendingCount() === 1, 'resume after pause schedules exactly one frame' );

			ok( scheduler.flushNext() === true, 'one frame flushes' );
			ok( renderer.records.render === rendersAfterCreate + 1, 'frame rendered once' );
			ok( scheduler.pendingCount() === 1, 'loop schedules its successor exactly once' );

			view.pause();
			ok( scheduler.pendingCount() === 0, 'pause cancels the successor frame too' );

		} finally {

			view.destroy();

		}

	} );

	// ---------------------------------------------------------------------
	test( 'resume uses the most recent resize even when interleaved', () => {

		const container = makeContainer( 100, 100 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, { renderer, autoStart: false } );

		try {

			view.pause();

			setContainerSize( container, 1024, 768 );
			view.resize();
			ok( scheduler.pendingCount() === 0, 'resize while paused does not schedule a frame' );

			setContainerSize( container, 300, 600 );
			view.resize();
			ok( scheduler.pendingCount() === 0, 'still no frame while paused' );

			view.resume();

			const last = renderer.records.setSize[ renderer.records.setSize.length - 1 ];
			ok( last[ 0 ] === 300 && last[ 1 ] === 600, `resume applies latest resize, got ${last[ 0 ]}x${last[ 1 ]}` );
			near( view.camera.aspect, 300 / 600, 'aspect reflects latest resize' );
			ok( scheduler.pendingCount() === 1, 'exactly one frame after interleaved resume' );

		} finally {

			view.destroy();

		}

	} );

	// ---------------------------------------------------------------------
	test( 'destroy frees resources, disconnects controls and is idempotent', () => {

		const container = makeContainer( 640, 480 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, { renderer } );

		const geometry = new THREE.BoxGeometry( 1, 1, 1 );
		const material = new THREE.MeshBasicMaterial();
		const mesh = new THREE.Mesh( geometry, material );
		view.scene.add( mesh );

		let geometryDisposed = 0;
		let materialDisposed = 0;
		const originalGeometryDispose = geometry.dispose.bind( geometry );
		const originalMaterialDispose = material.dispose.bind( material );
		geometry.dispose = () => {

			geometryDisposed ++;
			originalGeometryDispose();

		};

		material.dispose = () => {

			materialDisposed ++;
			originalMaterialDispose();

		};

		const element = renderer.domElement;

		ok( element.listenerCount() > 0, 'OrbitControls attached listeners' );
		ok( scheduler.pendingCount() === 1, 'loop running before destroy' );

		view.destroy();

		ok( scheduler.pendingCount() === 0, 'pending frame cancelled on destroy' );
		ok( view.destroyed === true, 'destroyed flag set' );
		ok( element.listenerCount() === 0, `OrbitControls listeners removed (left ${element.listenerCount()})` );
		ok( renderer.records.dispose === 1, 'renderer disposed once' );
		ok( renderer.records.forceContextLoss === 1, 'GPU context released once' );
		ok( container.children.length === 0, 'canvas removed from container' );
		ok( geometryDisposed === 1, 'geometry GPU resources released' );
		ok( materialDisposed === 1, 'material GPU resources released' );

		// Second destroy must be harmless.
		view.destroy();
		ok( renderer.records.dispose === 1, 'renderer not disposed twice' );
		ok( geometryDisposed === 1, 'geometry not disposed twice' );

	} );

	// ---------------------------------------------------------------------
	test( 'resize/resume/render after destroy are no-ops', () => {

		const container = makeContainer( 500, 400 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, { renderer } );

		view.destroy();

		const setSizeCalls = renderer.records.setSize.length;
		const renderCalls = renderer.records.render;

		setContainerSize( container, 900, 700 );
		view.resize();
		view.resume();
		view.pause();
		view.render();

		ok( renderer.records.setSize.length === setSizeCalls, 'resize does not touch renderer after destroy' );
		ok( renderer.records.render === renderCalls, 'render is a no-op after destroy' );
		ok( scheduler.pendingCount() === 0, 'no frame requested after destroy' );
		ok( container.children.length === 0, 'no canvas re-attached after destroy' );
		ok( scheduler.flushNext() === false, 'no frame to flush after destroy' );

	} );

	// ---------------------------------------------------------------------
	test( 'explicit resize dimensions and start/stop aliases', () => {

		const container = makeContainer( 0, 0 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, { renderer, autoStart: false } );

		try {

			// Container is empty, but explicit dimensions are authoritative.
			view.resize( 1280, 720 );
			ok( renderer.records.setSize.length === 1, 'explicit size applied' );
			ok( renderer.records.setSize[ 0 ][ 0 ] === 1280 && renderer.records.setSize[ 0 ][ 1 ] === 720, 'explicit size forwarded' );
			near( view.camera.aspect, 1280 / 720, 'aspect from explicit size' );
			ok( scheduler.pendingCount() === 0, 'still paused after explicit resize' );

			// Non-positive explicit dimensions fall back to measuring the container.
			view.resize( 0, 0 );
			ok( renderer.records.setSize.length === 1, 'invalid explicit size falls back to zero container -> skipped' );

			view.start();
			ok( view.running === true && scheduler.pendingCount() === 1, 'start() resumes exactly one frame' );
			view.stop();
			ok( view.running === false && scheduler.pendingCount() === 0, 'stop() pauses' );

			view.dispose();
			ok( view.destroyed === true, 'dispose() aliases destroy()' );

		} finally {

			view.destroy();

		}

	} );

	// ---------------------------------------------------------------------
	test( 'repeated resize while running never stacks frames', () => {

		const container = makeContainer( 200, 200 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, { renderer, autoStart: false } );

		try {

			view.resume();
			ok( scheduler.pendingCount() === 1, 'one frame after resume' );

			setContainerSize( container, 400, 300 );
			view.resize();
			ok( scheduler.pendingCount() === 1, 'resize does not add a second frame' );

			view.resize();
			view.resize();
			ok( scheduler.pendingCount() === 1, 'three resizes still leave one frame' );

			ok( scheduler.flushNext() === true, 'frame flushes' );
			ok( scheduler.pendingCount() === 1, 'only the loop successor is pending' );

		} finally {

			view.destroy();

		}

	} );

	// ---------------------------------------------------------------------
	test( 'creation options can supply explicit size for an empty container', () => {

		const container = makeContainer( 0, 0 );
		const renderer = makeRenderer();
		const view = THREE.createViewController( container, {
			renderer,
			width: 800,
			height: 400,
			autoStart: false
		} );

		try {

			ok( renderer.records.setSize.length === 1, 'explicit creation size applied' );
			ok( renderer.records.setSize[ 0 ][ 0 ] === 800 && renderer.records.setSize[ 0 ][ 1 ] === 400, 'size values forwarded' );
			near( view.camera.aspect, 2, 'aspect from explicit creation size' );
			ok( view.size && view.size.width === 800, 'size recorded' );

			// Explicit resize after destroy must not reschedule frames.
			view.destroy();
			view.resize( 2000, 1000 );
			ok( renderer.records.setSize.length === 1, 'post-destroy resize is inert' );
			ok( scheduler.pendingCount() === 0, 'no frame requested post-destroy' );

		} finally {

			view.destroy();

		}

	} );

	return results;

}
