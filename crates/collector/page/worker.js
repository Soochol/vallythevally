import { decodeSpan } from "./decode.js";

self.onmessage = async ({ data: { id, url } }) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const layout = decodeSpan(buffer);
    self.postMessage({ id, layout, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
