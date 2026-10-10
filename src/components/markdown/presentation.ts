/** Only infer diagrams from their grammar header; ordinary ASCII diagrams stay text. */
export function presentationLanguage(language: string, text: string) {
  const name = language.toLowerCase();
  if (name === 'mermaid') return 'mermaid';
  if (['html', 'htm', 'html-preview'].includes(name)) return 'html';
  if (!['', 'text', 'plaintext', 'txt'].includes(name)) return name;
  const source = text.replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trimStart();
  return /^(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|xychart-beta|sankey-beta|block-beta|packet-beta|architecture-beta|kanban)\s*(?:\r?\n|$))/.test(
    source,
  )
    ? 'mermaid'
    : name;
}

export function closedCodeFence(raw: string) {
  const lines = raw.trimEnd().split('\n');
  const fence = /^\s*(`{3,}|~{3,})/.exec(lines[0])?.[1];
  const last = lines.at(-1)?.trim() ?? '';
  return (
    lines.length > 1 &&
    !!fence &&
    last.length >= fence.length &&
    [...last].every((c) => c === fence[0])
  );
}
