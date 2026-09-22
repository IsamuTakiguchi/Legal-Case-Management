import { describe, it, expect } from 'vitest';
import { schedulingLink, alertLink } from './alertLink';

describe('要確認から中身の画面へ', () => {
  it('会話から始めた日程調整は、会話のその 1 件へ', () => {
    expect(schedulingLink({ sessionId: 3, conversationId: 4, caseId: null })).toEqual({ to: '/inbox/4?session=3', label: '日程調整を開く' });
  });

  it('事件から始めた日程調整は、事件のその 1 件へ', () => {
    expect(schedulingLink({ sessionId: 2, conversationId: null, caseId: 1 })).toEqual({ to: '/cases/1?session=2', label: '日程調整を開く' });
  });

  it('会話と事件の両方があれば、会話を優先する（やり取りの続きから催促できる）', () => {
    expect(schedulingLink({ sessionId: 5, conversationId: 9, caseId: 1 }).to).toBe('/inbox/9?session=5');
  });

  it('行き先が分からない古いお知らせは、予定ページへ逃がす', () => {
    expect(schedulingLink({ sessionId: 7 })).toEqual({ to: '/calendar', label: '予定を見る' });
    expect(schedulingLink({})).toEqual({ to: '/calendar', label: '予定を見る' });
  });

  it('ほかの種類も、行き先が分かるものはそこへ', () => {
    expect(alertLink({ type: 'scheduling_stale', payload: { sessionId: 2, caseId: 1 } })).toBe('/cases/1?session=2');
    expect(alertLink({ type: 'waiting_overdue', payload: { conversationId: 8 } })).toBe('/inbox/8');
    expect(alertLink({ type: 'creditor_overdue', payload: { caseId: 3 } })).toBe('/cases/3');
    // 分からないものは要確認の一覧へ（押しても何も起きない、を作らない）
    expect(alertLink({ type: 'unlinked_contact', payload: {} })).toBe('/alerts');
    expect(alertLink({ type: 'waiting_overdue', payload: null })).toBe('/alerts');
  });
});
