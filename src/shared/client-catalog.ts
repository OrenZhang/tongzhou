/** Serializable registry metadata shared by the desktop and its capability browser. */
export interface ClientMethod {
  name: string;
  module: string;
  description: string;
  access: 'query' | 'change' | 'manual';
  arguments: Record<string, unknown>;
  reason?: string;
  view?: string;
}
export interface ClientCatalog {
  modules: string[];
  methods: ClientMethod[];
  read: string[];
  change: string[];
  notes: string;
}
