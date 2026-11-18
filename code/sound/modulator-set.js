// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.com
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

class ModulatorSet {

    #implementation = {
        isFmEnabled: true,
        isAmEnabled: true,
        preservedFmMasterGain: undefined,
        preservedAmMasterGain: undefined,
    };

    constructor(audioContext, soundSourceFrequency) {
        if (audioContext)
            this.context = audioContext;
        this.#implementation.soundSourceFrequency = soundSourceFrequency; // undefined for absolute-frequency modulator
        this.#implementation.safeDisconnect = node => {
            try { node.disconnect(); } catch (ex) { /* node has no connections: nothing to tear down */ }
        }; //safeDisconnect
        this.#implementation.frequencyModulatorList = [];
        this.#implementation.amplitudeModulatorList = [];
        // Every target audio parameter this set modulates. A tone-level set holds
        // its own single parameter per kind; an instrument-level set holds one
        // parameter per tone, all driven by the same master depth node.
        this.#implementation.frequencyAudioParameters = [];
        this.#implementation.amplitudeAudioParameters = [];
        this.#implementation.disposeModulatorList = modulatorList => {
            for (let modulator of modulatorList) {
                modulator.disconnect(); // detach from the master depth node
                modulator.deactivate(); // stop and disconnect the oscillator and its depth node
            } //loop
            modulatorList.splice(0);
        }; //disposeModulatorList
        this.#implementation.populate = (modulatorList, masterDepthNode, modulationData) => {
            this.#implementation.disposeModulatorList(modulatorList);
            if (masterDepthNode)
                masterDepthNode.gain.value = modulationData.masterDepth;
            for (let dataElement of modulationData.modes) {
                let frequency = dataElement.frequency;
                if (this.#implementation.soundSourceFrequency)
                    frequency *= this.#implementation.soundSourceFrequency;
                const modulator = new Modulator(this.context);
                modulator.depth = dataElement.depth;
                modulator.frequency = frequency;
                modulatorList.push(modulator);
            } //loop
        }; //this.#implementation.populate
        // Connects every modulator of a list to its single master depth node.
        // The nodes are always fresh (old ones were disposed during populate),
        // so no duplicate connections can arise.
        this.#implementation.routeModulators = (modulatorList, masterDepthNode) => {
            for (let modulator of modulatorList)
                modulator.connect(masterDepthNode);
        }; //routeModulators
        this.#implementation.baseDeactivate = _ => {
            this.#implementation.disposeModulatorList(this.#implementation.frequencyModulatorList);
            this.#implementation.disposeModulatorList(this.#implementation.amplitudeModulatorList);
            if (this.#implementation.frequencyModulatatioMasterDepth)
                this.#implementation.safeDisconnect(this.#implementation.frequencyModulatatioMasterDepth);
            if (this.#implementation.amplitudeModulatatioMasterDepth)
                this.#implementation.safeDisconnect(this.#implementation.amplitudeModulatatioMasterDepth);
        }; //baseDeactivate
    } //constructor

    // interface:

    set frequencyModulationData(dataset) {
        this.#implementation.populate(this.#implementation.frequencyModulatorList, this.#implementation.frequencyModulatatioMasterDepth, dataset);
        this.#implementation.preservedFmMasterGain = dataset.masterDepth;
        if (this.#implementation.frequencyModulatatioMasterDepth) {
            if (!this.#implementation.isFmEnabled)
                this.#implementation.frequencyModulatatioMasterDepth.gain.value = 0;
            // master node persists across rebuilds and stays connected to every
            // target parameter; only the freshly created modulators are re-linked
            this.#implementation.routeModulators(this.#implementation.frequencyModulatorList,
                this.#implementation.frequencyModulatatioMasterDepth);
        } //if
    } //set frequencyModulationData
    set amplitudeModulationData(dataset) {
        this.#implementation.populate(this.#implementation.amplitudeModulatorList, this.#implementation.amplitudeModulatatioMasterDepth, dataset);
        this.#implementation.preservedAmMasterGain = dataset.masterDepth;
        if (this.#implementation.amplitudeModulatatioMasterDepth) {
            if (!this.#implementation.isAmEnabled)
                this.#implementation.amplitudeModulatatioMasterDepth.gain.value = 0;
            this.#implementation.routeModulators(this.#implementation.amplitudeModulatorList,
                this.#implementation.amplitudeModulatatioMasterDepth);
        } //if
    } //set amplitudeModulationData

    connectToAudioParameters(frequencyAudioParameter, amplitudeAudioParameter) {
        this.#implementation.frequencyAudioParameter = frequencyAudioParameter;
        this.#implementation.amplitudeAudioParameter = amplitudeAudioParameter;
        if (frequencyAudioParameter) {
            if (!this.#implementation.frequencyModulatatioMasterDepth) {
                this.#implementation.frequencyModulatatioMasterDepth = new GainNode(this.context, { gain: 1 });
                // modulators may already have been populated before the node existed
                this.#implementation.routeModulators(this.#implementation.frequencyModulatorList,
                    this.#implementation.frequencyModulatatioMasterDepth);
            } //if
            // The master depth node reaches each target audio parameter exactly once;
            // repeated calls for the same parameter never create duplicate connections.
            if (!this.#implementation.frequencyAudioParameters.includes(frequencyAudioParameter)) {
                this.#implementation.frequencyAudioParameters.push(frequencyAudioParameter);
                this.#implementation.frequencyModulatatioMasterDepth.connect(frequencyAudioParameter);
            } //if
        } //if
        if (amplitudeAudioParameter) {
            if (!this.#implementation.amplitudeModulatatioMasterDepth) {
                this.#implementation.amplitudeModulatatioMasterDepth = new GainNode(this.context, { gain: 1 });
                this.#implementation.routeModulators(this.#implementation.amplitudeModulatorList,
                    this.#implementation.amplitudeModulatatioMasterDepth);
            } //if
            if (!this.#implementation.amplitudeAudioParameters.includes(amplitudeAudioParameter)) {
                this.#implementation.amplitudeAudioParameters.push(amplitudeAudioParameter);
                this.#implementation.amplitudeModulatatioMasterDepth.connect(amplitudeAudioParameter);
            } //if
        } //if
    } //connectToAudioParameters

    set frequencyModulationEnable(enable) {
        this.#implementation.isFmEnabled = enable;
        const node = this.#implementation.frequencyModulatatioMasterDepth;
        if (!node) return;
        if (!enable) {
            this.#implementation.preservedFmMasterGain = node.gain.value;
            node.gain.value = 0;
        } else {
            if (this.#implementation.preservedFmMasterGain == undefined)
                this.#implementation.preservedFmMasterGain = node.gain.value;
            node.gain.value = this.#implementation.preservedFmMasterGain;
        } //if
    } //set frequencyModulationEnable
    get frequencyModulationEnable() { return this.#implementation.isFmEnabled; }

    set amplitudeModulationEnable(enable) {
        this.#implementation.isAmEnabled = enable;
        const node = this.#implementation.amplitudeModulatatioMasterDepth;
        if (!node) return;
        if (!enable) {
            this.#implementation.preservedAmMasterGain = node.gain.value;
            node.gain.value = 0;
        } else {
            if (this.#implementation.preservedAmMasterGain == undefined)
                this.#implementation.preservedAmMasterGain = node.gain.value;
            node.gain.value = this.#implementation.preservedAmMasterGain;
        } //if
    } //set amplitudeModulationEnable
    get amplitudeModulationEnable() { return this.#implementation.isAmEnabled; }

    baseDeactivate() { this.#implementation.baseDeactivate(); }

} //class ModulatorSet
