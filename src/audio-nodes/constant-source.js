import React from 'react';
import RScheduledSource from './../base/scheduled-source.js';

export default class RConstantSource extends RScheduledSource {
  constructor(props) {
    super(props);

    this.params = {
      offset: props.offset
    };

    this.readyToPlay = true;
  }

  createNode() {
    return this.context.audio.createConstantSource();
  }
}
