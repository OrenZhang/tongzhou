import { describe, expect, it } from 'vitest';
import { closedCodeFence, presentationLanguage } from '../../src/components/markdown/presentation';

describe('message presentation', () => {
  it('recognizes explicit HTML and valid diagram headers without guessing ordinary text', () => {
    expect(presentationLanguage('HTML', '<button>切换</button>')).toBe('html');
    expect(presentationLanguage('', 'flowchart LR\n A-->B')).toBe('mermaid');
    expect(presentationLanguage('text', '%% note\nsequenceDiagram\nA->>B: Hi')).toBe('mermaid');
    expect(presentationLanguage('', 'T1 回收 → T2 整理')).toBe('');
    expect(presentationLanguage('js', 'flowchart LR')).toBe('js');
    expect(presentationLanguage('xml', '<button>源码示例</button>')).toBe('xml');
  });
  it('does not execute partial streamed fences', () => {
    expect(closedCodeFence('```html\n<button>Run</button>')).toBe(false);
    expect(closedCodeFence('```html\n<button>Run</button>\n```')).toBe(true);
    expect(closedCodeFence('````html\n```\n')).toBe(false);
    expect(closedCodeFence('~~~html\n<p>Hi</p>\n~~~~')).toBe(true);
  });
});
