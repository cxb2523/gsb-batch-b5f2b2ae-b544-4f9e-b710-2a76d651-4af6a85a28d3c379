// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.com
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

class ChainNode {

    #implementation = {
        collection: [],
        upstream: undefined,
        target: undefined,
        isEnabled: true,
        routed: false, // true while upstream actually reaches the target through this chain
    };

    constructor(upstream, target) {
        this.#implementation.upstream = upstream;
        this.#implementation.target = target;
        this.#implementation.safeDisconnect = node => {
            try { node.disconnect(); } catch (ex) { /* node has no connections: nothing to tear down */ }
        }; //safeDisconnect
        const safeDisconnect = this.#implementation.safeDisconnect;
        // Removes every route previously established by this chain, so any
        // re-routing starts from a known, empty state (no duplicate or stale links).
        this.#implementation.clearRouting = () => {
            if (!this.#implementation.routed) return;
            safeDisconnect(this.#implementation.upstream);
            if (this.#implementation.collection.length > 0)
                safeDisconnect(this.#implementation.collection[this.#implementation.collection.length - 1]);
            this.#implementation.routed = false;
        }; //clearRouting
        // Establishes exactly one route from upstream to target:
        // either through the populated chain or directly when it is empty/disabled.
        this.#implementation.route = () => {
            this.#implementation.clearRouting();
            if (this.#implementation.isEnabled && this.#implementation.collection.length > 0) {
                this.#implementation.upstream.connect(this.#implementation.collection[0]);
                this.#implementation.collection[this.#implementation.collection.length - 1].connect(this.#implementation.target);
            } else {
                this.#implementation.upstream.connect(this.#implementation.target);
            } //if
            this.#implementation.routed = true;
        }; //route
        this.#implementation.setEnabled = doEnable => {
            if (this.#implementation.isEnabled == doEnable) return;
            this.#implementation.isEnabled = doEnable;
            this.#implementation.route();
        }; //setEnabled
        this.#implementation.deactivate = _ => {
            this.#implementation.clearRouting();
            for (let node of this.#implementation.collection)
                safeDisconnect(node);
            this.#implementation.collection.splice(0);
        }; //deactivate
    } //constructor

    // Replaces the whole chain with nodeList. Every previously populated node is
    // fully disconnected (so the Web Audio implementation can release it); the
    // new nodes are linked among themselves and exactly one upstream-to-target
    // route is established, regardless of the enabled state.
    populate(nodeList) {
        this.#implementation.clearRouting();
        for (let node of this.#implementation.collection)
            this.#implementation.safeDisconnect(node);
        this.#implementation.collection.splice(0);
        let index = 0;
        for (let node of nodeList) {
            this.#implementation.collection.push(node);
            if (nodeList[index + 1] != undefined)
                node.connect(nodeList[index + 1]);
            ++index;
        } //loop
        this.#implementation.route();
    } //populate

    get isEnabled() { return this.#implementation.isEnabled; }
    set isEnabled(value) { this.#implementation.setEnabled(value); }

    deactivate() { this.#implementation.deactivate(); }

} //class ChainNode
