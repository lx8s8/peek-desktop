# Peek Desktop

在电脑上查看 Flutter App 的网络请求、日志和异常堆栈。支持实时连接设备，也可以打开 `.peek` 文件和会话归档离线排查。

项目基于 Tauri 2、Rust、React 和 TypeScript，采用 MIT 许可证。macOS 本机和三平台 CI 的验证记录、实体设备待验项目见[文档](docs/README.md)。

## 功能

- 查看请求和响应的 Headers、正文、耗时及错误；支持无损 JSON、正文搜索、图片、原文和 Hex 预览
- 配对设备，实时接收网络记录；局域网地址、二维码和可选 Bonjour 发现
- 查看 Talker 日志、原始异常堆栈及结构化属性；按级别、来源、标签和时间筛选
- 在时间线中一起查看网络和日志，按请求 ID 跳转关联记录
- 保存完整会话归档，导出 HAR、日志 JSONL、文本或当前请求的 cURL
- 可选工作区恢复、简体中文与英文菜单、深浅主题和键盘操作
- 关于、MIT 和第三方声明，以及 GitHub 正式版本检查

Flutter 接入使用独立的 MIT 项目 [peek-flutter-sdk](https://github.com/lx8s8/peek-flutter-sdk)。其中连接包负责扫码和电脑选择，日志包负责 Talker 同步；两者共用 App 中的一个 `PeekRemote`。

## 安装包

从 [GitHub Releases](https://github.com/lx8s8/peek-desktop/releases/latest) 下载 macOS Apple Silicon / Intel DMG 或 Windows x64 安装器。每个版本附带 SHA-256 与构建清单，更新记录见 [CHANGELOG](CHANGELOG.md)。

安装包固定采用无证书方式：macOS 使用 ad-hoc 签名、未公证，Windows 未签名。在应用“关于 Peek Desktop”中可检查新版本，下载后手动升级。安装与首次运行说明见[桌面发布文档](docs/桌面发布.md)。

本地打包使用 `pnpm package:local`，开发构建也可从 [Actions](https://github.com/lx8s8/peek-desktop/actions/workflows/package-desktop.yml) 获取。

## 从源码运行

需要 Node.js >= 22.12、pnpm 10.33.0、Rust >= 1.91，以及对应平台的 [Tauri 构建环境](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone --recurse-submodules https://github.com/lx8s8/peek-desktop.git
cd peek-desktop
pnpm install --frozen-lockfile
pnpm tauri dev
```

已经克隆过的仓库可执行 `git submodule update --init --recursive` 补齐 SDK。`pnpm dev` 只启动浏览器预览，文件对话框、设备监听和系统菜单需要桌面环境。

## 开始使用

**打开文件**：使用“打开文件”或 Cmd/Ctrl O。仓库内的 `src-tauri/tests/fixtures/upstream/sessions/basic.peek` 可用于试用请求列表和详情。

**连接手机**：打开“设备连接”，默认使用“局域网设备”；核对显示的本机 IP 后，启动监听并生成配对码。App 扫描桌面二维码，或输入电脑的局域网 IP 和四位配对码。同机示例可使用 `127.0.0.1:9741`。配对码 180 秒有效，成功一次后失效。

**查看日志**：App 接入日志包，并在配对时允许诊断同步。连接成功后可切换“日志”“异常”和“时间线”。共享测试机可以记住多台电脑，每次选择一台连接。

**保存排查现场**：“保存完整归档”生成 `.peekbundle`，包含当前保留的网络和日志。“保存网络会话”生成 `.peek`，只含网络记录。尚未从设备取回的正文需先加载再保存。

连接问题见[设备连接指南](docs/快速连接方案.md)，文件格式及自动恢复见[文件、导出与恢复](docs/文件与恢复.md)。

## 文档与开发

- [文档目录](docs/README.md)
- [开发指南](CONTRIBUTING.md)：检查、构建、联合测试与问题反馈
- [架构说明](docs/技术方案.md)：数据流、模块和实现取舍
- [日志同步说明](docs/普通日志与异常同步方案.md)与[诊断协议 v1](docs/诊断协议v1.md)
- [待办与发布准备](docs/待办.md)

本项目使用 Peek 公开的网络协议和会话格式，兼容样例的来源与许可见[上游样例说明](src-tauri/tests/fixtures/upstream/README.md)。它接收 App 已采集的数据，不需要安装代理证书。

## 许可证

本项目采用 [MIT](LICENSE)。依赖的许可与来源见[第三方软件声明](THIRD_PARTY_NOTICES.md)，安装包中同时附带许可文件。
