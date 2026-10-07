export interface ConnectionCheck {
  name: string;
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
  ms: number;
}
