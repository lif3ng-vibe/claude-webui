import { describe, it, expect } from 'vitest';
import { encodeCwd, decodeCwdHeuristic } from '../../src/claude/pathEncoding.js';

describe('encodeCwd', () => {
  it('把 Windows 绝对路径编码为 Claude projects 目录名', () => {
    expect(encodeCwd('C:\\Users\\lif3n\\src\\claude-webui')).toBe('C--Users-lif3n-src-claude-webui');
  });

  it('编码到盘符根', () => {
    expect(encodeCwd('C:\\Users\\lif3n')).toBe('C--Users-lif3n');
  });

  it('保留文件夹名中的字面连字符', () => {
    expect(encodeCwd('C:\\Users\\lif3n\\src\\zx-ai-chat2')).toBe('C--Users-lif3n-src-zx-ai-chat2');
  });

  it('盘符大小写保留', () => {
    expect(encodeCwd('c:\\Users\\lif3n')).toBe('c--Users-lif3n');
  });

  it('编码 posix 路径（前导分隔符变成前导 -）', () => {
    expect(encodeCwd('/home/alice/project')).toBe('-home-alice-project');
  });
});

describe('decodeCwdHeuristic', () => {
  it('尽力恢复 Windows 盘符路径', () => {
    // 注意：有歧义——文件夹名里的字面 `-` 无法与分隔符区分。
    // 这正是应用从 jsonl 读取 `cwd` 而非反解目录名的原因。
    expect(decodeCwdHeuristic('C--Users-lif3n-src-demo')).toBe('C:\\Users\\lif3n\\src\\demo');
  });

  it('已知会错解字面连字符（文档化的限制）', () => {
    expect(decodeCwdHeuristic('C--Users-lif3n-src-zx-ai-chat2'))
      .toBe('C:\\Users\\lif3n\\src\\zx\\ai\\chat2'); // 结果错误，但符合预期
  });
});