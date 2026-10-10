import type { WebContents } from 'electron';

/** Generated frames have no reason to navigate beyond the static sandbox runner. */
export function guardPreviewNavigation(contents: WebContents, previewUrl: string) {
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && event.url !== previewUrl) event.preventDefault();
  });
}
