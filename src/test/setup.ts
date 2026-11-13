import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "../lib/i18n";

afterEach(cleanup);
Object.defineProperty(window, "matchMedia", {
  value: vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })),
});
Element.prototype.scrollTo = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
