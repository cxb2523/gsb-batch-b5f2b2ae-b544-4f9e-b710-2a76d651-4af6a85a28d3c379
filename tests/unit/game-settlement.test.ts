import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGameSettlementGate } from '../../src/components/game/game-settlement';

describe('game settlement gate', () => {
  it('allows a round to settle only once', () => {
    const gate = createGameSettlementGate();
    const settleCalls: string[] = [];
    const settle = (roundId: string) => {
      if (gate.trySettle(roundId)) settleCalls.push(roundId);
    };

    settle('round-a');
    settle('round-a');
    settle('round-a');

    assert.deepEqual(settleCalls, ['round-a']);
    assert.equal(gate.isSettled('round-a'), true);
  });

  it('lets a new round settle after an earlier round finished', () => {
    const gate = createGameSettlementGate();

    assert.equal(gate.trySettle('round-a'), true);
    assert.equal(gate.trySettle('round-b'), true);
    assert.equal(gate.trySettle('round-a'), false);
    assert.equal(gate.trySettle('round-b'), false);
  });

  it('refuses to settle without a round id', () => {
    const gate = createGameSettlementGate();
    assert.equal(gate.trySettle(''), false);
    assert.equal(gate.isSettled(''), false);
  });

  it('keeps rounds with the same score independent', () => {
    const gate = createGameSettlementGate();
    assert.equal(gate.trySettle('round-1'), true);
    assert.equal(gate.trySettle('round-2'), true);
    assert.equal(gate.isSettled('round-1'), true);
    assert.equal(gate.isSettled('round-2'), true);
  });
});
