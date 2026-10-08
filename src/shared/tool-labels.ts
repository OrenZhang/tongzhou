/** User-facing names for native engine records, including existing history. */
export function toolLabel(name?: string, fallback = '工具结果') {
  if (name === 'Codex · 终端') return '执行命令';
  if (name === 'Codex · 文件变更') return '修改文件';
  return name || fallback;
}
