import { test } from "node:test";
import assert from "node:assert/strict";

import { PlaneTapAnimator } from "../src/PlaneTapAnimator";
import { Formation, getFormationPlanes } from "../src/Formations";

const DURATION = 1000;

function createAnimator(): PlaneTapAnimator {
    return new PlaneTapAnimator(DURATION);
}

test("a tap animates the plane it was started for, keyed by identity", () => {
    const animator = createAnimator();
    animator.tap("a");
    animator.update(DURATION / 4);

    assert.ok(animator.isAnimating("a"));
    assert.equal(animator.isAnimating("b"), false);
    assert.notEqual(animator.getOffsetZ("a"), 0);
    assert.equal(animator.getOffsetZ("b"), 0);
});

test("a second tap on a running plane is ignored", () => {
    const animator = createAnimator();
    animator.tap("a");
    animator.update(DURATION / 4);
    const offsetBefore = animator.getOffsetZ("a");

    animator.tap("a");
    animator.update(DURATION / 4);

    // The animation must continue from where it was, not restart at the top.
    assert.ok(animator.isAnimating("a"));
    assert.notEqual(animator.getOffsetZ("a"), offsetBefore);
});

test("the animation settles back to zero and stops", () => {
    const animator = createAnimator();
    animator.tap("a");
    animator.update(DURATION * 0.5);
    animator.update(DURATION * 0.499);
    assert.ok(animator.isAnimating("a"));

    animator.update(DURATION);
    assert.equal(animator.isAnimating("a"), false);
    assert.equal(animator.getOffsetX("a"), 0);
    assert.equal(animator.getOffsetY("a"), 0);
    assert.equal(animator.getOffsetZ("a"), 0);
    assert.equal(animator.getBankingOffset("a"), 0);
});

test("retain keeps animations of planes which are still in the formation", () => {
    const animator = createAnimator();
    const triangle = getFormationPlanes(Formation.Triangle);
    const diamond = getFormationPlanes(Formation.Diamond);

    for (const plane of triangle) {
        animator.tap(plane.id);
    }
    animator.update(DURATION / 4);

    const before = new Map(triangle.map(plane => [plane.id, animator.getOffsetZ(plane.id)]));

    animator.retain(diamond.map(plane => plane.id));

    // Diamond contains all Triangle planes, so every animation survives.
    for (const plane of triangle) {
        assert.ok(animator.isAnimating(plane.id), `${plane.id} must keep animating`);
        assert.equal(animator.getOffsetZ(plane.id), before.get(plane.id));
    }
});

test("an animation survives a formation change which moves the plane to another draw index", () => {
    const animator = createAnimator();
    const triangle = getFormationPlanes(Formation.Triangle);
    const largeTriangle = getFormationPlanes(Formation.LargeTriangle);

    // triangle-1 is draw index 1 in Triangle but draw index 3 in LargeTriangle.
    const animated = triangle[1];
    assert.equal(animated.id, "triangle-1");
    assert.equal(triangle.indexOf(animated), 1);
    assert.equal(largeTriangle.indexOf(animated), 3);

    animator.tap(animated.id);
    animator.update(DURATION / 4);
    const offsetBefore = animator.getOffsetZ(animated.id);

    animator.retain(largeTriangle.map(plane => plane.id));

    assert.ok(animator.isAnimating(animated.id), "the animation must follow the plane, not the index");
    assert.equal(animator.getOffsetZ(animated.id), offsetBefore);

    // The plane which now occupies draw index 1 in the new formation must not
    // receive the animation.
    const newIndexOnePlane = largeTriangle[1];
    assert.notEqual(newIndexOnePlane.id, animated.id);
    assert.equal(animator.isAnimating(newIndexOnePlane.id), false);
    assert.equal(animator.getOffsetZ(newIndexOnePlane.id), 0);
});

test("retain drops animations of planes which left the formation, without leaking to another index", () => {
    const animator = createAnimator();
    const cross = getFormationPlanes(Formation.Cross);
    const single = getFormationPlanes(Formation.Single);

    // Animate the last plane of Cross - draw index 4, which does not exist in Single.
    const animatedPlane = cross[cross.length - 1];
    animator.tap(animatedPlane.id);
    animator.update(DURATION / 4);
    assert.ok(animator.isAnimating(animatedPlane.id));

    animator.retain(single.map(plane => plane.id));

    // No animation may remain, and reading offsets for the planes which stayed
    // must not inherit the dropped animation.
    for (const plane of single) {
        assert.equal(animator.isAnimating(plane.id), false);
        assert.equal(animator.getOffsetZ(plane.id), 0);
        assert.equal(animator.getOffsetX(plane.id), 0);
    }
    assert.equal(animator.isAnimating(animatedPlane.id), false);
    assert.equal(animator.getOffsetZ(animatedPlane.id), 0);
});

test("tap indices from one formation cannot address planes of another formation", () => {
    const animator = createAnimator();

    // Simulate the old bug: tapping by position in a large formation, then
    // switching to a smaller one. Animating by identity means the surviving
    // animations are only those of planes which are actually still drawn.
    const largeTriangle = getFormationPlanes(Formation.LargeTriangle);
    const single = getFormationPlanes(Formation.Single);

    // Tap the 4th plane of LargeTriangle (a Triangle-1 satellite, index 3).
    animator.tap(largeTriangle[3].id);
    animator.update(DURATION / 4);

    animator.retain(single.map(plane => plane.id));

    assert.equal(animator.getOffsetZ(single[0].id), 0, "center plane must not inherit a satellite's animation");
    assert.equal(animator.getOffsetZ(single[1]?.id ?? "missing"), 0);
});

test("clear stops every animation", () => {
    const animator = createAnimator();
    animator.tap("a");
    animator.tap("b");
    animator.update(DURATION / 4);

    animator.clear();

    assert.equal(animator.isAnimating("a"), false);
    assert.equal(animator.isAnimating("b"), false);
    assert.equal(animator.getOffsetZ("a"), 0);
});

test("animations of different planes advance independently", () => {
    const animator = createAnimator();
    animator.tap("a");
    animator.update(DURATION / 4);
    animator.tap("b");

    const offsetABefore = animator.getOffsetZ("a");
    animator.update(DURATION / 4);

    // "a" is further along than "b", so their phases differ.
    assert.notEqual(animator.getOffsetZ("a"), animator.getOffsetZ("b"));
    assert.notEqual(animator.getOffsetZ("a"), offsetABefore);
});
