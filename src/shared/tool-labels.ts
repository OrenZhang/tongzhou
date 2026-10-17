/** User-facing names for native engine records, including existing history. */
export function toolLabel(name?: string, fallback = '工具结果') {
  if (name === 'Codex · 终端') return '执行命令';
  if (name === 'Codex · 文件变更') return '修改文件';
  const canvas: Record<string, string> = {
    canvas_list: '查看画布',
    canvas_read: '读取画布',
    canvas_apply: '编辑画布',
    canvas_execute: '执行工作流',
    canvas_cancel: '停止工作流',
  };
  if (name && canvas[name]) return canvas[name];
  if (name === 'completion_check') return '登记完成检查';
  return name || fallback;
}
