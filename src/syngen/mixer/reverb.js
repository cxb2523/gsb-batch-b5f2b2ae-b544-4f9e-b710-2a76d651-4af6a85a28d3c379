/**
 * Provides a auxiliary send for global reverb processing.
 * Because `ConvolverNode`s are quite intensive, implementations are encouraged to leverage this to provide a single global reverb.
 * @augments syngen.tool.pubsub
 * @namespace
 * @see syngen.mixer.send.reverb
 */
syngen.mixer.reverb = (() => {
  const context = syngen.context(),
    output = syngen.mixer.createBus(),
    pubsub = syngen.tool.pubsub.create()

  let active = true,
    convolver,
    delay,
    highpass,
    impulse = syngen.buffer.impulse({
      buffer: syngen.buffer.whiteNoise({
        channels: 2,
        duration: 1,
      }),
      power: 4,
    }),
    input,
    lowpass

  buildGraph()

  function buildGraph({
    delayTime = 1/64,
    highpassFrequency = syngen.const.minFrequency,
    lowpassFrequency = syngen.const.maxFrequency,
    preGain = 1,
  } = {}) {
    input = context.createGain()
    input.gain.value = preGain

    delay = context.createDelay()
    delay.delayTime.value = delayTime

    highpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = highpassFrequency

    lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = lowpassFrequency

    convolver = context.createConvolver()
    convolver.buffer = impulse

    input.connect(delay)
    delay.connect(highpass)
    highpass.connect(lowpass)
    lowpass.connect(convolver)
    convolver.connect(output)
  }

  function destroyGraph() {
    input.disconnect()
    delay.disconnect()
    highpass.disconnect()
    lowpass.disconnect()
    convolver.disconnect()
  }

  return pubsub.decorate({
    /**
     * Creates a `GainNode` that's connected to the reverb input.
     * @memberof syngen.mixer.reverb
     * @returns {GainNode}
     */
    createBus: () => {
      const gain = context.createGain()
      gain.connect(input)
      return gain
    },
    /**
     * Built-in gain models.
     * @namespace syngen.mixer.reverb.gainModel
     */
    gainModel: {},
    /**
     * Returns the input `GainNode`.
     * Buses created before a {@link syngen.mixer.reverb.rebuildFilters|rebuild} must reconnect to this node.
     * @memberof syngen.mixer.reverb
     * @returns {GainNode}
     */
    input: () => input,
    /**
     * Returns whether the processing is active.
     * @memberof syngen.mixer.reverb
     * @returns {Boolean}
     */
    isActive: () => active,
    /**
     * Returns the output node for the send.
     * @deprecated
     * @memberof syngen.mixer.reverb
     * @returns {GainNode}
     */
    output: () => output,
    /**
     * Exposes the parameters associated with reverb processing.
     * @memberof syngen.mixer.reverb
     * @property {AudioParam} delay
     * @property {AudioParam} gain
     * @property {Object} highpass
     * @property {AudioParam} highpass.frequency
     * @property {Object} lowpass
     * @property {AudioParam} lowpass.frequency
     * @property {AudioParam} preGain
     */
    param: {
      delay: delay.delayTime,
      gain: output.gain,
      highpass: {
        frequency: highpass.frequency,
      },
      lowpass: {
        frequency: lowpass.frequency,
      },
      preGain: input.gain,
    },
    /**
     * Occasionally the filters can enter an unstable or bad state.
     * This provides a solution for replacing them with stable filters.
     * The entire graph is rebuilt with its current state, so buses connected to a previous input must reconnect to the new {@link syngen.mixer.reverb.input|input}.
     * @fires syngen.mixer.reverb#event:rebuild
     * @memberof syngen.mixer.reverb
     * @see syngen.mixer.rebuildFilters
     */
    rebuildFilters: function () {
      const delayTime = delay.delayTime.value,
        highpassFrequency = highpass.frequency.value,
        lowpassFrequency = lowpass.frequency.value,
        preGain = input.gain.value

      destroyGraph()

      buildGraph({
        delayTime,
        highpassFrequency,
        lowpassFrequency,
        preGain,
      })

      if (!active) {
        input.disconnect(delay)
      }

      this.param.delay = delay.delayTime
      this.param.preGain = input.gain
      this.param.highpass.frequency = highpass.frequency
      this.param.lowpass.frequency = lowpass.frequency

      /**
       * Fired whenever the graph is rebuilt.
       * @event syngen.mixer.reverb#event:rebuild
       */
      pubsub.emit('rebuild')

      return this
    },
    /**
     * Sets the active state.
     * Implementations can disable processing for a performance boost.
     * @fires syngen.mixer.reverb#event:activate
     * @fires syngen.mixer.reverb#event:deactivate
     * @memberof syngen.mixer.reverb
     * @param {Boolean} state
     */
    setActive: function (state) {
      if (active == state) {
        return this
      }

      active = Boolean(state)

      if (active) {
        /**
         * Fired whenever the send is activated.
         * @event syngen.mixer.reverb#event:activate
         */
        pubsub.emit('activate')
        input.connect(delay)
      } else {
        /**
         * Fired whenever the send is deactivated.
         * @event syngen.mixer.reverb#event:deactivate
         */
        pubsub.emit('deactivate')
        input.disconnect(delay)
      }

      return this
    },
    /**
     * Sets the impulse buffer for the inner `ConvolverNode`.
     * To prevent pops and clicks, the tail of the previous buffer persists until it fades out.
     * @memberof syngen.mixer.reverb
     * @param {BufferSource} buffer
     */
    setImpulse: function (buffer) {
      impulse = buffer

      // The previous convolver remains connected to the output so its tail fades out
      lowpass.disconnect()

      convolver = context.createConvolver()
      convolver.buffer = impulse

      lowpass.connect(convolver)
      convolver.connect(output)

      return this
    },
  })
})()
