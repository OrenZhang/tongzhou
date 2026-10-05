export const entityTypes = {
  project: '项目',
  system: '系统',
  person: '人物',
  organization: '组织',
  concept: '概念',
  task: '任务',
} as const;
export const relationTypes = {
  depends_on: { label: '依赖', entity: true, single: false },
  part_of: { label: '属于', entity: true, single: false },
  uses: { label: '使用', entity: true, single: false },
  owner: { label: '负责人', entity: true, single: false },
  deployed_at: { label: '部署于', entity: true, single: false },
  endpoint: { label: '服务地址', entity: false, single: true },
  command: { label: '启动命令', entity: false, single: true },
  fact: { label: '事实', entity: false, single: false },
  preference: { label: '偏好与约束', entity: false, single: false },
  decision: { label: '决策', entity: false, single: false },
  lesson: { label: '经验与方法', entity: false, single: false },
  todo: { label: '待办与缺口', entity: false, single: false },
  conflict: { label: '矛盾与变化', entity: false, single: false },
} as const;
export type EntityType = keyof typeof entityTypes;
export type RelationType = keyof typeof relationTypes;
export interface KnowledgeAssertion {
  subject: string;
  subjectType: EntityType;
  relation: RelationType;
  object: string;
  objectType?: EntityType;
  sourceId?: string;
  quote: string;
  validFrom?: string;
  validUntil?: string;
}
export interface KnowledgeEntity {
  id: string;
  name: string;
  type: EntityType;
  scope: string;
}
export interface KnowledgeFact {
  id: string;
  subjectId: string;
  objectId?: string;
  subject: string;
  relation: RelationType;
  object: string;
  scope: string;
  validFrom?: string;
  validUntil?: string;
  status: 'confirmed' | 'pending' | 'stale' | 'expired';
  conflict: boolean;
  evidence: {
    documentId: string;
    title: string;
    version: number;
    quote: string;
    sourceId?: string;
    entryId?: string;
    assertionIndex?: number;
    reviewed: boolean;
    stale: boolean;
  }[];
}
export interface KnowledgeGraph {
  entities: KnowledgeEntity[];
  facts: KnowledgeFact[];
  total: number;
  nextOffset: number | null;
}
