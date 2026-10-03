import { all, createLowlight } from 'lowlight';
const highlighter = createLowlight(all);
self.onmessage = ({ data }: MessageEvent<{ id: number; text: string; language: string }>) => {
  try {
    const tree = highlighter.registered(data.language)
      ? highlighter.highlight(data.language, data.text)
      : undefined;
    self.postMessage({ id: data.id, tree });
  } catch {
    self.postMessage({ id: data.id });
  }
};
