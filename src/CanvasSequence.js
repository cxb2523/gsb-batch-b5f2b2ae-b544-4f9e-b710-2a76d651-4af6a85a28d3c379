/*
 * Author: Michael van der Kamp
 *
 * This file provides the definition of the CanvasSequence class.
 */

'use strict';

const CanvasAtom = require('./CanvasAtom.js');
const instructions = require('./CanvasInstructions.js');

// Mark properties as intended for internal use.
const symbols = Object.freeze({
  'sequence': Symbol.for('sequence'),
  'push': Symbol.for('push'),
  'fromJSON': Symbol.for('fromJSON'),
});

/**
 * Combine an instruction failure with a restore() failure into a single
 * throwable that preserves both for diagnostic purposes. The original
 * instruction failure takes precedence: it is the value that gets thrown
 * whenever it is capable of carrying the restore failure as extra data.
 *
 * @param {*} failure - The error thrown while executing an atom.
 * @param {*} restoreError - The error thrown by context.restore().
 * @return {*} A throwable preserving both failures.
 */
function combineFailures(failure, restoreError) {
  if (failure !== null
    && (typeof failure === 'object' || typeof failure === 'function')) {
    try {
      Object.defineProperty(failure, 'restoreError', {
        'value': restoreError,
        'configurable': true,
        'writable': true,
      });
      return failure;
    }
    catch (ignore) {
      // Fall through to the wrapper below if the original failure is frozen
      // or otherwise cannot be annotated.
    }
  }
  const combined = new Error(
    'CanvasSequence execution failed and the canvas state could not be '
    + 'restored; see the "cause" and "restoreError" properties for details.',
  );
  combined.cause = failure;
  combined.restoreError = restoreError;
  return combined;
}

/**
 * A CanvasSequence is a linear collection of CanvasAtoms, capable of being
 * executed on a CanvasRenderingContext2D.
 *
 * @param {CanvasSequence} [data=null] - An unrevived (i.e. freshly transmitted)
 * CanvasSequence. If present, the constructor revives the sequence. Note that
 * an already revived CanvasSequence cannot be used as the argument here.
 */
class CanvasSequence {
  constructor(data = null) {
    /**
     * The CanvasAtoms that form the sequence.
     *
     * @private
     * @type {CanvasAtom[]}
     */
    this[symbols.sequence] = [];

    // If data is present, assume it is a CanvasSequence that needs reviving.
    if (data) {
      this[symbols.fromJSON](data);
    }
  }

  /**
   * Revive the sequence from transmitted JSON data.
   *
   * @private
   * @param {CanvasSequence} [data={}]
   */
  [symbols.fromJSON](data = { 'sequence': [] }) {
    data.sequence.forEach(({ type, inst, args }) => {
      this[symbols.push](type, inst, args);
    });
  }

  /**
   * Push a new CanvasAtom onto the end of the sequence.
   *
   * @private
   * @param {string} type - The type of CanvasAtom to push.
   * @param {string} inst - The canvas context instruction.
   * @param {*[]} args - The arguments to the canvas context instruction.
   */
  [symbols.push](type, inst, args) {
    this[symbols.sequence].push(new CanvasAtom(type, inst, args));
  }

  /**
   * Execute the sequence on the given context.
   *
   * The context state is saved before the first atom runs and restored after
   * the last one, even if an atom throws, so no state leaks to whatever the
   * caller draws next. Because save/restore is a stack on the context, each
   * execution only ever restores the layer it saved itself, which makes
   * nested and reentrant executions safe. All bookkeeping is kept in local
   * variables, so executing the same sequence twice (or concurrently, e.g.
   * nested) behaves identically and never mutates the atoms.
   *
   * If an atom throws, the original error is rethrown after the context has
   * been restored; a failing restore() cannot mask it. If restore() itself
   * fails, that failure is preserved for diagnosis (thrown directly when
   * nothing else failed, otherwise attached to the original error as
   * "restoreError").
   *
   * @param {CanvasRenderingContext2D} context
   */
  execute(context) {
    context.save();
    let failed = false;
    let failure = undefined;
    try {
      this[symbols.sequence].forEach(a => a.execute(context));
    }
    catch (e) {
      failed = true;
      failure = e;
    }
    try {
      context.restore();
    }
    catch (restoreError) {
      if (failed) {
        throw combineFailures(failure, restoreError);
      }
      throw restoreError;
    }
    if (failed) {
      throw failure;
    }
  }

  /**
   * Export a JSON serialized version of the sequence, ready for transmission.
   *
   * @return {CanvasSequence} In JSON serialized form.
   */
  toJSON() {
    return { 'sequence': this[symbols.sequence] };
  }
}

instructions.METHODS.forEach((m) => {
  Object.defineProperty(CanvasSequence.prototype, m, {
    'value': function pushMethodCall(...args) {
      this[symbols.push](CanvasAtom.METHOD, m, args);
    },
    'writable': false,
    'enumerable': true,
    'configurable': false,
  });
});

instructions.PROPERTIES.forEach((p) => {
  Object.defineProperty(CanvasSequence.prototype, p, {
    get() { throw `Invalid canvas sequencer interaction, cannot get ${p}.`; },
    set(v) { this[symbols.push](CanvasAtom.PROPERTY, p, [v]); },
    'enumerable': true,
    'configurable': false,
  });
});

module.exports = CanvasSequence;
