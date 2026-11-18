import React from 'react';
import RAudioNode from './audio-node.js';

/**
 * Any RAudioNode that can be scheduled to start/end is a RScheduledSource
 *
 * Schedulable sources (oscillators, buffer sources, ...) are single-use in
 * Web Audio: once they end, the browser removes them from the graph and they
 * can never be restarted. This class therefore owns the whole
 * "rebuild on ended" lifecycle:
 *
 *  - `instantiateNode()` always produces a *fresh* Web Audio node, applies the
 *    current props to it and registers it under the current identifier.
 *  - `onEnded()` rebuilds the node and reconnects it to the current
 *    destination, but never after the component has unmounted and never in
 *    response to a stale event from a replaced node.
 *  - `schedule()` only ever calls `start`/`stop` on the current, live node.
 *
 * @class      RScheduledSource (name)
 */
export default class RScheduledSource extends RAudioNode {
  constructor(props) {
    super(props);
    this.readyToPlay = false;
    this.playbackScheduled = false;
    // set in componentWillUnmount so that a late `ended` event
    // can neither rebuild the node nor touch the node registry
    this.unmounted = false;

    this.onEnded = this.onEnded.bind(this);
    this.schedule = this.schedule.bind(this);
    this.instantiateNode = this.instantiateNode.bind(this);
  }

  /**
   * Creates the raw Web Audio node (e.g. `context.createOscillator()`).
   * Must be implemented by subclasses. Should not connect, register or
   * start the node - `instantiateNode` takes care of that.
   */
  createNode() {
    throw new Error('RScheduledSource subclasses must implement createNode()');
  }

  /**
   * (Re)builds the internal AudioNode from the current props.
   * Detaches the previous node (if any), applies the current props to the
   * fresh node and points the node registry at it, so that at any moment
   * there is exactly one valid node per component instance.
   */
  instantiateNode() {
    const previousNode = this.node;

    if (previousNode) {
      previousNode.removeEventListener('ended', this.onEnded);
      try {
        previousNode.disconnect();
      } catch (e) {
        // the previous node may already be fully disconnected - that's fine
      }
    }

    this.node = this.createNode();
    this.node.addEventListener('ended', this.onEnded);

    // migrate the registry entry to the fresh node
    this.context.nodes.set(this.props.identifier, this.node);

    // (re)apply the current props (frequency, type, buffer, ...) to the fresh node
    this.updateParams(this.props);

    return this.node;
  }

  onEnded(e) {
    // never rebuild after unmount, and ignore events from replaced nodes
    if (this.unmounted) return;
    if (e && e.target && e.target !== this.node) return;

    this.playbackScheduled = false;

    // Web Audio removes the node from the graph once it ends,
    // so reinstantiate it with the current props and reconnect it
    // to the current destination
    this.instantiateNode();
    this.connectToAllDestinations(this.props.destination, this.node);

    if (this.props.onEnded) this.props.onEnded(e);
  }

  schedule() {
    const startIsNumber = typeof this.props.start === 'number';
    const stopIsNumber = typeof this.props.stop === 'number';

    const shouldScheduleStart =
      startIsNumber &&
      this.readyToPlay &&
      !this.playbackScheduled &&
      (!stopIsNumber || this.props.start < this.props.stop);

    if (shouldScheduleStart) {
      this.node.start(this.props.start || 0, this.props.offset || 0, this.props.duration);
      this.playbackScheduled = true;
    }

    // only schedule a stop on a node that is actually playing/scheduled -
    // never on a fresh or already-ended node
    if (stopIsNumber && this.playbackScheduled) {
      this.node.stop(this.props.stop);
    }
  }

  /**
  Overriding this method enables sources to specify special conditions when playback should be rescheduled.
  e.g. BufferSource should be rescheduled if a new buffer is provided
  **/
  shouldStartWithPropsChange() {
    return false;
  }

  componentWillMount() {
    super.componentWillMount();
    this.instantiateNode();
  }

  componentDidMount() {
    super.componentDidMount();
    this.schedule();
  }

  componentDidUpdate(prevProps, prevState) {
    super.componentDidUpdate(prevProps, prevState);

    const sourcePropsChanged = this.shouldStartWithPropsChange(prevProps, this.props);

    // if source-defining props (e.g. the buffer) changed mid-playback,
    // the current node can no longer be reused - rebuild it before rescheduling
    if (sourcePropsChanged && this.playbackScheduled) {
      this.playbackScheduled = false;
      this.instantiateNode();
      this.connectToAllDestinations(this.props.destination, this.node);
    }

    if (prevProps.start !== this.props.start ||
        prevProps.stop !== this.props.stop ||
        sourcePropsChanged) {
      this.schedule();
    }
  }

  componentWillUnmount() {
    // block any late `ended` event from rebuilding the node
    // or writing to the node registry after unmount
    this.unmounted = true;

    if (this.node) {
      this.node.removeEventListener('ended', this.onEnded);
    }

    super.componentWillUnmount();
  }
}
