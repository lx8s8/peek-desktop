import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BodyPreview } from "./BodyPreview";
import type { BodyView } from "../../lib/ipc/types";
vi.mock("./JsonViewer", () => ({
  JsonViewer: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
const body: BodyView = {
  kind: "bytes",
  mediaType: "image/png",
  size: 64,
  capturedBytes: 64,
  truncated: false,
  previewTruncated: false,
  text: "00000000  89 50 4e 47",
  reason: null,
  image: {
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,aW1hZ2U=",
    width: 3,
    height: 2,
  },
};
it("shows captured images with fit, actual size and Hex views", () => {
  const { container } = render(<BodyPreview body={body} theme="light" />);
  const image = screen.getByRole("img", { name: "已采集的正文图片" });
  expect(image.getAttribute("src")).toBe(body.image!.dataUrl);
  expect(screen.getByText("image/png · 3 × 2 px")).toBeTruthy();
  expect(container.querySelector(".image-fit")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "原始尺寸" }));
  expect(container.querySelector(".image-actual")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "十六进制" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByText(body.text, { normalizer: (text) => text }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "图片" }));
  expect(screen.getByRole("img")).toBeTruthy();
});
it("falls back after a decoding error and resets for a different captured image", () => {
  const { rerender } = render(<BodyPreview body={body} theme="light" />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText(/无法读取图片/)).toBeTruthy();
  expect(
    screen.getByText(body.text, { normalizer: (text) => text }),
  ).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  rerender(
    <BodyPreview
      body={{
        ...body,
        image: { ...body.image!, dataUrl: "data:image/png;base64,bmV3" },
      }}
      theme="light"
    />,
  );
  expect(screen.getByRole("img").getAttribute("src")).toContain("bmV3");
});
it("keeps incomplete or oversized image data as searchable Hex", () => {
  render(
    <BodyPreview
      body={{
        ...body,
        image: undefined,
        imageUnavailable: "imageTruncated",
        truncated: true,
      }}
      theme="light"
    />,
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(/图片数据不完整/)).toBeTruthy();
  expect(
    screen.getByText(body.text, { normalizer: (text) => text }),
  ).toBeTruthy();
});
