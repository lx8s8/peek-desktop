# Peek Bridge Demo

在 Peek Desktop 启动监听并生成配对码，然后运行：

```bash
flutter pub get
flutter run -d macos --dart-define=PEEK_DESKTOP_DIAGNOSTICS=true
```

填写桌面地址与四位配对码。示例只在 debug 且显式开关打开时构造 bridge；Release/Profile 不初始化诊断。按钮产生合成网络、普通日志、警告与原始异常堆栈，不访问业务 API。网络使用原版 PeekRemote，日志复用其公开配对信息。
