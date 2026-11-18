import React from 'react';
import RScheduledSource from './../base/scheduled-source.js';

export default class RBufferSource extends RScheduledSource {
  constructor(props) {
    super(props);

    this.params = {
      buffer: props.buffer || null,
      detune: props.detune || 0,
      loop: props.loop || false,
      loopStart: props.loopStart || 0,
      loopEnd: props.loopEnd || 0,
      playbackRate: props.playbackRate || 1
    };
  }

  createNode() {
    return this.context.audio.createBufferSource();
  }

  componentDidMount() {
    this.readyToPlay = !!this.props.buffer;
    super.componentDidMount();
  }

  // a new buffer means the source has to be rescheduled
  shouldStartWithPropsChange(prevProps, currentProps) {
    return prevProps.buffer !== currentProps.buffer;
  }

  componentDidUpdate(prevProps, prevState) {
    this.readyToPlay = !!this.props.buffer;
    super.componentDidUpdate(prevProps, prevState);
  }
}
