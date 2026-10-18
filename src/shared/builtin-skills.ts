export const builtinSkills = [
  { id: 'tongzhou-whiteboard-design', directory: 'whiteboard-design', title: '白板设计' },
  { id: 'tongzhou-canvas-workflow', directory: 'canvas-workflow', title: '工作流编排' },
  {
    id: 'tongzhou-skill-creator',
    directory: 'skill-creator',
    title: '技能创建',
  },
  {
    id: 'tongzhou-manju-production',
    directory: 'manju-production',
    title: '漫剧制作',
  },
] as const;

export function isBuiltinSkill(id: string) {
  return builtinSkills.some((skill) => skill.id === id);
}
