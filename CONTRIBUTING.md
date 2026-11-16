# 开发指南

## 环境

按 [README](README.md#从源码运行)安装前置工具并克隆仓库。前端依赖使用 `pnpm-lock.yaml`，Rust 使用 `Cargo.lock`，Flutter SDK 使用固定的 `sdk` 子模块提交。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

前端预览地址为 `http://127.0.0.1:1430`，设备服务默认端口为 `9741`。`pnpm dev` 不提供原生桌面能力。

## 检查与构建

```bash
pnpm check
pnpm test
pnpm build
pnpm format:check
pnpm release:check
pnpm release:test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm package:local --debug
```

只修改文档时，核对命令、相对链接和当前实现即可。修改界面时执行前端检查；修改 Rust 状态或协议时增加对应回归，并运行 Rust 检查。正式包还需要平台签名和安装验证，debug 构建不能覆盖这些检查。

## SDK 联合测试

```bash
git submodule update --init --recursive
(cd sdk/packages/peek_desktop_connect && flutter pub get)
(cd sdk/packages/peek_desktop_bridge && flutter pub get)
cargo test --locked --manifest-path src-tauri/Cargo.toml --test sdk_interop -- --ignored --nocapture
```

测试启动临时 Rust 服务，以内存凭据驱动真实官方 Dart 客户端和日志 bridge，不读取系统配对库。常规 Rust 测试跳过这一项，需要显式运行。

SDK 改动在 [peek-flutter-sdk](https://github.com/lx8s8/peek-flutter-sdk) 提交，本仓库更新子模块指针。协议文档在两个仓库各保留一份，修改字段和限制时需同步。

## 合成数据与性能探针

```bash
node scripts/generate-session.mjs /tmp/peek-100k.peek 100000
cargo run --locked --manifest-path src-tauri/Cargo.toml --example session_probe -- /tmp/peek-100k.peek
cargo run --locked --manifest-path src-tauri/Cargo.toml --example archive_probe -- /tmp/peek-100k.peek
```

生成脚本拒绝覆盖已有文件。探针测 Rust 核心的导入、窗口查询、归档或恢复，不包含 WebView。报告性能时注明机器、构建类型、条数、字节数和测试范围；总进程内存、实时吞吐与界面帧率需要另测。

## 问题反馈与提交

反馈问题时附上系统、应用/SDK 版本、操作步骤和脱敏后的最小样例。连接问题区分手动 IP、发现、扫码和配对；数据问题注明是实时、归档还是恢复来源。不要上传真实设备凭据或原始业务日志。

提交说明使用中文，写清修改对象与结果，例如 `修复-会话恢复-最新快照损坏时读取上一份`。功能、修复与文档尽量分开提交。PR 说明给出触发条件、修改后的行为和实际检查结果；未执行的实机验证写入待办。

文档优先回答怎么使用和怎么排查。当前指南、协议规范和阶段记录分开维护；不要把临时调试过程写进安装步骤。
