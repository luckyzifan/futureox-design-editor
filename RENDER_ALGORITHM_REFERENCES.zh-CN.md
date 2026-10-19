# 算法与开源实现参考

核对日期：2026-10-19。以下是公开一手资料及本项目适用边界。仅作设计与审查参考，本轮没有复制外部实现，也没有把论文/项目性能数字当成本项目实测。

## 地图瓦片与交互调度

- [Leaflet GridLayer 文档](https://leafletjs.com/reference.html#gridlayer-updatewhenzooming)：支持平滑缩放期间不逐级更新、结束再更新，并提供平移更新间隔。参考其“相机动画与数据更新分离”；设计器结束后仍需当前设备密度的矢量精绘，不能照搬 maxNativeZoom 位图放大作为最终结果。
- [Leaflet GridLayer 源码](https://github.com/Leaflet/Leaflet/blob/main/src/layer/tile/GridLayer.js)：用于检查网格生命周期和缩放状态组织；链接为可变 main 分支，不作为不可变上游版本。
- [MapLibre Map API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#cancelpendingtilerequestswhilezooming)：明确提供取消缩放中旧层级待加载瓦片的策略，并说明细节出现平滑度与额外计算量之间的取舍。借鉴取消过期工作，不取消有序文档变更。
- [OpenLayers TileQueue 源码](https://raw.githubusercontent.com/openlayers/openlayers/main/src/ol/TileQueue.js)：以当前 wantedTiles 排除无用工作，以层级和距离排列优先级，同时限制总并发与每次新增请求。本项目视口优先仍须保留遮罩、模糊、阴影等屏外依赖，不能机械丢弃所有屏外节点。

## 曲线与 GPU 路径渲染

- [Raph Levien：Flattening quadratic Béziers，2019-12-23](https://raphlinus.github.io/graphics/curves/2019/12/23/flatten-quadbez.html)：分析曲率与折线逼近误差、按容差估计细分数。适用于检查设备空间误差和缩放容差；退化/拐点/三次曲线及描边仍要独立验证，不能把局部近似直接当全局证明。
- [GPU-accelerated Path Rendering 论文](https://developer.download.nvidia.com/devzone/devcenter/gamegraphics/files/opengl/gpupathrender.pdf)：讨论 GPU 上的填充与描边路径处理，包括二次/三次曲线及椭圆弧。其技术背景与本项目 WebGPU 后端不同，参考几何与覆盖问题分解，不直接承诺迁移收益。
- [Vello 项目](https://github.com/linebender/vello)及[架构文档](https://github.com/linebender/vello/blob/main/ARCHITECTURE.md)：提供 CPU SIMD、多线程、GPU 光栅化/合成及计算着色器的不同实现路线。当前文档中的 Sparse Strips 将路径分箱、稀疏保存边界覆盖，值得评估中间表面占用；不能据此认定替换整个渲染器即可保留本项目颜色、效果、文本及文件兼容语义。

## 使用与许可边界

本轮没有新增上述库依赖或复制其源码。Vello 项目说明主代码可选 MIT 或 Apache-2.0，素材有独立许可；后续实际引入时仍必须按所选版本、文件和资产逐项核对。其它项目也必须在复制/引入前检查对应版本许可证及声明义务。文献公开可读不意味着可任意复制其代码或图像。
