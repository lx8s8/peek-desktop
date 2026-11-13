# Peek Desktop

使用 Tauri 2 开发的 Windows 与 macOS 桌面网络检查器，计划兼容 Flutter Peek 的远程协议和 `.peek` 文件，并通过自有 Flutter 私有 SDK 预览普通日志和异常。

完整的架构、组件、JSON 渲染、性能与 UI 方案见 [技术方案](docs/技术方案.md)。

私有 SDK、Talker 接入、完整堆栈、配对复用与桌面日志视图见 [普通日志与异常同步方案](docs/普通日志与异常同步方案.md)。

## 当前状态

本轮完成项目骨架与技术方案。启动页为开发预览，连接服务和业务界面尚未接入。

| 已建立 | 后续阶段引入 |
| --- | --- |
| Tauri 2、Rust、React 19、TypeScript、Vite | WebSocket 服务端、配对与会话存储 |
| 前端与 Cargo 锁文件 | shadcn/ui、Tailwind CSS 4、TanStack 虚拟表格 |
| 本地启动配置、深浅色启动页 | JSON 查看器、正文缓存、中英文与菜单 |
| CSP 与主窗口基础能力配置 | `.peek` 文件、导出、双平台安装包 |
| 普通日志与异常同步设计 | 私有 `peek_desktop_bridge`、诊断协议、日志/异常/时间线与 `.peekbundle` |

## 本地开发

需要 Node.js >= 22.12、pnpm 10.33.0、Rust >= 1.91，以及所在平台的 [Tauri 构建工具](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

仅开发前端时使用 `pnpm dev`，地址为 `http://127.0.0.1:1430`。设备端口 `9741` 是后续连接模块的规划，当前没有启动监听。

## 验证命令

```bash
pnpm check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

`pnpm build` 检查并构建前端，`cargo check` 检查本机平台的 Rust 源码。正式桌面打包使用 `pnpm tauri build`，Windows 与 macOS 分别在对应环境验证。

2026 年 11 月 13 日在本机 macOS 验证通过：TypeScript 检查、前端构建、Rust 格式检查、Rust 源码检查，以及 `pnpm tauri build --debug --no-bundle` 原生编译。Windows 构建与运行尚未验证。

## 项目约定

Rust 保存会话与原始正文，前端按查询窗口和详情需要获取数据。数据流采用有界批处理，列表采用虚拟化；长整数与高精度小数的复制、导出以原始正文为准。

当前名称和 `local.peek.desktop` 标识用于本地开发，图标仍为脚手架资源。尚未配置远程仓库或发布流程。
