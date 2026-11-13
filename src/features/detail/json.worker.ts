import { analyzeJson } from "./json";
self.onmessage = (event: MessageEvent<string>) => self.postMessage(analyzeJson(event.data));
