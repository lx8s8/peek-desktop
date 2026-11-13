import { useEffect, useRef } from "react";
import { createJSONEditor, getValueClass, Mode, type RenderValueProps } from "vanilla-jsoneditor";
import "vanilla-jsoneditor/themes/jse-theme-dark.css";
import { losslessParser } from "./json";

export default function JsonTree({ text, theme }: { text: string; theme: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const editor = createJSONEditor({ target: host.current!, props: {
      content: { text }, parser: losslessParser, readOnly: true, mode: Mode.tree,
      mainMenuBar: false, navigationBar: false, statusBar: false,
      // Render external values as inert text, without URL-opening actions.
      onRenderValue: (props: RenderValueProps) => [{ action: (node: HTMLElement) => {
        const text = props.normalization.escapeValue(props.value);
        node.textContent = text.length > 2048 ? `${text.slice(0, 2048)}…` : text;
        node.className = getValueClass(props.value, props.mode, props.parser);
        node.dataset.type = "selectable-value";
      }, props: {} }],
    } });
    return () => { void editor.destroy(); };
  }, [text]);
  return <div ref={host} className={`json-tree ${theme === "dark" ? "jse-theme-dark" : ""}`} onClickCapture={event => {
    if ((event.target as Element).closest("a")) event.preventDefault();
  }} />;
}
