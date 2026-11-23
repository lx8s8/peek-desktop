import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { detectAotStack, extractBuildHints } from "./aotDetect";
import { StackSymbolicator } from "./StackSymbolicator";
import { PluginManagerDialog } from "./PluginManagerDialog";
import { api } from "../../lib/ipc/client";

vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    symbolicateStack: vi.fn(),
    parsePluginInput: vi.fn(),
    fetchPluginFromUrl: vi.fn(),
    upsertPlugin: vi.fn(),
    testPlugin: vi.fn(),
    exportPluginConfig: vi.fn(),
    savePluginFile: vi.fn(),
    setPluginEnabled: vi.fn(),
    setDefaultPlugin: vi.fn(),
    removePlugin: vi.fn(),
    pickPluginFile: vi.fn(),
    pickSymbolsDirectory: vi.fn(),
  },
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboard: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it("detects Flutter AOT stack metadata and extracts build hints from event attributes", () => {
  const rawStack = [
    "os: ios arch: arm64 comp: yes sim: no",
    "build_id: 'A1B2-C3D4-E5F6'",
    "isolate_dso_base: 104c00000, vm_dso_base: 104c00000",
    "    #00 abs 0000000104e2a1bc _kDartIsolateSnapshotInstructions+0x21a1bc",
  ].join("\n");

  const detected = detectAotStack(rawStack);
  expect(detected.isAot).toBe(true);
  expect(detected.buildId).toBe("a1b2c3d4e5f6");
  expect(detected.os).toBe("ios");
  expect(detected.arch).toBe("arm64");

  const hints = extractBuildHints(
    {
      build: {
        appVersion: "6.2.19",
        buildNumber: "60384",
        flavor: "dev",
        jobId: "build_20261123_01",
      },
    },
    detected,
  );
  expect(hints.appVersion).toBe("6.2.19");
  expect(hints.buildNumber).toBe("60384");
  expect(hints.flavor).toBe("dev");
  expect(hints.jobId).toBe("build_20261123_01");
});

it("symbolicates obfuscated stack via configured plugin and switches view modes", async () => {
  const stack =
    "build_id: 'deadbeef0102'\n#00 abs 0000000104e2a1bc _kDartIsolateSnapshotInstructions+0x1bc";
  vi.mocked(api.symbolicateStack).mockResolvedValue({
    ok: true,
    symbolizedStack: "#0 CheckoutPage.submit (package:demo/checkout.dart:88:7)",
    providerId: "qa-http",
    providerName: "QA 符号服务",
    cached: false,
    durationMs: 42,
    detected: {
      isAot: true,
      buildId: "deadbeef0102",
      os: "ios",
      arch: "arm64",
    },
    matchedBuild: {
      jobId: "job-2026",
      appVersion: "6.2.19+60384",
      flavor: "dev",
      matchedBy: "buildId",
    },
    warnings: [],
    error: null,
  });

  render(
    <StackSymbolicator
      stack={stack}
      attributes={{ build: { appVersion: "6.2.19", flavor: "dev" } }}
      plugins={[
        {
          schemaVersion: 1,
          id: "qa-http",
          name: "QA 符号服务",
          enabled: true,
          kind: "http",
          timeoutMs: 15000,
          source: "managed",
          isDefault: true,
          hasSecret: true,
          maskedToken: "abcd••••wxyz",
          http: {
            endpoint: "http://127.0.0.1:17890/v1/symbolize",
            hasToken: true,
            maskedToken: "abcd••••wxyz",
            headers: {},
          },
        },
      ]}
      defaultPluginId="qa-http"
    />,
  );

  // 开启自动还原后，挂载 AOT 混淆堆栈即自动发起还原，无需手动点击
  await waitFor(() =>
    expect(
      screen.getByText(
        /CheckoutPage\.submit \(package:demo\/checkout\.dart:88:7\)/,
      ),
    ).toBeTruthy(),
  );
  expect(api.symbolicateStack).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginId: "qa-http",
      buildId: "deadbeef0102",
      appVersion: "6.2.19",
      flavor: "dev",
    }),
  );
});

it("previews and installs a plugin package in PluginManagerDialog", async () => {
  const onChange = vi.fn();
  vi.mocked(api.upsertPlugin).mockResolvedValue({
    defaultPluginId: "qa-http",
    discoveryDir: null,
    plugins: [],
  });

  render(
    <PluginManagerDialog
      snapshot={{ defaultPluginId: null, discoveryDir: null, plugins: [] }}
      initialPreview={{
        plugin: {
          schemaVersion: 1,
          id: "qa-http",
          name: "测试环境符号服务",
          description: "内网只读还原",
          enabled: true,
          kind: "http",
          timeoutMs: 15000,
          http: {
            endpoint: "http://192.168.1.50:17890/v1/symbolize",
            headers: {},
            token: "qa-token-secret",
          },
        },
        hasSecret: true,
        maskedToken: "qa-t••••cret",
        requiresTrustWarning: false,
      }}
      onSnapshotChange={onChange}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByText("测试环境符号服务")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /pluginConfirmInstall|确认安装/ }),
  );

  await waitFor(() => expect(api.upsertPlugin).toHaveBeenCalledTimes(1));
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("fetches full plugin manifest and recent builds from a single service URL", async () => {
  vi.mocked(api.fetchPluginFromUrl).mockResolvedValue({
    plugin: {
      schemaVersion: 1,
      id: "qa-auto",
      name: "自动发现符号服务",
      description: "单地址拉取测试",
      enabled: true,
      kind: "http",
      timeoutMs: 20000,
      http: {
        endpoint: "http://192.0.2.16:17890/v1/symbolize",
        healthEndpoint: "http://192.0.2.16:17890/health",
        token: "qa-tok-1",
        headers: {},
      },
    },
    hasSecret: true,
    maskedToken: "qa-t••••ok-1",
    requiresTrustWarning: false,
    serviceInfo: {
      availableBuilds: 4,
      symbolCount: 8,
      recentBuilds: [
        {
          jobId: "build-1",
          appVersion: "6.2.19+60384",
          flavor: "dev",
          target: "ipa",
        },
      ],
      message: "连接正常，远端已索引 4 个构建",
    },
  });

  render(
    <PluginManagerDialog
      snapshot={{ defaultPluginId: null, discoveryDir: null, plugins: [] }}
      onSnapshotChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  fireEvent.click(
    screen.getAllByRole("button", { name: /pluginQuickImport|快速导入/ })[0],
  );
  fireEvent.change(screen.getByPlaceholderText("http://192.168.x.x:17890"), {
    target: { value: "http://192.0.2.16:17890?token=qa-tok-1" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: /pluginFetchUrlAction|拉取配置并预览/ }),
  );

  await waitFor(() =>
    expect(screen.getByText("自动发现符号服务")).toBeTruthy(),
  );
  expect(screen.getByText("6.2.19+60384 · dev · ipa")).toBeTruthy();
  expect(api.fetchPluginFromUrl).toHaveBeenCalledWith(
    "http://192.0.2.16:17890?token=qa-tok-1",
    null,
  );
});
