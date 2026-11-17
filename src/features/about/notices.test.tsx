import text from "../../../THIRD_PARTY_NOTICES.md?raw";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { legalPages, parseNotices } from "./notices";
import { LegalDocument, ThirdPartyNotices } from "./LegalDocument";

it("maps every shipped component and license reference to the complete original text", () => {
  const result = parseNotices(text);
  expect(result.components.length).toBe(
    text.split("\n").filter((line) => /^\| (node|rust):/.test(line)).length,
  );
  expect(result.documents.size).toBe(
    (text.match(/^## license-[a-f0-9]{16}$/gm) ?? []).length,
  );
  expect(result.components.length).toBeGreaterThan(400);
  for (const component of result.components) {
    for (const id of component.documents) {
      expect(result.documents.has(id), `${component.name}: ${id}`).toBe(true);
      expect(text).toContain(result.documents.get(id));
    }
  }
});
it("filters the license catalog without mounting the entire legal document", () => {
  const { container } = render(<ThirdPartyNotices text={text} />);
  expect(container.textContent!.length).toBeLessThan(70_000);
  expect(
    container.querySelector("pre")!.textContent!.length,
  ).toBeLessThanOrEqual(12_000);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "rust:reqwest@" },
  });
  expect(screen.getByRole("combobox").textContent).toContain("rust:reqwest@");
  expect(screen.getByRole("combobox").textContent).not.toContain("node:");
  expect(screen.getByText("1 个组件")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "no-such-component" },
  });
  expect(screen.getByText("没有匹配的组件")).toBeTruthy();
});
it("pages long legal text losslessly and keeps emoji intact at boundaries", () => {
  const original = "x".repeat(11_999) + "😀许可" + "y".repeat(14_000);
  const pages = legalPages(original);
  expect(pages.join("")).toBe(original);
  for (const page of pages) expect(page.endsWith("\ud83d")).toBe(false);
  const { container } = render(<LegalDocument text={original} />);
  expect(container.querySelector("pre")?.textContent).toBe(pages[0]);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(container.querySelector("pre")?.textContent).toBe(pages[1]);
});
