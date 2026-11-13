import { parse, stringify } from "lossless-json";

export const losslessParser = {
  parse,
  stringify: (
    value: unknown,
    replacer?: Parameters<typeof stringify>[1],
    space?: string | number,
  ) => stringify(value, replacer, space) ?? "null",
};

export function analyzeJson(text: string) {
  try {
    const value = parse(text);
    let nodes = 0;
    const stack: [unknown, number][] = [[value, 0]];
    let treeSafe = text.length <= 1024 * 1024;
    while (treeSafe && stack.length) {
      const [item, depth] = stack.pop()!;
      if (++nodes > 20_000 || depth > 48) {
        treeSafe = false;
        break;
      }
      if (item && typeof item === "object") {
        for (const child of Object.values(item)) stack.push([child, depth + 1]);
      }
    }
    return {
      formatted: losslessParser.stringify(value, null, 2),
      error: "",
      treeSafe,
    };
  } catch (error) {
    return { formatted: "", error: String(error), treeSafe: false };
  }
}
