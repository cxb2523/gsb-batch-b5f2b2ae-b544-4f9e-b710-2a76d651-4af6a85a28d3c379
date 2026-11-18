
# Three.js bundled with OrbitControls

Vanilla [Three.js](https://github.com/mrdoob/three.js) including basic controls. If that is all you need, you can link directly to this build in your web pages:

`<script src="https://cdn.jsdelivr.net/gh/paulmasson/threejs-with-controls@r121/build/three.min.js"></script>`

The steps to create this build from a [stable](https://github.com/mrdoob/three.js/issues/20591) tagged version are

* Edit the version number of `three` in `package.json` to indicate the desired version. These numbers are of the form `0.nnn.n`, where the last digit reflects possible modifications after the first release. Available versions can be displayed with `npm show three versions`.

* Configure the library with `npm install`.

* Build the library with `npm run build`.

The minified file will be located in the `build` directory.

If you need additional features, then simply add the appropriate `export` lines to `Three.js` and build the library yourself.

## View controller

The build also exposes a small reusable view controller under the `THREE`
namespace. It owns the renderer, scene, perspective camera, `OrbitControls`
instance and the animation loop, so pages no longer have to wire those up (or
tear them down) by hand.

```html
<div id="view" style="width: 640px; height: 360px"></div>

<script src="build/three.min.js"></script>
<script>
  const view = THREE.createViewController('#view', {
    camera: { fov: 45, position: [0, 2, 6], target: [0, 0, 0] },
    clearColor: 0xf0f0f0,
    controlsOptions: { enableDamping: true }
  });

  view.scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x3366cc })
  ));
  view.scene.add(new THREE.AmbientLight(0xffffff, 1));

  view.resize();   // call from a ResizeObserver / window resize
  view.pause();    // stop requesting animation frames
  view.resume();   // restart with exactly one animation frame
  view.destroy();  // cancel frames, drop listeners, free GPU resources
</script>
```

API summary:

| Member | Description |
| --- | --- |
| `createViewController(container, options)` | `container` is an element or CSS selector. Also exported as `createView` / `createViewer`. |
| `options.camera` | `fov`, `near`, `far`, `aspect`, `position`, `up`, `lookAt`, `zoom`, `target`. A camera instance is accepted directly. Flat top-level camera keys also work. |
| `options.rendererOptions` / `options.renderer` | Options for `WebGLRenderer`, or a pre-made renderer (useful for tests). |
| `options.pixelRatio`, `options.clearColor`, `options.autoStart` | Applied at creation. `autoStart: false` starts paused. |
| `.resize(width?, height?)` | Measures the container, updates camera aspect and renderer size. Explicit positive `width`/`height` override measurement. Zero-sized containers are skipped silently and the previous size stays in effect. |
| `.pause()` / `.resume()` | `pause` cancels the pending frame; `resume` re-applies the newest resize and schedules exactly one frame. Interleaving resize and pause/resume preserves the latest size. Aliases: `.stop()` / `.start()`. |
| `.destroy()` | Cancels the frame, disposes `OrbitControls`, frees scene geometries/materials/textures and the renderer, detaches the canvas. Idempotent; later `resize`/`resume`/`pause`/`render` calls are no-ops. Alias: `.dispose()`. |
| `.render()` | Renders one frame immediately without touching loop state. |
| `.running`, `.paused`, `.destroyed`, `.size` | Read-only state. |

The existing `THREE` and `THREE.OrbitControls` exports are unchanged.

## Verification

The repository ships an environment-agnostic suite (fake DOM + fake renderer)
plus a real-WebGL browser smoke test:

```
npm run build
npm run verify          # Node, loads build/three.min.js in a vm sandbox
npm run verify:browser  # headless Chrome/Edge (set CHROME_PATH if needed)
```

`verify/browser.html`, `verify/browser-webgl.html` and `verify/suite.js` can
also be opened directly through any static file server. Each page sets
`document.title` to `VERIFY-OK …` or `VERIFY-FAIL …` and dumps results into a
`<pre id="dump">` element for headless runners.


As a check on the process, one can view the recent [history](https://paulmasson.github.io/build-size-history.html) of the size of the final build file.

Live examples using this build via [MathCell](https://github.com/paulmasson/mathcell):

[Bourke Harmonics](https://paulmasson.github.io/mathcell/docs/examples/bourke-harmonics.html)<br>
[Cardinal Sine Function](https://paulmasson.github.io/mathcell/docs/examples/cardinal-sine-3d.html)<br>
[Hyperbolic Helicoid](https://paulmasson.github.io/mathcell/docs/examples/hyperbolic-helicoid.html)<br>
[Schwarz Primitive Surface](https://paulmasson.github.io/mathcell/docs/examples/schwarz-primitive-surface.html)<br>
[Umbilic Torus](https://paulmasson.github.io/mathcell/docs/examples/umbilic-torus.html)


