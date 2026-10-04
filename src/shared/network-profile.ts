export interface NetworkProfile {
  id: string;
  name: string;
  source: 'config' | 'subscription';
  nodes: string[];
  selected: string;
  updatedAt: number;
  status: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
  latency?: number;
  usedBy: string[];
}
export interface NetworkProfileInput {
  id: string;
  name: string;
  source: 'config' | 'subscription';
  config?: string;
  subscriptionUrl?: string;
}
export interface NetworkOverview {
  core: { installed: boolean; version: string; asset: string };
  profiles: NetworkProfile[];
}
