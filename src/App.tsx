import "./App.css";

export default function App() {
  return (
    <main className="workspace">
      <header className="toolbar">
        <span className="brand">Peek Desktop</span>
        <span className="stage">开发预览</span>
      </header>
      <section className="empty-state" aria-labelledby="connection-title">
        <span className="connection-mark" aria-hidden="true">↔</span>
        <h1 id="connection-title">等待连接</h1>
        <p>在桌面集中查看设备上的网络请求与响应</p>
        <p className="hint">连接服务尚未接入，当前版本为项目骨架</p>
      </section>
      <footer className="status-bar">未连接设备</footer>
    </main>
  );
}
