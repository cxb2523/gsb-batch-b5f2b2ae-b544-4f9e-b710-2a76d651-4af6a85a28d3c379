/*
 * This test suite is built for the CanvasSequence class.
 */

/* global jest, describe, test, expect */

'use strict';

const CanvasSequence = require('../src/CanvasSequence.js');
const CanvasAtom = require('../src/CanvasAtom.js');

describe('CanvasSequence', () => {
  describe('constructor()', () => {
    test('creates a CanvasSequence', () => {
      // When
      const cs = new CanvasSequence();

      // Then
      expect(cs).toBeInstanceOf(CanvasSequence);
    });
  });

  describe('Instruction types', () => {
    describe(CanvasAtom.METHOD, () => {
      test('records a method call', () => {
        // Given
        const cs = new CanvasSequence();
        const seq = Symbol.for('sequence');

        // When
        cs.arc(0, 1, 2, 3, Math.PI);

        // Then
        expect(cs[seq][0].type).toBe(CanvasAtom.METHOD);
        expect(cs[seq][0].inst).toBe('arc');
        expect(cs[seq][0].args).toEqual([0, 1, 2, 3, Math.PI]);
      });

      test('appends a method after existing instructions', () => {
        // Given
        const cs = new CanvasSequence();
        const seq = Symbol.for('sequence');
        cs.arc(0, 1, 2, 3, Math.PI);

        // When
        cs.save();

        // Then
        expect(cs[seq][1].type).toBe(CanvasAtom.METHOD);
        expect(cs[seq][1].inst).toBe('save');
        expect(cs[seq][1].args).toEqual([]);
      });
    });

    describe(CanvasAtom.PROPERTY, () => {
      test('records a property assignment', () => {
        // Given
        const cs = new CanvasSequence();
        const seq = Symbol.for('sequence');

        // When
        cs.lineJoin = 'bevel';

        // Then
        expect(cs[seq][0].type).toBe(CanvasAtom.PROPERTY);
        expect(cs[seq][0].inst).toBe('lineJoin');
        expect(cs[seq][0].args).toEqual(['bevel']);
      });

      test('appends a property after existing instructions', () => {
        // Given
        const cs = new CanvasSequence();
        const seq = Symbol.for('sequence');
        cs.lineJoin = 'bevel';

        // When
        cs.strokeStyle = 'blue';

        // Then
        expect(cs[seq][1].type).toBe(CanvasAtom.PROPERTY);
        expect(cs[seq][1].inst).toBe('strokeStyle');
        expect(cs[seq][1].args).toEqual(['blue']);
      });

      test('throws when reading a property', () => {
        // Given
        const cs = new CanvasSequence();

        // Then
        expect(() => cs.strokeStyle).toThrow();
      });
    });
  });

  describe('execute(context)', () => {
    // A fake context that mimics canvas save/restore stack semantics for the
    // 'transform' and 'strokeStyle' state, and records a call trace.
    function makeStatefulContext() {
      const calls = [];
      const stack = [];
      const ctx = {
        calls,
        'transform': 0,
        'strokeStyle': 'black',
        'depth': () => stack.length,
        'save': jest.fn(() => {
          stack.push({
            'transform': ctx.transform,
            'strokeStyle': ctx.strokeStyle,
          });
          calls.push('save');
        }),
        'restore': jest.fn(() => {
          calls.push('restore');
          if (stack.length === 0) {
            throw new Error('restore() called with an empty state stack');
          }
          const s = stack.pop();
          ctx.transform = s.transform;
          ctx.strokeStyle = s.strokeStyle;
        }),
        'translate': jest.fn((x) => {
          ctx.transform += x;
          calls.push(`translate:${ctx.transform}`);
        }),
        'arc': jest.fn(() => {
          calls.push('arc');
        }),
      };
      return ctx;
    }

    test('executes instructions in order', () => {
      // Given
      const cs = new CanvasSequence();
      const ctx = {
        'arc': jest.fn(),
        'lineJoin': 'round',
        'strokeStyle': 'red',
        'save': jest.fn(),
        'restore': jest.fn(),
      };
      cs.arc(0, 1, 2, 3, Math.PI);
      cs.lineJoin = 'bevel';
      cs.strokeStyle = 'blue';
      cs.strokeStyle = 'green';

      // When
      cs.execute(ctx);

      // Then
      expect(ctx.arc).toHaveBeenCalledTimes(1);
      expect(ctx.arc).toHaveBeenCalledWith(0, 1, 2, 3, Math.PI);
      expect(ctx.lineJoin).toBe('bevel');
      expect(ctx.strokeStyle).toBe('green');
    });

    test('wraps the atoms in save() and restore()', () => {
      // Given
      const cs = new CanvasSequence();
      const ctx = makeStatefulContext();
      cs.translate(1);
      cs.arc(0, 1, 2, 3, Math.PI);

      // When
      cs.execute(ctx);

      // Then
      expect(ctx.calls).toEqual(['save', 'translate:1', 'arc', 'restore']);
      expect(ctx.depth()).toBe(0);
    });

    test('restores the context state after a successful execution', () => {
      // Given
      const cs = new CanvasSequence();
      const ctx = makeStatefulContext();
      cs.translate(5);
      cs.strokeStyle = 'blue';

      // When
      cs.execute(ctx);

      // Then
      expect(ctx.transform).toBe(0);
      expect(ctx.strokeStyle).toBe('black');
    });

    test('throws when the context cannot save the canvas state', () => {
      // Given
      const sequence = new CanvasSequence();

      // Then
      expect(() => sequence.execute({})).toThrow(TypeError);
    });

    describe('when an atom throws', () => {
      test('still restores the context and rethrows the original error', () => {
        // Given
        const cs = new CanvasSequence();
        const ctx = makeStatefulContext();
        const boom = new Error('boom');
        ctx.arc.mockImplementation(() => {
          throw boom;
        });
        cs.translate(5);
        cs.arc(0, 1, 2, 3, Math.PI);
        cs.translate(10);

        // When
        const thrown = (() => {
          try {
            cs.execute(ctx);
          }
          catch (e) {
            return e;
          }
          return null;
        })();

        // Then
        expect(thrown).toBe(boom);
        expect(ctx.restore).toHaveBeenCalledTimes(1);
        expect(ctx.depth()).toBe(0);
        expect(ctx.transform).toBe(0);
        // The atoms after the failing one were skipped.
        expect(ctx.calls).toEqual(['save', 'translate:5', 'restore']);
      });

      test('keeps the original error if restore() also fails', () => {
        // Given
        const cs = new CanvasSequence();
        const boom = new Error('boom');
        const restoreError = new Error('restore failed');
        const ctx = {
          'save': jest.fn(),
          'restore': jest.fn(() => { throw restoreError; }),
          'arc': jest.fn(() => { throw boom; }),
        };
        cs.arc(0, 1, 2, 3, Math.PI);

        // When
        const thrown = (() => {
          try {
            cs.execute(ctx);
          }
          catch (e) {
            return e;
          }
          return null;
        })();

        // Then
        expect(thrown).toBe(boom);
        expect(thrown.restoreError).toBe(restoreError);
      });

      test('preserves a non-object failure if restore() also fails', () => {
        // Given
        const cs = new CanvasSequence();
        const restoreError = new Error('restore failed');
        const ctx = {
          'save': jest.fn(),
          'restore': jest.fn(() => { throw restoreError; }),
          'arc': jest.fn(() => {
            throw 'string failure';
          }),
        };
        cs.arc(0, 1, 2, 3, Math.PI);

        // When
        const thrown = (() => {
          try {
            cs.execute(ctx);
          }
          catch (e) {
            return e;
          }
          return null;
        })();

        // Then
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.cause).toBe('string failure');
        expect(thrown.restoreError).toBe(restoreError);
      });
    });

    describe('when restore() throws', () => {
      test('propagates the restore failure', () => {
        // Given
        const cs = new CanvasSequence();
        const restoreError = new Error('restore failed');
        const ctx = {
          'save': jest.fn(),
          'restore': jest.fn(() => { throw restoreError; }),
          'arc': jest.fn(),
        };
        cs.arc(0, 1, 2, 3, Math.PI);

        // Then
        expect(() => cs.execute(ctx)).toThrow(restoreError);
      });
    });

    describe('when executed twice', () => {
      test('produces the same result both times without mutating itself', () => {
        // Given
        const cs = new CanvasSequence();
        const ctx = makeStatefulContext();
        cs.translate(5);
        cs.strokeStyle = 'blue';
        cs.arc(0, 1, 2, 3, Math.PI);
        const before = JSON.stringify(cs.toJSON());

        // When
        cs.execute(ctx);
        const firstRun = [...ctx.calls];
        cs.execute(ctx);
        const secondRun = ctx.calls.slice(firstRun.length);

        // Then
        expect(secondRun).toEqual(firstRun);
        expect(ctx.save).toHaveBeenCalledTimes(2);
        expect(ctx.restore).toHaveBeenCalledTimes(2);
        expect(ctx.depth()).toBe(0);
        expect(ctx.transform).toBe(0);
        expect(ctx.strokeStyle).toBe('black');
        expect(JSON.stringify(cs.toJSON())).toBe(before);
      });
    });

    describe('when nested', () => {
      test('inner execution only restores its own saved layer', () => {
        // Given
        const inner = new CanvasSequence();
        inner.translate(100);
        const outer = new CanvasSequence();
        outer.translate(1);
        outer.fill();
        outer.translate(10);
        const ctx = makeStatefulContext();
        ctx.fill = jest.fn(() => inner.execute(ctx));

        // When
        outer.execute(ctx);

        // Then: the inner restore pops the inner save, so the outer
        // translate(10) still applies on top of the outer translate(1).
        expect(ctx.calls).toEqual([
          'save',
          'translate:1',
          'save',
          'translate:101',
          'restore',
          'translate:11',
          'restore',
        ]);
        expect(ctx.depth()).toBe(0);
        expect(ctx.transform).toBe(0);
      });

      test('a failing inner execution restores both layers', () => {
        // Given
        const boom = new Error('inner boom');
        const inner = new CanvasSequence();
        inner.translate(100);
        inner.arc(0, 1, 2, 3, Math.PI);
        const outer = new CanvasSequence();
        outer.translate(1);
        outer.fill();
        outer.translate(10);
        const ctx = makeStatefulContext();
        ctx.arc.mockImplementation(() => {
          throw boom;
        });
        ctx.fill = jest.fn(() => inner.execute(ctx));

        // When
        const thrown = (() => {
          try {
            outer.execute(ctx);
          }
          catch (e) {
            return e;
          }
          return null;
        })();

        // Then
        expect(thrown).toBe(boom);
        expect(ctx.calls).toEqual([
          'save',
          'translate:1',
          'save',
          'translate:101',
          'restore',
          'restore',
        ]);
        expect(ctx.depth()).toBe(0);
        expect(ctx.transform).toBe(0);
      });
    });
  });

  describe('toJSON()', () => {
    test('produces JSON-serializable data', () => {
      // Given
      const cs = new CanvasSequence();
      cs.fillStyle = 'blue';
      cs.fillRect(5, 6, 7, 8);

      // When
      const data = cs.toJSON();

      // Then
      expect(typeof data).toBe('object');
      const tojson = JSON.stringify(data);
      const fromjson = JSON.parse(tojson);
      expect(typeof fromjson).toBe('object');
      expect(fromjson.sequence).toBeInstanceOf(Array);
    });
  });

  describe('[@@fromJSON](data)', () => {
    const fromJSON = Symbol.for('fromJSON');
    const sequence = Symbol.for('sequence');

    test('reproduces the original sequence', () => {
      // Given
      const cs = new CanvasSequence();
      cs.fillStyle = 'blue';
      cs.fillRect(5, 6, 7, 8);
      const data = cs.toJSON();
      const seq = new CanvasSequence();

      // When
      seq[fromJSON](data);

      // Then
      expect(seq).toEqual(cs);
    });

    test('leaves the sequence empty when no data is provided', () => {
      // Given
      const seq = new CanvasSequence();

      // When
      seq[fromJSON]();

      // Then
      expect(seq[sequence]).toHaveLength(0);
    });

    test('rejects malformed data without a sequence array', () => {
      // Given
      const seq = new CanvasSequence();

      // Then
      expect(() => seq[fromJSON]({})).toThrow(TypeError);
      expect(() => seq[fromJSON]({ 'sequence': null })).toThrow(TypeError);
    });
  });
});
