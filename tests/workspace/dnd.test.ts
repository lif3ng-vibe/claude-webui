import { describe, it, expect } from 'vitest';
import { resolveZone, chipDropIndex, readPayload, MIME_TAB, MIME_GROUP, type Rect } from '../../web/src/lib/workspace/dnd';

const rect = (w = 100, h = 100): Rect => ({ left: 0, top: 0, width: w, height: h });

describe('dnd — resolveZone', () => {
  it('左半 → left', () => {
    expect(resolveZone(rect(), 10, 50)).toBe('left');
  });
  it('右半 → right', () => {
    expect(resolveZone(rect(), 90, 50)).toBe('right');
  });
  it('上半中带 → top', () => {
    expect(resolveZone(rect(), 50, 5)).toBe('top');
  });
  it('下半中带 → bottom', () => {
    expect(resolveZone(rect(), 50, 95)).toBe('bottom');
  });
  it('正中 → center', () => {
    expect(resolveZone(rect(), 50, 50)).toBe('center');
  });
  it('左右优先于上下', () => {
    expect(resolveZone(rect(), 5, 5)).toBe('left');
  });
});

describe('dnd — chipDropIndex', () => {
  const cr = rect(40, 20); // chip 在 [0,40]
  it('中点左 → 该索引（before）', () => {
    expect(chipDropIndex(2, 10, cr)).toBe(2);
  });
  it('中点右 → 索引+1（after）', () => {
    expect(chipDropIndex(2, 30, cr)).toBe(3);
  });
});

describe('dnd — readPayload', () => {
  function fakeDrop(data: Record<string, string>): { dataTransfer: { getData: (t: string) => string } } {
    return { dataTransfer: { getData: (type: string) => data[type] ?? '' } };
  }
  it('读 tab 载荷', () => {
    const p = readPayload(fakeDrop({ [MIME_TAB]: JSON.stringify({ tabId: 't1', fromGroupId: 'g1' }) }));
    expect(p).toEqual({ kind: 'tab', tabId: 't1', fromGroupId: 'g1' });
  });
  it('读 group 载荷', () => {
    const p = readPayload(fakeDrop({ [MIME_GROUP]: JSON.stringify({ groupId: 'g2' }) }));
    expect(p).toEqual({ kind: 'group', groupId: 'g2' });
  });
  it('无载荷 → null', () => {
    expect(readPayload(fakeDrop({})).kind).toBeNull();
  });
});
