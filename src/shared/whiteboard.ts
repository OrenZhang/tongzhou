/** Persist the editor's open scene format, including native fields we do not interpret. */
export interface WhiteboardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  [key: string]: any;
}
export interface WhiteboardScene {
  elements: WhiteboardElement[];
  files: Record<
    string,
    { id: string; dataURL: string; mimeType: string; created: number; [key: string]: any }
  >;
  appState: Record<string, any>;
  libraryItems?: any[];
}
export const emptyWhiteboard = (): WhiteboardScene => ({ elements: [], files: {}, appState: {} });
