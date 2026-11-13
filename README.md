# Peek Desktop

使用 Tauri 2、Rust、React 19 与 TypeScript 开发的桌面网络检查器。当前提供 `.peek` 文件工作区、真实设备配对、实时网络和私有 Flutter SDK 日志/异常同步；本机 macOS 已完成连接闭环，Windows 与真实移动设备仍待验证。

架构与阶段安排见 [技术方案](docs/技术方案.md)，私有 Flutter SDK 设计见 [普通日志与异常同步方案](docs/普通日志与异常同步方案.md)，P0 验证见 [实施进度](docs/实施进度.md)，当前连接闭环、验证结果与剩余事项见 [P1 实施记录](docs/P1实施记录.md)。

## 当前可用

- 原生文件对话框打开 `.peek`，后台按 JSON Lines 读取，显示进度并支持取消；失败或取消不添加部分会话。
- 会话侧栏、可调整三栏、TanStack 虚拟表格；Rust 搜索地址/方法/状态/来源，过滤错误、进行中、已固定记录。
- 按需获取请求元信息、Headers、请求与响应正文；重复 Headers 分开显示，二进制提供 Hex 摘要，未采集、未加载与截断各有说明。
- JSON 原文、只读树、格式化与复制；Worker 分析 JSON，`lossless-json` 保留长整数/小数精度，`vanilla-jsoneditor` 懒加载并在卸载时销毁。
- 保存网络会话为标准 `.peek`；原始有效记录行用于无损导出，临时文件写入成功后原子替换目标。
- 简体中文/英文、深浅主题、布局偏好保留；Cmd/Ctrl O 打开、Cmd/Ctrl S 保存、Cmd/Ctrl F 搜索，列表支持方向键、Home/End 和 PageUp/PageDown。

- 手动启停本机/局域网监听、可选 mDNS 发现；四位一次性配对码、系统凭据存储、网络和诊断独立授权、设备撤销。
- 标准 Peek WebSocket 历史快照、实时增删改、断线重连和正文按需取回；诊断日志与异常使用独立通道，展示原始堆栈、属性、累计确认、去重、缺口及淘汰计数。

没有默认加载的假设备或假流量，监听默认关闭。时间线、异常分组、HAR/cURL、`.peekbundle`、完整原生菜单与双平台发布继续按后续阶段推进。

## 连接设备

1. 在桌面“设备连接”中选择“仅本机”或“局域网设备”，启动监听；端口默认 `9741`，与前端开发端口无关。
2. 生成配对码。在官方 `peek_remote 2.1.1` 客户端填入桌面地址和四位码；同机示例使用 `127.0.0.1:9741`。配对码 180 秒失效，成功一次即失效。
3. 查看实时网络，选择请求后打开“响应”取回远端正文；保存 `.peek` 会保留已取回的正文，未取回的远端正文不能在离线文件中加载。
4. 普通日志需接入 [私有 Flutter SDK](packages/peek_desktop_bridge/README.md)，并在配对时允许诊断同步。SDK 复用同一个官方客户端的公开凭据，不再次配对。仓库提供 [macOS 合成数据示例](packages/peek_desktop_bridge/example/README.md)。
5. “关闭诊断”只断开日志通道；重新允许后在示例点击“重试日志连接”。“忘记设备”撤销两路授权。停止监听后已收到的数据仍可查看，离线后可关闭会话释放内存。

`.peek` 仅保存网络，日志目前保存在内存；退出桌面应用会丢失未导出的网络及所有诊断记录。完整诊断归档与持久恢复属于 P3。

## 本地开发

需要 Node.js >= 22.12、pnpm 10.33.0、Rust >= 1.91，以及所在平台的 [Tauri 构建工具](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` 仅在 `http://127.0.0.1:1430` 预览前端，文件操作需要 Tauri 桌面环境。可通过原生“打开文件”选择 `src-tauri/tests/fixtures/upstream/sessions/basic.peek` 查看固定上游样例。

## 数据与容量

Rust 保留权威会话与原始记录；UI 只查询当前窗口（最多 300 行预读，接口硬上限 500 行），选择记录后才查询详情和正文。

离线文件单文件最大 64 MiB、单行最大 8 MiB、每会话最多 100,000 条不同 ID；同时最多 4 个会话、128 MiB 保留原文。超过上限会拒绝本次导入。这是原文预算，索引、摘要、解析临时对象和 WebView 仍有额外内存开销。关闭会话释放其保留数据，退出应用不自动保存会话。

实时最多 8 个网络会话，各保留 10,000 条 / 8 MiB 原文，重同步 staging 使用独立同等预算；诊断最多 8 个运行，各保留 2,000 条 / 4 MiB，优先淘汰低级别日志。上限和缺口可在 UI 查看，ACK 仅代表内存接纳。详细连接与队列边界见 P1 记录。

离线文件头必须有效；正常坏行跳过并计数，重复 ID 采用最后值并保留首次位置，更新格式版本尽量读取并提示。保存时统一 LF 换行，不保留空行、坏行与旧的重复 ID 版本；有效记录中的未知字段、重复 JSON key 和数字原文均保留。

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
# 需先在 packages/peek_desktop_bridge 运行 flutter pub get
cargo test --locked --manifest-path src-tauri/Cargo.toml --test sdk_interop -- --ignored --nocapture
pnpm tauri build --debug --bundles app
```

2026 年 11 月 13 日本机 macOS 已通过前端检查/测试/构建、Rust 测试/格式/Clippy 和原生 `.app` 编译；实际窗口验证了官方样例导入、过滤、Headers/JSON、主题语言、保存回读与十万条合成会话。P1 另通过真实官方 Dart 客户端与 Rust 的跨语言测试、macOS 原生配对、Keychain 授权后既有凭据免码恢复、官方 Bonjour 发现、多桌面身份切换、网络与日志展示及诊断授权撤销/恢复。Windows 构建、真实移动设备互操作和完整性能矩阵尚未验收。

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
