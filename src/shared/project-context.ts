export type ChangeScope = 'unstaged' | 'staged';
export interface ProjectChange {
  path: string;
  previousPath?: string;
  status: string;
}
export interface ProjectChanges {
  repository: boolean;
  branch: string;
  changes: ProjectChange[];
  truncated: boolean;
}
export interface ProjectPatch {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}
export interface ProjectSearch {
  matches: { path: string; line?: number; text?: string }[];
  truncated: boolean;
}
export interface ProjectInstruction {
  path: string;
  content: string;
}
export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'header';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export function diffLines(patch: string): DiffLine[] {
  let before = 0,
    after = 0,
    inHunk = false;
  return patch.split('\n').map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      return { kind: 'header', text };
    }
    if (text.startsWith('diff --git ')) inHunk = false;
    if (!inHunk || !/^[ +\-]/.test(text)) return { kind: 'header', text };
    if (text.startsWith('+')) return { kind: 'add', text, newLine: after++ };
    if (text.startsWith('-')) return { kind: 'remove', text, oldLine: before++ };
    return { kind: 'context', text, oldLine: before++, newLine: after++ };
  });
}
