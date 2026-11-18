import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const DEFAULTS = {
	fov: 50,
	near: 0.1,
	far: 2000,
	position: [ 0, 0, 5 ],
	up: [ 0, 1, 0 ]
};

const isFiniteNumber = ( value ) => typeof value === 'number' && Number.isFinite( value );

function currentTime() {

	if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) return performance.now();
	return Date.now();

}

/**
 * Schedules one animation frame. Resolved at call time so tests (or a host
 * page) can provide their own requestAnimationFrame implementation. When no
 * implementation exists (plain Node) we fall back to a timer so the controller
 * still has a well-defined start/stop behaviour.
 *
 * @param {Function} callback
 * @return {{ id: *, type: 'raf'|'timeout' }}
 */
function requestFrame( callback ) {

	if ( typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function' ) {

		return { id: globalThis.requestAnimationFrame( callback ), type: 'raf' };

	}

	const id = setTimeout( () => callback( currentTime() ), 16 );
	if ( id && typeof id.unref === 'function' ) id.unref();
	return { id, type: 'timeout' };

}

function cancelFrame( handle ) {

	if ( ! handle ) return;

	if ( handle.type === 'raf' ) {

		if ( typeof globalThis.cancelAnimationFrame === 'function' ) globalThis.cancelAnimationFrame( handle.id );

	} else {

		clearTimeout( handle.id );

	}

}

function resolveContainer( container ) {

	if ( typeof container === 'string' ) {

		if ( typeof document === 'undefined' || ! document ) return null;
		return document.querySelector( container );

	}

	return container || null;

}

/**
 * Reads the container's current content size. Returns null when either
 * dimension is zero (or cannot be measured), which callers treat as "skip".
 *
 * @param {HTMLElement} container
 * @return {{ width: number, height: number }|null}
 */
function measureContainer( container ) {

	if ( ! container ) return null;

	let width = 0;
	let height = 0;

	if ( typeof container.getBoundingClientRect === 'function' ) {

		try {

			const rect = container.getBoundingClientRect();
			if ( rect ) {

				width = Number( rect.width );
				height = Number( rect.height );

			}

		} catch ( error ) {

			// A container without layout support is handled by the fallbacks below.

		}

	}

	if ( ! ( width > 0 ) && typeof container.clientWidth === 'number' ) width = container.clientWidth;
	if ( ! ( height > 0 ) && typeof container.clientHeight === 'number' ) height = container.clientHeight;
	if ( ! ( width > 0 ) && typeof container.offsetWidth === 'number' ) width = container.offsetWidth;
	if ( ! ( height > 0 ) && typeof container.offsetHeight === 'number' ) height = container.offsetHeight;

	if ( ! isFiniteNumber( width ) || ! isFiniteNumber( height ) || width <= 0 || height <= 0 ) return null;

	return { width, height };

}

function toVector3( value ) {

	if ( Array.isArray( value ) || ArrayBuffer.isView( value ) ) {

		return new Vector3( value[ 0 ] || 0, value[ 1 ] || 0, value[ 2 ] || 0 );

	}

	if ( value && isFiniteNumber( value.x ) ) {

		return new Vector3( value.x, value.y || 0, value.z || 0 );

	}

	return null;

}

function applyVector3( target, value, fallback ) {

	if ( ! target || typeof target.set !== 'function' ) return;

	const vector = toVector3( value ) || toVector3( fallback );
	if ( vector ) target.set( vector.x, vector.y, vector.z );

}

function resolvePixelRatio( value ) {

	if ( isFiniteNumber( value ) && value > 0 ) return value;

	if ( typeof globalThis !== 'undefined' && isFiniteNumber( globalThis.devicePixelRatio ) && globalThis.devicePixelRatio > 0 ) {

		return globalThis.devicePixelRatio;

	}

	return 1;

}

const CAMERA_KEYS = [ 'fov', 'near', 'far', 'aspect', 'position', 'up', 'lookAt', 'zoom', 'target' ];

function hasCameraKeys( options ) {

	for ( const key of CAMERA_KEYS ) if ( key in options ) return true;
	return false;

}

function createCamera( container, cameraOptions ) {

	if ( cameraOptions && cameraOptions.isCamera ) return cameraOptions;

	const options = cameraOptions || {};
	const explicitSize = ( isFiniteNumber( options.width ) && options.width > 0 && isFiniteNumber( options.height ) && options.height > 0 )
		? { width: options.width, height: options.height }
		: null;
	const size = explicitSize || measureContainer( container );
	const aspect = size
		? size.width / size.height
		: ( isFiniteNumber( options.aspect ) && options.aspect > 0 ? options.aspect : 1 );

	const camera = new PerspectiveCamera(
		isFiniteNumber( options.fov ) ? options.fov : DEFAULTS.fov,
		aspect,
		isFiniteNumber( options.near ) ? options.near : DEFAULTS.near,
		isFiniteNumber( options.far ) ? options.far : DEFAULTS.far
	);

	applyVector3( camera.position, options.position, DEFAULTS.position );
	applyVector3( camera.up, options.up, DEFAULTS.up );

	if ( isFiniteNumber( options.zoom ) && options.zoom > 0 ) camera.zoom = options.zoom;

	const lookAt = toVector3( options.lookAt );
	if ( lookAt ) camera.lookAt( lookAt );

	camera.updateProjectionMatrix();

	return camera;

}

function disposeScene( scene ) {

	if ( ! scene || typeof scene.traverse !== 'function' ) return;

	const geometries = new Set();
	const materials = new Set();

	scene.traverse( ( object ) => {

		if ( object.geometry ) geometries.add( object.geometry );

		const material = object.material;
		if ( Array.isArray( material ) ) {

			for ( const entry of material ) if ( entry ) materials.add( entry );

		} else if ( material ) {

			materials.add( material );

		}

	} );

	const textures = new Set();

	for ( const material of materials ) {

		try {

			for ( const value of Object.values( material ) ) {

				if ( ! value ) continue;

				if ( value.isTexture ) {

					textures.add( value );

				} else if ( Array.isArray( value ) ) {

					for ( const entry of value ) if ( entry && entry.isTexture ) textures.add( entry );

				}

			}

		} catch ( error ) {

			// Ignore materials with non-enumerable/hostile property access.

		}

		if ( typeof material.dispose === 'function' ) {

			try {

				material.dispose();

			} catch ( error ) { /* disposal is best effort */ }

		}

	}

	if ( scene.background && scene.background.isTexture ) textures.add( scene.background );

	for ( const geometry of geometries ) {

		if ( typeof geometry.dispose === 'function' ) {

			try {

				geometry.dispose();

			} catch ( error ) { /* disposal is best effort */ }

		}

	}

	for ( const texture of textures ) {

		if ( typeof texture.dispose === 'function' ) {

			try {

				texture.dispose();

			} catch ( error ) { /* disposal is best effort */ }

		}

	}

}

/**
 * Creates a self-contained Three.js view: renderer, scene, perspective camera
 * and OrbitControls, together with a resize/pause/resume/destroy lifecycle.
 *
 * @param {HTMLElement|string} container - Element (or selector) that receives the canvas.
 * @param {Object} [options]
 * @param {Object} [options.camera] - Perspective camera parameters: fov, near, far,
 *   aspect, position, up, lookAt, zoom, target. A camera instance is accepted too.
 * @param {Object} [options.rendererOptions] - Options passed to WebGLRenderer.
 * @param {THREE.WebGLRenderer} [options.renderer] - Existing renderer instance.
 * @param {Function} [options.createRenderer] - Factory `(options, container) => renderer`.
 * @param {number} [options.pixelRatio] - Defaults to devicePixelRatio (or 1).
 * @param {number|string} [options.clearColor] - Passed to renderer.setClearColor.
 * @param {number} [options.clearAlpha=1]
 * @param {boolean} [options.autoStart=true] - Start the render loop immediately.
 * @param {Object} [options.controlsOptions] - Properties applied to OrbitControls.
 * @param {THREE.Scene} [options.scene] - Existing scene.
 * @return {Object} controller API
 */
export function createViewController( container, options = {} ) {

	const targetContainer = resolveContainer( container );

	if ( ! targetContainer ) {

		throw new TypeError( 'createViewController: a container element (or selector) is required' );

	}

	const opts = options || {};

	// Accept both `{ camera: { fov, ... } }` and flattened camera options.
	const cameraOptions = opts.camera || ( hasCameraKeys( opts ) ? opts : {} );
	const camera = createCamera( targetContainer, cameraOptions );
	const scene = opts.scene || new Scene();

	const rendererOptions = opts.rendererOptions || {};
	const renderer = opts.renderer || (
		typeof opts.createRenderer === 'function'
			? opts.createRenderer( rendererOptions, targetContainer )
			: new WebGLRenderer( rendererOptions )
	);

	if ( ! renderer ) {

		throw new TypeError( 'createViewController: renderer creation failed' );

	}

	if ( typeof renderer.setPixelRatio === 'function' ) {

		renderer.setPixelRatio( resolvePixelRatio( opts.pixelRatio ) );

	}

	if ( opts.clearColor !== undefined && typeof renderer.setClearColor === 'function' ) {

		renderer.setClearColor( opts.clearColor, opts.clearAlpha === undefined ? 1 : opts.clearAlpha );

	}

	if ( renderer.domElement && typeof targetContainer.appendChild === 'function' ) {

		targetContainer.appendChild( renderer.domElement );

	}

	const controls = opts.controls || new OrbitControls( camera, renderer.domElement );

	if ( opts.controlsOptions ) {

		for ( const key of Object.keys( opts.controlsOptions ) ) {

			if ( key === 'target' ) continue;
			controls[ key ] = opts.controlsOptions[ key ];

		}

	}

	const target = toVector3( opts.controlsOptions && opts.controlsOptions.target )
		|| toVector3( cameraOptions.target )
		|| toVector3( opts.target );

	if ( target && controls.target && typeof controls.target.copy === 'function' ) {

		controls.target.copy( target );

	}

	if ( typeof controls.update === 'function' ) controls.update();

	let size = null;
	let paused = opts.autoStart === false;
	let destroyed = false;
	let frame = null;

	function applySize( width, height ) {

		if ( camera.isPerspectiveCamera ) camera.aspect = width / height;
		if ( typeof camera.updateProjectionMatrix === 'function' ) camera.updateProjectionMatrix();
		if ( typeof renderer.setSize === 'function' ) renderer.setSize( width, height );

	}

	function scheduleFrame() {

		if ( destroyed || paused || frame !== null ) return;
		frame = requestFrame( onFrame );

	}

	function cancelScheduledFrame() {

		if ( frame === null ) return;
		cancelFrame( frame );
		frame = null;

	}

	function onFrame() {

		frame = null;
		if ( destroyed || paused ) return;

		if ( typeof controls.update === 'function' ) controls.update();
		if ( typeof renderer.render === 'function' ) renderer.render( scene, camera );

		scheduleFrame();

	}

	const initialSize = ( isFiniteNumber( opts.width ) && opts.width > 0 && isFiniteNumber( opts.height ) && opts.height > 0 )
		? { width: opts.width, height: opts.height }
		: measureContainer( targetContainer );

	if ( initialSize ) {

		size = initialSize;
		applySize( initialSize.width, initialSize.height );

	}

	const api = {

		container: targetContainer,
		renderer,
		scene,
		camera,
		controls,

		get paused() {

			return paused;

		},

		get destroyed() {

			return destroyed;

		},

		get running() {

			return ! paused && ! destroyed && frame !== null;

		},

		get size() {

			return size ? { width: size.width, height: size.height } : null;

		},

		/**
		 * Measures the container and updates camera aspect + renderer size.
		 * Zero-sized containers are ignored without throwing; the previous size
		 * stays in effect and no frame is requested.
		 *
		 * Explicit `width`/`height` arguments are honoured when both are positive
		 * finite numbers; otherwise the container is measured.
		 *
		 * @param {number} [width]
		 * @param {number} [height]
		 */
		resize( width, height ) {

			if ( destroyed ) return api;

			const measured = ( isFiniteNumber( width ) && width > 0 && isFiniteNumber( height ) && height > 0 )
				? { width, height }
				: measureContainer( targetContainer );

			if ( ! measured ) return api;

			size = measured;
			applySize( measured.width, measured.height );
			scheduleFrame();

			return api;

		},

		/**
		 * Stops the render loop. Cancels the pending frame and prevents new ones.
		 */
		pause() {

			if ( destroyed ) return api;

			paused = true;
			cancelScheduledFrame();

			return api;

		},

		/**
		 * Resumes the render loop, re-applying the most recent resize before
		 * scheduling exactly one frame. Safe to call while already running.
		 */
		resume() {

			if ( destroyed ) return api;

			if ( ! paused ) {

				scheduleFrame();
				return api;

			}

			paused = false;
			if ( size ) applySize( size.width, size.height );
			scheduleFrame();

			return api;

		},

		/**
		 * Renders a single frame immediately (does not affect the loop state).
		 */
		render() {

			if ( destroyed ) return api;

			if ( typeof controls.update === 'function' ) controls.update();
			if ( typeof renderer.render === 'function' ) renderer.render( scene, camera );

			return api;

		},

		/**
		 * Tears the view down. Cancels any pending frame, disconnects controls,
		 * disposes scene geometry/material/texture GPU resources and the renderer.
		 * Idempotent; late resize/resume/pause/render calls become no-ops.
		 */
		destroy() {

			if ( destroyed ) return api;

			destroyed = true;
			paused = true;
			cancelScheduledFrame();

			if ( controls ) {

				if ( typeof controls.dispose === 'function' ) {

					try {

						controls.dispose();

					} catch ( error ) { /* disposal is best effort */ }

				}

				controls.enabled = false;

			}

			disposeScene( scene );

			if ( renderer ) {

				const domElement = renderer.domElement;

				if ( typeof renderer.dispose === 'function' ) {

					try {

						renderer.dispose();

					} catch ( error ) { /* disposal is best effort */ }

				}

				if ( typeof renderer.forceContextLoss === 'function' ) {

					try {

						renderer.forceContextLoss();

					} catch ( error ) { /* optional API */ }

				}

				if ( domElement && domElement.parentNode && typeof domElement.parentNode.removeChild === 'function' ) {

					try {

						domElement.parentNode.removeChild( domElement );

					} catch ( error ) { /* already detached */ }

				}

			}

			return api;

		}

	};

	// Convenience aliases mirroring the render-loop vocabulary.
	api.start = api.resume;
	api.stop = api.pause;
	api.dispose = api.destroy;

	if ( ! paused ) scheduleFrame();

	return api;

}

export const createView = createViewController;
export const createViewer = createViewController;
