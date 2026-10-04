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
  routing?: 'manual' | 'auto';
  health?: { checkedAt: number; results: NetworkNodeHealth[]; recommended?: string };
  checking?: { completed: number; total: number };
}
export type NetworkTarget = 'internet' | 'auth' | 'chatgpt';
export interface NetworkProbe {
  status: 'ok' | 'timeout' | 'dns' | 'tls' | 'blocked' | 'failed';
  ms?: number;
  target?: string;
}
export interface NetworkNodeHealth {
  node: string;
  checkedAt: number;
  internet: NetworkProbe;
  auth: NetworkProbe;
  chatgpt: NetworkProbe;
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
