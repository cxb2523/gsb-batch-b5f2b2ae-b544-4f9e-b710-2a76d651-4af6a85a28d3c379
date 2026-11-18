const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Transform } = require("node:stream");
const { createOpusAudioResource, demuxOggOpusToPackets } = require("../core/dist");

const OPUS_20MS = (tag) => Buffer.from([0xf8, 0xff, 0xfe, tag & 0xff]);
const onceClosed = (stream) =>
	new Promise((resolve) => {
		if (stream.destroyed || stream.readableEnded) return resolve();
		stream.once("close", resolve);
	});
const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gated object-mode source: `read()` only pulls when a packet has been queued via `pushPacket`,
 * so the test controls production exactly and a resumed pipeline can never starve the event loop.
 * `readCalls` exposes every upstream pull so tests can prove consumption stops.
 */
function createGatedObjectStream() {
	const readCalls = [];
	const queued = [];
	const stream = new Readable({
		objectMode: true,
		read() {
			readCalls.push(queued.length);
			const next = queued.shift();
			if (next !== undefined) this.push(next);
		},
	});
	return {
		stream,
		readCalls,
		pushPacket: (packet) => queued.push(packet),
	};
}

function pipeListenerSnapshot(stream) {
	return {
		data: stream.listenerCount("data"),
		end: stream.listenerCount("end"),
		error: stream.listenerCount("error"),
		close: stream.listenerCount("close"),
	};
}

test("transfer ownership: destroying the resource terminates the upstream and freezes pulls", async () => {
	const { stream: source, readCalls, pushPacket } = createGatedObjectStream();
	pushPacket(OPUS_20MS(1));
	const resource = createOpusAudioResource(source);
	resource.playStream.on("error", () => {});
	resource.playStream.resume();
	await flush();
	assert.ok(readCalls.length > 0, "pipeline should start pulling from the upstream");
	pushPacket(OPUS_20MS(2));
	await flush();
	const pullsBeforeDestroy = readCalls.length;

	await resource.playStream.destroy();
	await onceClosed(resource.playStream);
	pushPacket(OPUS_20MS(3));
	await flush();

	assert.equal(source.destroyed, true, "transferred upstream must be destroyed with the resource");
	assert.equal(readCalls.length, pullsBeforeDestroy, "no further upstream pulls allowed after destroy");
	assert.deepEqual(
		pipeListenerSnapshot(source),
		{ data: 0, end: 0, error: 0, close: 0 },
		"no pipe listeners may remain on the upstream",
	);
	assert.equal(resource.playStream.listenerCount("close"), 0, "ownership close listener must be removed from the play stream");
});

test("borrow ownership: destroying the resource detaches the pipe and stops consumption without closing the caller's stream", async () => {
	const { stream: source, readCalls, pushPacket } = createGatedObjectStream();
	pushPacket(OPUS_20MS(1));
	const resource = createOpusAudioResource(source, { ownership: "borrow" });
	resource.playStream.on("error", () => {});
	resource.playStream.resume();
	await flush();
	pushPacket(OPUS_20MS(2));
	await flush();
	const pullsBeforeDestroy = readCalls.length;

	await resource.playStream.destroy();
	await onceClosed(resource.playStream);
	pushPacket(OPUS_20MS(3));
	await flush();

	assert.equal(source.destroyed, false, "borrowed upstream must not be destroyed");
	assert.equal(source.isPaused(), true, "detached upstream must be paused so it stops producing");
	assert.equal(readCalls.length, pullsBeforeDestroy, "no further upstream pulls allowed after detach");
	assert.deepEqual(
		pipeListenerSnapshot(source),
		{ data: 0, end: 0, error: 0, close: 0 },
		"no pipe listeners may remain on the borrowed upstream",
	);

	// The borrowed stream is still owned by the caller and can be piped into a new destination.
	const reused = new Transform({
		objectMode: true,
		transform(chunk, _encoding, callback) {
			callback(null, chunk);
		},
	});
	const received = [];
	reused.on("data", (chunk) => received.push(chunk));
	source.pipe(reused);
	source.push(OPUS_20MS(99)); // a fresh packet from the caller after teardown must flow again
	await flush();
	assert.ok(received.length > 0, "borrowed upstream must remain reusable after resource teardown");

	source.unpipe(reused);
	reused.destroy();
	source.destroy();
});

test("transfer iterable: resource destroy calls return() exactly once and never pulls again; natural end never calls return()", async () => {
	let nextCalls = 0;
	let returnCalls = 0;
	const makeIterable = () => ({
		[Symbol.iterator]() {
			let index = 0;
			return {
				next() {
					nextCalls++;
					if (index >= 1000) return { value: undefined, done: true };
					index++;
					return { value: OPUS_20MS(index), done: false };
				},
				return() {
					returnCalls++;
					return { value: undefined, done: true };
				},
			};
		},
	});

	const resource = createOpusAudioResource(makeIterable());
	resource.playStream.on("error", () => {});
	resource.playStream.resume();
	await flush();
	const pullsBeforeDestroy = nextCalls;
	await resource.playStream.destroy();
	await onceClosed(resource.playStream);
	await flush();

	assert.equal(returnCalls, 1, "transfer cancellation must return() the iterable exactly once");
	assert.equal(nextCalls, pullsBeforeDestroy, "iterator must not be pulled after resource destruction");
	await resource.playStream.destroy(); // idempotent teardown
	assert.equal(returnCalls, 1, "repeated destroy must not return() the iterable again");

	const naturalReturnCalls = (() => {
		let returns = 0;
		const single = {
			[Symbol.iterator]() {
				return {
					next: (() => {
						let done = false;
						return () => {
							if (done) return { value: undefined, done: true };
							done = true;
							return { value: OPUS_20MS(1), done: false };
						};
					})(),
					return() {
						returns++;
						return { value: undefined, done: true };
					},
				};
			},
		};
		return {
			single,
			get returns() {
				return returns;
			},
		};
	})();
	const naturalResource = createOpusAudioResource(naturalReturnCalls.single);
	const chunks = [];
	for await (const chunk of naturalResource.playStream) chunks.push(chunk);
	assert.equal(chunks.length, 1);
	assert.equal(naturalReturnCalls.returns, 0, "naturally exhausted iterables must not be explicitly returned");
});

test("transfer iterable destroyed before its first read still returns the iterator once", async () => {
	let nextCalls = 0;
	let returnCalls = 0;
	const iterable = {
		[Symbol.iterator]() {
			return {
				next() {
					nextCalls++;
					return { value: OPUS_20MS(1), done: false };
				},
				return() {
					returnCalls++;
					return { value: undefined, done: true };
				},
			};
		},
	};
	const resource = createOpusAudioResource(iterable);
	resource.playStream.on("error", () => {});
	// Destroy without ever reading: the transfer contract still requires iterator cleanup.
	await resource.playStream.destroy();
	await onceClosed(resource.playStream);
	assert.equal(nextCalls, 0, "iterator must never be pulled");
	assert.equal(returnCalls, 1, "transfer teardown must return() even an unstarted iterator");
	await resource.playStream.destroy();
	assert.equal(returnCalls, 1, "the iterator is returned at most once");
});

test("borrow iterable: resource destroy never returns the iterator, which remains usable", async () => {
	let nextCalls = 0;
	let returnCalls = 0;
	const iterator = (() => {
		let index = 0;
		return {
			next() {
				nextCalls++;
				if (index >= 1000) return { value: undefined, done: true };
				index++;
				return { value: OPUS_20MS(index), done: false };
			},
			return() {
				returnCalls++;
				return { value: undefined, done: true };
			},
		};
	})();
	const iterable = { [Symbol.iterator]: () => iterator };

	const resource = createOpusAudioResource(iterable, { ownership: "borrow" });
	resource.playStream.on("error", () => {});
	resource.playStream.resume();
	await flush();
	const pullsBeforeDestroy = nextCalls;
	await resource.playStream.destroy();
	await onceClosed(resource.playStream);
	await flush();

	assert.equal(returnCalls, 0, "borrowed iterators must not be returned by resource teardown");
	assert.equal(nextCalls, pullsBeforeDestroy, "borrowed iterator must not be pulled after detach");
	const next = iterator.next();
	assert.equal(next.done, false, "caller retains a working iterator");
	iterator.return();
	assert.equal(returnCalls, 1, "caller controls finalization of the borrowed iterator");
});

test("upstream closing before natural end fails the resource with a single error and no listener residue", async () => {
	const source = new Readable({ objectMode: true, read() {} });
	const resource = createOpusAudioResource(source);
	const errors = [];
	resource.playStream.on("error", (error) => errors.push(error));

	source.destroy(); // close without ending
	await onceClosed(resource.playStream);

	assert.equal(resource.playStream.destroyed, true);
	assert.equal(resource.playStream.readableEnded, false, "premature close is an error, not a clean end");
	assert.equal(errors.length, 1, "the failure reason must be reported exactly once");
	assert.match(errors[0].message, /Source closed before end/);
	assert.deepEqual(pipeListenerSnapshot(source), { data: 0, end: 0, error: 0, close: 0 });

	resource.playStream.destroy();
	assert.equal(errors.length, 1, "late destroy must not report the reason again");
});

test("upstream errors are propagated to the resource with the same reason, exactly once", async () => {
	const source = new Readable({ objectMode: true, read() {} });
	const resource = createOpusAudioResource(source, { ownership: "borrow" });
	const errors = [];
	resource.playStream.on("error", (error) => errors.push(error));

	source.destroy(new Error("upstream exploded"));
	await onceClosed(resource.playStream);

	assert.equal(errors.length, 1);
	assert.equal(errors[0].message, "upstream exploded", "the original upstream reason must survive");
	resource.playStream.destroy();
	source.destroy();
	assert.equal(errors.length, 1);
});

for (const [label, badPacket, matcher] of [
	["framing", Buffer.from([0xf9, 0x01]), /Invalid Opus packet framing/],
	["duration", Buffer.from([0x00, 0x01]), /Incompatible Opus packet duration/],
]) {
	test(`validation failure (${label}) ends the resource once, destroys an owned upstream, and stops pulls`, async () => {
		const { stream: source, readCalls, pushPacket } = createGatedObjectStream();
		pushPacket(OPUS_20MS(1));
		const resource = createOpusAudioResource(source);
		const errors = [];
		resource.playStream.on("error", (error) => errors.push(error));
		resource.playStream.resume();
		await flush();
		assert.ok(readCalls.length > 0, "pipeline should be actively pulling before the failure");

		// Inject the bad packet directly into the source buffer so the validator reaches it,
		// independent of the gated read() production path.
		source.push(badPacket);
		await onceClosed(resource.playStream);
		const pullsAtFailure = readCalls.length;
		pushPacket(OPUS_20MS(2));
		await flush();

		assert.equal(errors.length, 1, "validation failure is reported exactly once");
		assert.match(errors[0].message, matcher);
		assert.equal(source.destroyed, true, "owned upstream is cancelled when validation fails");
		assert.equal(readCalls.length, pullsAtFailure, "no further upstream pulls after validation failure");
		assert.deepEqual(pipeListenerSnapshot(source), { data: 0, end: 0, error: 0, close: 0 });

		resource.playStream.destroy();
		assert.equal(errors.length, 1, "repeated destroy must not re-report the validation error");
	});

	test(`validation failure (${label}) detaches a borrowed upstream without destroying it`, async () => {
		const source = new Readable({ objectMode: true, read() {} });
		const resource = createOpusAudioResource(source, { ownership: "borrow" });
		const errors = [];
		resource.playStream.on("error", (error) => errors.push(error));

		source.push(badPacket);
		await onceClosed(resource.playStream);
		await flush();

		assert.equal(errors.length, 1);
		assert.equal(source.destroyed, false, "borrowed upstream survives validation failure");
		assert.equal(source.isPaused(), true, "borrowed upstream is paused once the pipe is detached");
		assert.deepEqual(pipeListenerSnapshot(source), { data: 0, end: 0, error: 0, close: 0 });
		source.destroy();
	});
}

test("non-object-mode Readable rejection honors ownership and attaches no listeners", async () => {
	const transferred = new Readable({ read() {} });
	assert.throws(() => createOpusAudioResource(transferred), /object-mode Readable/i);
	assert.equal(transferred.destroyed, true, "transferred byte stream is destroyed on rejection");
	assert.deepEqual(pipeListenerSnapshot(transferred), { data: 0, end: 0, error: 0, close: 0 });

	const borrowed = new Readable({ read() {} });
	assert.throws(() => createOpusAudioResource(borrowed, { ownership: "borrow" }), /object-mode Readable/i);
	assert.equal(borrowed.destroyed, false, "borrowed byte stream must remain open after rejection");
	assert.deepEqual(pipeListenerSnapshot(borrowed), { data: 0, end: 0, error: 0, close: 0 });

	// The rejected borrowed stream stays usable for the caller's own purposes.
	const later = [];
	borrowed.on("data", (chunk) => later.push(chunk));
	borrowed.push(Buffer.from("still-mine"));
	await flush();
	assert.equal(later.length, 1);
	borrowed.destroy();
});

test("borrowed demuxer teardown preserves its upstream and leaves no pipe listeners", async () => {
	const upstream = new Readable({ read() {} }); // raw byte stream feeding the Ogg demuxer
	const demuxed = demuxOggOpusToPackets(upstream, { ownership: "borrow" });
	demuxed.on("error", () => {});

	await demuxed.destroy();
	await onceClosed(demuxed);
	await flush();

	assert.equal(upstream.destroyed, false, "demuxer must not destroy a borrowed upstream");
	assert.equal(upstream.isPaused(), true, "detached demuxer upstream must be paused");
	assert.deepEqual(pipeListenerSnapshot(upstream), { data: 0, end: 0, error: 0, close: 0 });
	upstream.destroy();
});
