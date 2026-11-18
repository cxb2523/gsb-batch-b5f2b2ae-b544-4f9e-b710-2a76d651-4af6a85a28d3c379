import { test } from "node:test";
import assert from "node:assert/strict";

import { Formation, FORMATION_PLANES, getFormationPlanes, PlaneInstance } from "../src/Formations";

const ALL_FORMATIONS = [
    Formation.Single,
    Formation.Triangle,
    Formation.LargeTriangle,
    Formation.Diamond,
    Formation.Cross,
    Formation.Line
];

test("every formation draws the center plane first", () => {
    for (const formation of ALL_FORMATIONS) {
        const planes = getFormationPlanes(formation);
        assert.ok(planes.length > 0, `formation ${formation} must have planes`);
        assert.equal(planes[0], FORMATION_PLANES[Formation.Single][0]);
    }
});

test("plane identities are unique across all formations", () => {
    // The same plane instance may appear in several formations, but its id may
    // never be claimed by two different instances, and no id may repeat.
    const byId = new Map<string, PlaneInstance>();
    const distinctInstances = new Set<PlaneInstance>();

    for (const formation of ALL_FORMATIONS) {
        for (const plane of getFormationPlanes(formation)) {
            distinctInstances.add(plane);
            const existing = byId.get(plane.id);
            assert.ok(
                existing === undefined || existing === plane,
                `id ${plane.id} is shared by two different plane instances`
            );
            byId.set(plane.id, plane);
        }
    }

    assert.equal(byId.size, distinctInstances.size, "every distinct plane instance must have its own id");
});

test("formations share the same plane instance objects for common members", () => {
    // Triangle's members must be the same objects in Diamond and LargeTriangle,
    // so an identity-keyed animation keeps following the same plane.
    const triangle = getFormationPlanes(Formation.Triangle);
    const largeTriangle = getFormationPlanes(Formation.LargeTriangle);
    const diamond = getFormationPlanes(Formation.Diamond);

    for (const plane of triangle) {
        assert.ok(largeTriangle.includes(plane), `LargeTriangle must contain ${plane.id}`);
        assert.ok(diamond.includes(plane), `Diamond must contain ${plane.id}`);
    }
});

test("formation draw order matches the documented shapes", () => {
    assert.equal(getFormationPlanes(Formation.Single).length, 1);
    assert.equal(getFormationPlanes(Formation.Triangle).length, 3);
    assert.equal(getFormationPlanes(Formation.LargeTriangle).length, 5);
    assert.equal(getFormationPlanes(Formation.Diamond).length, 4);
    assert.equal(getFormationPlanes(Formation.Cross).length, 5);
    assert.equal(getFormationPlanes(Formation.Line).length, 3);

    // Cross is the only formation with four satellites; each has a distinct id.
    const crossIds = getFormationPlanes(Formation.Cross).map(plane => plane.id);
    assert.deepEqual(crossIds, ["center", "cross-1", "cross-2", "cross-3", "cross-4"]);
});
