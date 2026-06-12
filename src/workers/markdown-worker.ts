// src/workers/markdown-worker.ts
import { marked } from 'marked';

self.onmessage = async (event: MessageEvent<string>) => {
  const markdown = event.data;
  try {
    const html = await marked.parse(markdown);
    self.postMessage({ success: true, html });
  } catch (error) {
    self.postMessage({ success: false, error: (error as Error).message });
  }
};
