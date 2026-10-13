import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { interpretDecision } from './approvalGate.js';

// interpretDecision 组合测试 / Combination tests for interpretDecision
// 语义：拒绝信号优先；否则仅当 ok === true（严格布尔）才视为批准。
// Semantics: denial signals take precedence; otherwise approved only when ok === true (strict boolean).

describe('interpretDecision / 审批结果解析', () => {
  it('1. { ok: true } → 批准 / approved', () => {
    const r = interpretDecision({ ok: true });
    assert.equal(r.approved, true);
  });

  it('2. { ok: false, error } → 拒绝 / denied', () => {
    const r = interpretDecision({
      ok: false,
      output: 'x',
      error: { code: 'c', message: 'm', retryable: false },
    });
    assert.equal(r.approved, false);
  });

  it('3. { ok: true, decision: "denied" } → 拒绝信号优先 / denial signal wins', () => {
    const r = interpretDecision({ ok: true, decision: 'denied' });
    assert.equal(r.approved, false);
  });

  it('4. { ok: true, approved: false } → 拒绝信号优先 / denial signal wins', () => {
    const r = interpretDecision({ ok: true, approved: false });
    assert.equal(r.approved, false);
  });

  it('5. { ok: 1 } → 非严格布尔视为拒绝 / non-strict boolean is denied', () => {
    const r = interpretDecision({ ok: 1 });
    assert.equal(r.approved, false);
  });

  it('6. null → 拒绝 / denied', () => {
    const r = interpretDecision(null);
    assert.equal(r.approved, false);
  });

  it('7. { ok: true, approvalId } → 批准并透传审批编号 / approved with approvalId passthrough', () => {
    const r = interpretDecision({ ok: true, approvalId: 'apr_123' });
    assert.equal(r.approved, true);
    assert.equal(r.approvalId, 'apr_123');
  });
});
