# 换局（重新拖入 `.wrpl`）拆除说明

工具页每拖入一份新回放都会走 `window.ACEUI.mount()` → `ACEScene.init(canvas, data)`。
`init` 在装载新数据**之前**调用 `teardownRound()`，把上一局完整拆掉；首次 `init`
时它是空操作。本文说明拆掉了什么、怎么自动验证、以及如何用两份本地回放手工验收。

## 拆掉了什么

| 类别 | 处理 | 统计字段（`getStats().teardown`） |
|---|---|---|
| 场景对象 | 从 `scene` 逐个 `remove()`，再按树 `dispose` | `objects` |
| 几何体 | `BufferGeometry.dispose()`（共享几何体只释放一次） | `geometries` |
| 材质 | `Material.dispose()`；同时释放材质上挂的贴图 | `materials` |
| 纹理 | `Texture.dispose()`（陆地掩膜、地图外框渐变） | `textures` |
| 标签层 | 摘掉 `.ac-labels` 容器并清空文本；清空 `state.labels` | `labelBoxes` / `labels` |
| 按单位缓存 | 删除 `_series`（航迹序列）、`_valid`（有效点）、`_gaps`（断口）、`_wing`（翼展）、`_stepMed` | `unitCaches` |
| 轮次状态 | 击杀、导弹、地面方块、跑道/机场、高度标、陆地层、边界、镜头锚点、统计、图层开关 | — |

`InstancedMesh`（机体三角、地面方块）额外调用自身 `dispose()`，让渲染器解绑
`instanceMatrix` 缓冲。

### 幂等与"空局"

- 首次 `init`：`round === null`，拆除计数全 0，不抛错。
- 上一次 `init` 中途抛错：`round` 在创建 `Scene` 后立即登记，下一次 `init` 仍能拆掉残骸。
- 新局没有地形 / 导弹 / 击杀 / 跑道时对应图层**不创建**（`buildKills` 空列表直接返回），
  不会沿用旧对象；网格与外框按新局边界重建。
- 同一份数据重复 `init`：`getStats()`（除 `teardown` 外）与场景对象数、图层列表、
  地面方块实例数都与单次 `init` 一致。

### 实现位置

- `three3d/scene-gc.js`：纯工具（不 import three / DOM），Node 可直接测。
- `three3d/scene.js` 的 `teardownRound()` / `resetSceneState()` / `init()`。

## 自动检查（Node）

```bash
node tools/check-scene-teardown.mjs
```

脚本用**真实的** `three3d/scene.js`（渲染器由 `tools/scene-teardown-three-shim.mjs`
顶替，不建 WebGL 上下文）配合最小假 DOM / 假数据，验证：

1. 首次 `init` 不报错且拆除计数全 0；
2. 换第二份数据后：对象/几何体/材质/纹理被释放，旧标签层被摘掉、标签列表清空、
   按单位缓存被清掉；新局无地形/导弹/击杀/跑道时对应图层不存在；
3. 装回第一份数据后 `getStats()` 与首次 `init` 完全一致（除拆除计数），
   同一时刻地面方块实例数一致；
4. 连续 6 次换局后场景对象数不增长；
5. 空数据 / 无单位数据也不抛错；
6. `scene-gc` 的共享资源去重、重复拆除、缓存清理幂等。

CI（`.github/workflows/ci.yml`）已加入这一步。

## 手工验收（两份本地回放）

前提：仓库根目录起静态服务，工具页能正常拖入回放。

```bash
python -m http.server 8000
# 打开 http://localhost:8000/web/
```

准备两份**不同地图**的 `.wrpl`（例如一张带地形一张不带，或一局有导弹一局没有）。
如果手头只有一份，也可以先拖 A，再拖同一份 A —— 重复拖同一份也必须与单次一致。

1. **第一次拖入 A**：打开 DevTools Console，执行
   ```js
   ACEScene.getStats()
   ```
   记下 `teardown` 全 0、`labels` 与 `scene.objects`。
2. **拖入 B**（不同地图 / 无导弹）：
   - 旧标签必须立刻消失，屏幕上只剩 B 的标签；
   - 击杀 X、导弹白色虚线、地面方块若 B 没有，必须为空；
   - Console 里 `ACEScene.getStats().teardown.objects > 0`，
     `labelBoxes === 1`，`unitCaches > 0`；
   - `document.querySelectorAll('.ac-labels').length === 1`、
     `document.querySelectorAll('.ac-label').length` 等于 B 的标签数。
3. **再拖回 A**：`getStats()` 的 `units` / `labels` / `scene.objects` 应与第 1 步相同，
   `scene.layers` 恢复出 `contours` / `coast` / `landFill`（A 有地形时）。
4. **连续拖 3–5 局**：`scene.objects` 不应逐局增长（没有旧局对象残留）；
   Console 不应出现 `ACEScene.init 抛错` 或 WebGL 显存告警。
5. **画面抽查**：换局后按 `C` 切 follow/orbit/top/free，镜头不应朝上一局的地图中心漂移
   （`CAMS.lastT` 与锚点已重置）。

> 缓存指纹提示：改过 `three3d/scene.js` 后 `scene3d3-loader.js` 的 `NV` 必须 +1，
> 页面上的 `scene3d3-loader.js?v=` 也要同步 +1，否则浏览器会继续用缓存里的旧模块。
