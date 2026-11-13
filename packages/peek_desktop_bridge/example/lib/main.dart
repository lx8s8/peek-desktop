import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:peek/core.dart';
import 'package:peek_remote/peek_remote.dart';
import 'package:peek_desktop_bridge/peek_desktop_bridge.dart';
import 'package:talker/talker.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(home: Demo()));
}

class Demo extends StatefulWidget {
  const Demo({super.key});
  @override
  State<Demo> createState() => _DemoState();
}

class _DemoState extends State<Demo> {
  static const enabled =
      kDebugMode && bool.fromEnvironment('PEEK_DESKTOP_DIAGNOSTICS');
  final host = TextEditingController(text: '127.0.0.1:9741');
  final code = TextEditingController();
  final talker = Talker(settings: TalkerSettings(useConsoleLogs: false));
  Peek? peek;
  PeekRemote? remote;
  DesktopDiagnosticsBridge? bridge;
  Timer? refresh;
  StreamSubscription<List<PeekRemoteDiscovered>>? discovery;
  List<PeekRemoteDiscovered> desktops = [];
  String? error;
  @override
  void initState() {
    super.initState();
    if (enabled) {
      peek = Peek(options: const PeekOptions(name: 'Peek Bridge Demo'));
      remote = peek!.attach(PeekRemote(peek!));
      bridge = DesktopDiagnosticsBridge(redactor: redactSensitiveFields)
        ..attachTalker(talker)
        ..attachPeekRemote(remote!)
        ..start();
      remote!.start();
      refresh = Timer.periodic(const Duration(milliseconds: 400), (_) {
        if (mounted) setState(() {});
      });
    }
  }

  Future<void> connect() async {
    try {
      await remote!.connect(
        PeekRemoteEndpoint.parse(host.text),
        code: code.text.trim().isEmpty ? null : code.text.trim(),
      );
      if (mounted) setState(() => error = null);
    } on Object {
      if (mounted) setState(() => error = '连接参数无效，请检查地址与四位配对码。');
    }
  }

  void discover() {
    unawaited(discovery?.cancel());
    discovery = remote!.discover().listen(
      (found) {
        if (mounted) {
          setState(() {
            desktops = found;
            error = null;
          });
        }
      },
      onError: (Object _) {
        if (mounted) setState(() => error = '自动发现不可用，请手动填写桌面地址。');
      },
    );
  }

  void network() {
    final id = PeekId.generate();
    final now = DateTime.now().toUtc();
    peek!.report(
      PeekRequestStarted(
        id: id,
        timestamp: now,
        request: PeekRequest(
          method: 'GET',
          uri: Uri.parse('https://synthetic.example.test/demo/${id.value}'),
        ),
        source: 'synthetic-demo',
      ),
    );
    peek!.report(
      PeekResponseReceived(
        id: id,
        timestamp: now.add(const Duration(milliseconds: 42)),
        response: PeekResponse(
          statusCode: 200,
          body: PeekBody.text(
            '{"id":900719925474099312345,"amount":0.12345678901234567890,"padding":"${'x' * 6000}"}',
            contentType: PeekMediaType.tryParse('application/json'),
          ),
        ),
      ),
    );
    talker.info('已生成合成网络记录');
  }

  @override
  void dispose() {
    refresh?.cancel();
    unawaited(discovery?.cancel());
    unawaited(bridge?.dispose());
    remote?.dispose();
    peek?.dispose();
    host.dispose();
    code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Peek Bridge Demo')),
    body: Padding(
      padding: const EdgeInsets.all(24),
      child: ListView(
        children: [
          if (!enabled)
            const Text(
              '诊断未初始化。请用 debug 模式并传入 --dart-define=PEEK_DESKTOP_DIAGNOSTICS=true 启动。',
            )
          else ...[
            TextField(
              controller: host,
              decoration: const InputDecoration(labelText: '桌面地址（host:port）'),
            ),
            TextField(
              controller: code,
              maxLength: 4,
              decoration: const InputDecoration(labelText: '一次性配对码（已配对时可留空）'),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: discover,
                  child: const Text('发现局域网桌面'),
                ),
                FilledButton(
                  onPressed: () => unawaited(connect()),
                  child: const Text('连接 / 配对'),
                ),
                OutlinedButton(
                  onPressed: () => unawaited(remote!.stop()),
                  child: const Text('断开'),
                ),
                OutlinedButton(
                  onPressed: () => unawaited(remote!.forget()),
                  child: const Text('忘记桌面'),
                ),
              ],
            ),
            for (final desktop in desktops)
              TextButton(
                onPressed: () => setState(
                  () => host.text =
                      '${desktop.endpoint.host}:${desktop.endpoint.port}',
                ),
                child: Text(
                  '${desktop.name} · ${desktop.endpoint.host}:${desktop.endpoint.port} · v${desktop.protocolVersion}',
                ),
              ),
            const SizedBox(height: 16),
            Text('网络：${remote!.state.name} · 日志：${bridge!.state.name}'),
            Text(
              '待发 ${bridge!.stats.queued} 条 · 淘汰 ${bridge!.stats.dropped} · 已确认 ${bridge!.stats.acknowledged}',
            ),
            if (error != null) Text(error!),
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(onPressed: network, child: const Text('生成合成请求')),
                OutlinedButton(
                  onPressed: () => talker.info('普通业务日志 · 合成数据'),
                  child: const Text('INFO 日志'),
                ),
                OutlinedButton(
                  onPressed: () => talker.warning('业务警告 · 合成数据'),
                  child: const Text('WARN 日志'),
                ),
                OutlinedButton(
                  onPressed: () => talker.handle(
                    StateError('合成异常'),
                    StackTrace.current,
                    '原始堆栈演示',
                  ),
                  child: const Text('异常与堆栈'),
                ),
                OutlinedButton(
                  onPressed: () => bridge!.record(
                    const DiagnosticRecord(
                      message: '结构化合成事件',
                      attributes: {
                        'operation': 'demo',
                        'token': 'synthetic-secret',
                      },
                    ),
                  ),
                  child: const Text('脱敏属性'),
                ),
                OutlinedButton(
                  onPressed: () => bridge!.resetContext(),
                  child: const Text('重置上下文'),
                ),
                OutlinedButton(
                  onPressed: () => bridge!.reconnect(),
                  child: const Text('重试日志连接'),
                ),
              ],
            ),
            const SizedBox(height: 20),
            const Text('此示例只生成合成记录，不访问业务接口。生产应用需使用自身编译期诊断开关，不自动覆盖全局异常处理器。'),
          ],
        ],
      ),
    ),
  );
}
