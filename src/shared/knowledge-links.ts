export function knowledgeLinks(text: string): string[] {
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  return [
    ...new Set([...prose.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1].trim())),
  ];
}
/** Transform only prose nodes; code, links and images remain untouched. */
export function remarkKnowledgeLinks() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!node.children || ['link', 'image', 'code', 'inlineCode'].includes(node.type)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const result: any[] = [];
        let start = 0;
        for (const m of child.value.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g)) {
          if (m.index > start)
            result.push({ type: 'text', value: child.value.slice(start, m.index) });
          result.push({
            type: 'link',
            url: '#knowledge:' + encodeURIComponent(m[1].trim()),
            children: [{ type: 'text', value: m[2] || m[1] }],
          });
          start = m.index + m[0].length;
        }
        if (start < child.value.length)
          result.push({ type: 'text', value: child.value.slice(start) });
        return result;
      });
    };
    visit(tree);
  };
}
