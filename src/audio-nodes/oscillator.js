import React from 'react';
import RScheduledSource from './../base/scheduled-source.js';

export default class ROscillator extends RScheduledSource {
  constructor(props) {
    super(props);

    this.params = {
      frequency: props.frequency,
      detune: props.detune,
      type: props.type,
      periodicWave: props.periodicWave
    };

    this.readyToPlay = true;
  }

  createNode() {
    const node = this.context.audio.createOscillator();

    if (this.props.periodicWave) {
      node.setPeriodicWave(this.props.periodicWave);
    }

    return node;
  }

  componentWillReceiveProps(nextProps) {
    super.componentWillReceiveProps(nextProps);

    if (this.node && this.props.periodicWave !== nextProps.periodicWave) {
      this.node.setPeriodicWave(nextProps.periodicWave);
    }
  }
}
