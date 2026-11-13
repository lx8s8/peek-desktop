# Peek Bridge Demo

在 Peek Desktop 启动监听并生成配对码，然后运行：

```bash
flutter pub get
flutter run -d macos --dart-define=PEEK_DESKTOP_DIAGNOSTICS=true
```

同机可填 `127.0.0.1:9741`。局域网自动发现需桌面选择“局域网设备”并开启 mDNS，再点击示例“发现局域网桌面”，选择发现的地址。首次填写四位码，已配对时留空复用官方保存的凭据。示例只在 debug 且显式开关打开时构造 bridge；Release/Profile 不初始化诊断。按钮产生合成网络、普通日志、警告与原始异常堆栈，不访问业务 API。网络使用原版 PeekRemote，日志复用其公开配对信息。
