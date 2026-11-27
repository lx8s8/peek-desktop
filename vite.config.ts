import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rolldownOptions: {
      output: {
        // 将稳定第三方依赖拆分为独立缓存分片，配合业务弹窗懒加载控制首包体积
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: "vendor-table",
              test: /node_modules[\\/]@tanstack[\\/]/,
            },
            {
              name: "vendor-ui",
              test: /node_modules[\\/](lucide-react|@radix-ui|react-resizable-panels|qrcode\.react)[\\/]/,
            },
            {
              name: "vendor-i18n",
              test: /node_modules[\\/](i18next|react-i18next)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
