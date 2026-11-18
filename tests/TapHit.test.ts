import { test } from "node:test";
import assert from "node:assert/strict";

import { findTappedPlane } from "../src/TapHit";
import { Formation, getFormationPlanes, PlaneInstance } from "../src/Formations";

/** A fake plane position standing exactly at the plane's offset. */
function positionsOf(formation: Formation): [number, number, number][] {
    return getFormationPlanes(formation).map(plane => [...plane.offset] as [number, number, number]);
}

/** A ray from far above, looking straight down at the plane at `target`. */
function rayDownAt(target: [number, number, number]) {
    const camera: [number, number, number] = [target[0], target[1], 500];
    const forward: [number, number, number] = [0, 0, -1];
    const ground: [number, number, number] = [target[0], target[1], 0];
    return { camera, forward, ground };
}

test("returns the plane the ray points at", () => {
    const formation = Formation.Triangle;
    const planes = getFormationPlanes(formation);
    const positions = positionsOf(formation);

    const target = positions[1];
    const { camera, forward, ground } = rayDownAt(target);
    const hit = findTappedPlane(planes, positions, camera, forward, ground, 35);

    assert.equal(hit, planes[1]);
    assert.equal(hit?.id, "triangle-1");
});

test("returns the plane instance, not an ambiguous index, after formation switch", () => {
    // Tap the Cross plane at index 4; a small formation has no index 4 at all.
    const cross = getFormationPlanes(Formation.Cross);
    const crossPositions = positionsOf(Formation.Cross);

    const target = crossPositions[4];
    const { camera, forward, ground } = rayDownAt(target);
    const hit = findTappedPlane(cross, crossPositions, camera, forward, ground, 35);

    assert.equal(hit, cross[4]);
    assert.equal(hit?.id, "cross-4");

    // The same identity lookup in a smaller formation finds nothing there.
    const single = getFormationPlanes(Formation.Single);
    const singlePositions = positionsOf(Formation.Single);
    const miss = findTappedPlane(single, singlePositions, camera, forward, ground, 35);
    assert.equal(miss, null);
});

test("picks the closest plane when several are within the radius", () => {
    const planes: PlaneInstance[] = [
        { id: "far", offset: [20, 0, 0], timersOffset: 0, propTimerOffset: 0 },
        { id: "near", offset: [0, 0, 0], timersOffset: 0, propTimerOffset: 0 }
    ];
    const positions: [number, number, number][] = [[20, 0, 0], [0, 0, 0]];

    const hit = findTappedPlane(planes, positions, [0, 0, 500], [0, 0, -1], [0, 0, 0], 35);
    assert.equal(hit?.id, "near");
});

test("ignores planes behind the camera", () => {
    const planes: PlaneInstance[] = [{ id: "behind", offset: [0, 0, 0], timersOffset: 0, propTimerOffset: 0 }];
    const positions: [number, number, number][] = [[0, 0, 0]];

    // Camera at origin looking away from the plane's location.
    const hit = findTappedPlane(planes, positions, [0, 0, 0], [0, 0, 1], [0, 0, -100], 35);
    assert.equal(hit, null);
});

test("returns null when every plane is outside the hit radius", () => {
    const planes: PlaneInstance[] = [
        { id: "far-left", offset: [140, 0, 0], timersOffset: 0, propTimerOffset: 0 },
        { id: "far-right", offset: [-140, 0, 0], timersOffset: 0, propTimerOffset: 0 }
    ];
    const positions: [number, number, number][] = [[140, 0, 0], [-140, 0, 0]];

    // Looking straight down at the origin, both planes are 140 units away.
    const hit = findTappedPlane(planes, positions, [0, 500, 0], [0, -1, 0], [0, 0, 0], 35);
    assert.equal(hit, null);
});

test("hit resolution follows the formation actually drawn", () => {
    // Two formations with different planes; the tap must resolve against the
    // passed formation rather than a globally stored draw order.
    for (const formation of [Formation.Triangle, Formation.Diamond, Formation.Cross]) {
        const planes = getFormationPlanes(formation);
        const positions = positionsOf(formation);
        const targetIndex = planes.length - 1;
        const { camera, forward, ground } = rayDownAt(positions[targetIndex]);

        const hit = findTappedPlane(planes, positions, camera, forward, ground, 35);
        assert.equal(hit, planes[targetIndex], `formation ${Formation[formation]} must resolve its own last plane`);
    }
});
