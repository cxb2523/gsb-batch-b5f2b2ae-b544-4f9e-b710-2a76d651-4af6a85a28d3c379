/* Node 检查用：把 import 'three' 指到带假 WebGLRenderer 的垫片。
 * 浏览器里 scene.js import 的是 vendor/three/three.module.js（经 importmap）。 */
export async function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: new URL('./scene-teardown-three-shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
