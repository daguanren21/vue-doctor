# 性能与分析会话

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./performance.md)

至少有 512 个源码文件且未缓存源码达到 1 MB 时，Doctor Run 会使用有界 Piscina worker pool 并行解析。每个文件的分析结果和带版本的组件 contract 会写入操作系统用户缓存；后续 CLI、Inspector、构建工具和 `--changed` 运行会直接复用未变化文件。缓存 key 包含源码内容、文件路径、Vue 版本、package 版本与 contract evidence 内容。声明缓存还会验证 TypeScript 实际读取的文件、传递声明、配置和模块解析 probe；输入变化后重新分析。无法可靠验证的本地包或链接包跳过持久契约缓存，不同调用方拿到的结果相互隔离。

冷启动测试可设置 `VUE_DOCTOR_DISABLE_CACHE=1`。高级 CI 调优可使用 `VUE_DOCTOR_MAX_THREADS`、`VUE_DOCTOR_PARALLEL_THRESHOLD` 和 `VUE_DOCTOR_PARALLEL_MIN_BYTES`；默认最多 4 个 worker、512 个文件，并要求至少 1 MB 未缓存源码才启动 worker。

构建 adapter 和 CLI Inspector 各自持有分析会话。同一代的并发请求共享正在运行的分析，文件变化进入新一代；较早的响应不会覆盖较新的 Inspector 结果。会话复用有容量限制、按内容指纹索引的源码事实和惰性 worker pool，并在宿主关闭时释放。每次显式重新扫描都会加载配置并验证契约依赖。

自定义宿主可使用相同生命周期：

```ts
import { createDoctorAnalysisSession } from 'vue-doctor'

const session = createDoctorAnalysisSession({ root: '/path/to/project', scope: 'src' })
try {
  const report = await session.run()
  session.invalidate('src/App.vue')
  const updated = await session.run()
  console.log(report.run, updated.run, session.getStats())
} finally {
  await session.close()
}
```

运行计时和缓存计数通过 `getStats()` 获取，不写入报告。
