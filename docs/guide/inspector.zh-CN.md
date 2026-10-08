# Inspector

[快速上手](../../README.zh-CN.md) · [文档索引](./README.zh-CN.md) · [English](./inspector.md)

## 启动 Inspector

需要在浏览器中查看结果时，使用 `--inspect`：

```bash
vue-doctor --inspect
```

Vue Doctor 会运行检查，在 loopback interface 上启动 Inspector，使用默认浏览器打开页面，并在终端输出 URL。Inspector 可用期间进程会保持运行；在终端按 `Ctrl+C` 即可停止。

Inspector 和它的报告 endpoint 只由这个本地进程提供，不是应用路由，也不会进入应用 bundle。

## 视图与重新扫描

Inspector 由 Hub UI 承载一个 Doctor 工作区，包含诊断、覆盖率、规则和审计四个视图。诊断与证据按需加载；搜索覆盖完整报告，每页返回 100 条诊断。四个视图读取同一份不可变快照，浏览、筛选和翻页不会触发扫描。点击“重新扫描”才会请求新的分析；扫描失败时仍可查看上一次完成的报告。审计页展示已应用、无效和未命中的局部抑制指令，保留原因及原诊断。

在诊断旁选择 VS Code、Cursor 或 WebStorm，点击**打开源码**跳转到对应位置。

### 搜索、筛选与键盘操作

- 诊断支持组合搜索、严重程度、领域、置信度、规则、依赖包与可选建议。窄屏点击**筛选**可展开相同的控件，按钮上的数字表示已启用的筛选条件。**清除筛选**恢复完整结果，并把焦点移回搜索框。
- 规则页提供独立搜索和执行状态筛选。选中规则可查看已有元数据与诊断数量；“已检查且零诊断”不等同于规则不可用或已禁用。
- 未在文本框输入时按 `/` 聚焦当前视图的搜索框。诊断和规则列表支持上/下方向键，规则列表还支持 Home/End。详情标签页支持左/右方向键与 Home/End。
- 顶栏可切换语言和深浅主题。初始主题跟随系统，手动选择后会记住偏好。图标随本地 UI 一起打包，不依赖外部图标服务。

浏览期间始终保留覆盖不完整提示，即使当前筛选没有匹配诊断。请先查看覆盖率，再判断空结果是否意味着检查干净。

## 宿主接入

安装 Vite DevTools 宿主时，同一个 Doctor 工作区会注册到宿主中；没有宿主时，Vite 在 `/vue-doctor/` 提供独立 Inspector。CLI Inspector 也支持 Vue CLI 与已有报告，无须在消费项目中安装 Vite。原 JSON 报告接口继续供本地集成使用；配置分析 provider 时，访问这个兼容接口仍会刷新报告。旧报告、源码片段和编辑器接口只接受同源 loopback 请求；远程宿主通过带认证的 Doctor 工作区访问。

## Git 归属信息

源码 evidence 带行号且项目位于 Git repository 时，Doctor Run 会附上该行最近一次提交的作者、commit、提交时间和 summary。Inspector 把这组信息放在源码片段旁边，方便把诊断交给熟悉该行代码的开发者。报告不包含 author email；未跟踪文件、缺少历史或 Git 命令失败时不填归属信息，也不会阻断诊断。如果不希望收集提交人姓名或把 commit summary 写入 CI report，可以在 Doctor config 中设置 `gitAttribution: false`。
