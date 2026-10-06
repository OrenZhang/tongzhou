export const builtinSkills = [
  {
    id: 'tongzhou-skill-creator',
    directory: 'skill-creator',
    title: '技能创建',
  },
] as const;

export function isBuiltinSkill(id: string) {
  return builtinSkills.some((skill) => skill.id === id);
}
