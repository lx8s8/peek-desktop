# Peek Desktop

使用 Tauri 2、Rust、React 19 与 TypeScript 开发的桌面网络检查器。当前提供可实际打开、查看和保存 `.peek` 文件的离线工作区，按方案继续推进 Windows 与 macOS 的实时设备连接和普通日志/异常预览。

架构与阶段安排见 [技术方案](docs/技术方案.md)，私有 Flutter SDK 设计见 [普通日志与异常同步方案](docs/普通日志与异常同步方案.md)，本次完成项、验证结果与剩余事项见 [实施进度](docs/实施进度.md)。

## 当前可用

- 原生文件对话框打开 `.peek`，后台按 JSON Lines 读取，显示进度并支持取消；失败或取消不添加部分会话。
- 会话侧栏、可调整三栏、TanStack 虚拟表格；Rust 搜索地址/方法/状态/来源，过滤错误、进行中、已固定记录。
- 按需获取请求元信息、Headers、请求与响应正文；重复 Headers 分开显示，二进制提供 Hex 摘要，未采集、未加载与截断各有说明。
- JSON 原文、只读树、格式化与复制；Worker 分析 JSON，`lossless-json` 保留长整数/小数精度，`vanilla-jsoneditor` 懒加载并在卸载时销毁。
- 保存网络会话为标准 `.peek`；原始有效记录行用于无损导出，临时文件写入成功后原子替换目标。
- 简体中文/英文、深浅主题、布局偏好保留；Cmd/Ctrl O 打开、Cmd/Ctrl S 保存、Cmd/Ctrl F 搜索，列表支持方向键、Home/End 和 PageUp/PageDown。

没有默认加载的假设备或假流量。当前不监听 `9741`，设备配对、WebSocket/mDNS、私有 SDK、日志/异常/时间线、HAR/cURL、`.peekbundle`、完整原生菜单与双平台发布均待后续阶段。

## 本地开发

需要 Node.js >= 22.12、pnpm 10.33.0、Rust >= 1.91，以及所在平台的 [Tauri 构建工具](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` 仅在 `http://127.0.0.1:1430` 预览前端，文件操作需要 Tauri 桌面环境。可通过原生“打开文件”选择 `src-tauri/tests/fixtures/upstream/sessions/basic.peek` 查看固定上游样例。

## 数据与容量

Rust 保留权威会话与原始记录；UI 只查询当前窗口（最多 300 行预读，接口硬上限 500 行），选择记录后才查询详情和正文。

单文件最大 64 MiB、单行最大 8 MiB、每会话最多 100,000 条不同 ID；同时最多 4 个会话、128 MiB 保留原文。超过上限会拒绝本次导入。这是原文预算，索引、摘要、解析临时对象和 WebView 仍有额外内存开销。关闭会话释放其保留数据，退出应用不自动保存会话。

文件头必须有效；正常坏行跳过并计数，重复 ID 采用最后值并保留首次位置，更新格式版本尽量读取并提示。保存时统一 LF 换行，不保留空行、坏行与旧的重复 ID 版本；有效记录中的未知字段、重复 JSON key 和数字原文均保留。

文本/表单正文预览最多 1 MiB，二进制最多显示 4 KiB Hex；预览限制与设备采集截断分别提示。大正文可通过保存会话保留文件中已有的内容，`remote` 正文在离线文件中无法取回。树视图受大小、节点数与深度限制；无效 JSON 保留原文。HTML、SVG 与其他响应内容作为数据展示，不执行网页。

## 验证与本地打包

```bash
pnpm check
pnpm test
pnpm build
pnpm format:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm tauri build --debug --bundles app
```

2026 年 11 月 13 日本机 macOS 已通过前端检查/测试/构建、Rust 测试/格式/Clippy 和原生 `.app` 编译；实际窗口验证了官方样例导入、过滤、Headers/JSON、主题语言、保存回读与十万条合成会话。Windows 构建、真实设备互操作和完整性能矩阵尚未验收。

JSON 编辑器约 1 MiB 的懒加载 chunk 仍会触发 Vite 大包提示；它不随空工作区加载，后续需继续评估组件拆分和实际 WebView 开销。

## 可复现合成输入

生成命令拒绝覆盖已有文件；所有请求均使用合成域名与数据。可分别生成 10,000 与 100,000 条输入，然后在桌面打开，或运行 Rust 核心探针：

```bash
node scripts/generate-session.mjs /tmp/peek-10k.peek 10000
node scripts/generate-session.mjs /tmp/peek-100k.peek 100000
cargo run --locked --manifest-path src-tauri/Cargo.toml --example session_probe -- /tmp/peek-100k.peek
```

探针只测本地导入和 20 次窗口搜索，不代表实时消息吞吐、WebView 帧率、总进程内存或 release 性能。

当前名称、`local.peek.desktop` 标识与脚手架图标用于本地开发，尚未配置远程仓库或发布流程。
