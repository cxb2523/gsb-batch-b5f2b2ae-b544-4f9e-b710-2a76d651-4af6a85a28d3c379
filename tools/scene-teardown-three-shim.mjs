/* Node 检查用：three 的垫片。真实的几何/材质/场景类全部转发给 vendor/three，
 * 只把 WebGLRenderer 换成不碰 WebGL 的假实现（Node 里没有 GL 上下文）。
 * 副作用：几何体 / 材质 / 纹理的 dispose() 走真实实现，检查脚本可据此直接断言。 */
export * from '../vendor/three/three.module.js';

export class WebGLRenderer {
  constructor(params) {
    this.domElement = (params && params.canvas) || null;
    this.disposed = false;
    this.info = { render: { calls: 0, triangles: 0 } };
    this._size = { width: 1, height: 1 };
  }
  setPixelRatio() {}
  setClearColor() {}
  setSize(w, h) {
    this._size.width = w;
    this._size.height = h;
    if (this.domElement) { this.domElement.width = w; this.domElement.height = h; }
  }
  render() { this.info.render.calls = 1; }
  dispose() { this.disposed = true; }
}
