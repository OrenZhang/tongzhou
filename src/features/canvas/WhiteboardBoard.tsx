import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Excalidraw,
  MainMenu,
  CaptureUpdateAction,
  restoreElements,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import type { Canvas } from '../../shared/canvas';
import type { TongzhouAPI } from '../../shared/types';
import type { WhiteboardScene } from '../../shared/whiteboard';
import { getLocale, subscribeLocale, t } from '../../shared/i18n';

// Persist document preferences and selection, never transient editor state or native file handles.
const stateKeys = [
  'viewBackgroundColor',
  'scrollX',
  'scrollY',
  'zoom',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
  'objectsSnapModeEnabled',
  'selectedElementIds',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemStrokeStyle',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'currentItemStartArrowhead',
  'currentItemEndArrowhead',
  'currentItemRoundness',
  'exportBackground',
  'exportEmbedScene',
  'exportScale',
];
function storedState(state: AppState) {
  return Object.fromEntries(
    stateKeys.filter((k) => (state as any)[k] !== undefined).map((k) => [k, (state as any)[k]]),
  );
}
// Validation reorders object keys. Compare canonical JSON to avoid saving our own echo.
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

export default function WhiteboardBoard({
  canvas,
  api,
  onChange,
  onError,
  onImport,
  onSave,
  blocked,
}: {
  canvas: Canvas;
  api: TongzhouAPI;
  onChange(canvas: Canvas, record?: boolean): void;
  onError(error: unknown): void;
  onImport(): void;
  onSave(): void;
  blocked: boolean;
}) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const [theme, setTheme] = useState<'light' | 'dark'>(
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  const latest = useRef(canvas);
  latest.current = canvas;
  const last = useRef(json(canvas.whiteboard));
  const lastLibrary = useRef(json(canvas.whiteboard?.libraryItems ?? []));
  const applying = useRef(false);
  const initial = useRef({
    ...canvas.whiteboard,
    scrollToContent: !canvas.whiteboard?.appState.zoom,
  } as ExcalidrawInitialDataState);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const scene = canvas.whiteboard;
    if (!editor || !scene || last.current === json(scene)) return;
    last.current = json(scene);
    applying.current = true;
    editor.addFiles(Object.values(scene.files) as any);
    const elements = restoreElements(scene.elements as ExcalidrawElement[], null, {
      repairBindings: true,
      refreshDimensions: true,
    });
    editor.updateScene({
      elements,
      appState: { ...editor.getAppState(), ...scene.appState },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    if (scene.libraryItems && json(scene.libraryItems) !== lastLibrary.current) {
      lastLibrary.current = json(scene.libraryItems);
      void editor.updateLibrary({ libraryItems: scene.libraryItems, merge: false }).catch(onError);
    }
    applying.current = false;
  }, [canvas.whiteboard, editor, onError]);
  const publish = (scene: WhiteboardScene) => {
    const signature = json(scene);
    if (applying.current || blocked || signature === last.current) return;
    last.current = signature;
    // Native elements contain optional keys with undefined values. IPC preserves those,
    // whereas the scene format is JSON; normalize before validation and persistence.
    onChange({ ...latest.current, whiteboard: JSON.parse(signature) as WhiteboardScene }, false);
  };
  const exportScene = async (format: 'excalidraw' | 'svg' | 'png') => {
    if (!editor) return;
    try {
      const elements = editor.getSceneElements(),
        appState = editor.getAppState(),
        files = editor.getFiles();
      let data: string;
      if (format === 'excalidraw') {
        const value = JSON.parse(serializeAsJSON(elements, appState, files, 'local'));
        data = json({ ...value, libraryItems: latest.current.whiteboard?.libraryItems ?? [] });
      } else {
        const options = { elements, appState: { ...appState, exportEmbedScene: true }, files };
        if (format === 'svg') data = (await exportToSvg(options)).outerHTML;
        else {
          const blob = await exportToBlob({ ...options, mimeType: 'image/png' });
          data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }
      }
      const path = await api.whiteboardExport({ title: latest.current.title, format, data });
      if (path) editor.setToast({ message: t('已导出到：') + path });
    } catch (error) {
      onError(error);
    }
  };
  return (
    <div
      className="whiteboard-editor"
      data-testid="whiteboard-editor"
      onKeyDownCapture={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          onSave();
        }
      }}
    >
      <Excalidraw
        excalidrawAPI={setEditor}
        initialData={initial.current}
        name={canvas.title}
        langCode={locale === 'en' ? 'en' : 'zh-CN'}
        theme={theme}
        handleKeyboardGlobally={false}
        viewModeEnabled={blocked}
        aiEnabled={false}
        onChange={(elements, state, files) => {
          // The cursor image is a temporary zero-size element. Persisting and restoring
          // it before placement drops it from Excalidraw's scene, leaving a dangling cursor.
          if (state.pendingImageElementId) return;
          publish({
            elements: elements as unknown as WhiteboardScene['elements'],
            appState: storedState(state),
            files: files as unknown as WhiteboardScene['files'],
            libraryItems: latest.current.whiteboard?.libraryItems ?? [],
          });
        }}
        onLibraryChange={(libraryItems) => {
          if (json(libraryItems) === lastLibrary.current) return;
          lastLibrary.current = json(libraryItems);
          publish({ ...latest.current.whiteboard!, libraryItems: [...libraryItems] });
        }}
        onLinkOpen={(element, event) => {
          event.preventDefault();
          if (element.link) void api.openExternalLink(element.link).catch(onError);
        }}
        UIOptions={{
          canvasActions: { saveToActiveFile: false, loadScene: false, toggleTheme: false },
        }}
      >
        <MainMenu>
          <MainMenu.Item onSelect={onImport}>{t('导入白板')}</MainMenu.Item>
          <MainMenu.Item onSelect={() => void exportScene('excalidraw')}>
            {t('导出可编辑白板')}
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => void exportScene('png')}>{t('导出 PNG')}</MainMenu.Item>
          <MainMenu.Item onSelect={() => void exportScene('svg')}>{t('导出 SVG')}</MainMenu.Item>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
