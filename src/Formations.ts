/**
 * Plane formations: the set of plane instances which are drawn for every
 * formation, along with their relative offsets.
 *
 * The data is kept separate from the renderer so that the mapping between a
 * formation and its plane members can be unit tested without WebGL.
 */

export enum Formation {
    Single,
    Triangle,
    LargeTriangle,
    Diamond,
    Cross,
    Line
}

/**
 * A plane which can be part of a formation.
 *
 * Instances are stable objects shared between formations: when a formation is
 * switched, planes present in both formations are the very same objects. This
 * identity is what tap animations are keyed by, so an animation can never jump
 * to a different plane just because the draw order changed.
 */
export interface PlaneInstance {
    /** Stable identifier, unique across all plane instances. Used for debugging and tests. */
    readonly id: string;
    readonly offset: [number, number, number];
    readonly timersOffset: number;
    readonly propTimerOffset: number;
}

export const PLANE_CENTER: PlaneInstance = { id: "center", offset: [0, 0, 0], timersOffset: 0, propTimerOffset: 0 };
export const PLANE_TRIANGLE_1: PlaneInstance = { id: "triangle-1", offset: [90, -90, 0], timersOffset: 0.1, propTimerOffset: 0.1 };
export const PLANE_TRIANGLE_2: PlaneInstance = { id: "triangle-2", offset: [-90, -90, 0], timersOffset: 0.2, propTimerOffset: 0.3 };
export const PLANE_LARGE_TRIANGLE_1: PlaneInstance = { id: "large-triangle-1", offset: [180, -180, 0], timersOffset: 0.1, propTimerOffset: 0.1 };
export const PLANE_LARGE_TRIANGLE_2: PlaneInstance = { id: "large-triangle-2", offset: [-180, -180, 0], timersOffset: 0.2, propTimerOffset: 0.3 };
export const PLANE_CROSS_1: PlaneInstance = { id: "cross-1", offset: [110, -110, 0], timersOffset: 0.1, propTimerOffset: 0.1 };
export const PLANE_CROSS_2: PlaneInstance = { id: "cross-2", offset: [-110, -110, 0], timersOffset: 0.2, propTimerOffset: 0.3 };
export const PLANE_CROSS_3: PlaneInstance = { id: "cross-3", offset: [-110, 110, 0], timersOffset: 0.1, propTimerOffset: 0 };
export const PLANE_CROSS_4: PlaneInstance = { id: "cross-4", offset: [110, 110, 0], timersOffset: 0.2, propTimerOffset: 0.2 };
export const PLANE_LINE_1: PlaneInstance = { id: "line-1", offset: [140, 0, 0], timersOffset: 0.1, propTimerOffset: 0.1 };
export const PLANE_LINE_2: PlaneInstance = { id: "line-2", offset: [-140, 0, 0], timersOffset: 0.2, propTimerOffset: 0.3 };
export const PLANE_DIAMOND_3: PlaneInstance = { id: "diamond-3", offset: [0, -190, 0], timersOffset: 0.2, propTimerOffset: 0.2 };

/** Planes drawn for every formation, in draw order. The first plane is always the center one. */
export const FORMATION_PLANES: Readonly<Record<Formation, readonly PlaneInstance[]>> = {
    [Formation.Single]: [PLANE_CENTER],
    [Formation.Triangle]: [PLANE_CENTER, PLANE_TRIANGLE_1, PLANE_TRIANGLE_2],
    [Formation.LargeTriangle]: [PLANE_CENTER, PLANE_LARGE_TRIANGLE_1, PLANE_LARGE_TRIANGLE_2, PLANE_TRIANGLE_1, PLANE_TRIANGLE_2],
    [Formation.Diamond]: [PLANE_CENTER, PLANE_TRIANGLE_1, PLANE_TRIANGLE_2, PLANE_DIAMOND_3],
    [Formation.Cross]: [PLANE_CENTER, PLANE_CROSS_1, PLANE_CROSS_2, PLANE_CROSS_3, PLANE_CROSS_4],
    [Formation.Line]: [PLANE_CENTER, PLANE_LINE_1, PLANE_LINE_2],
};

/** Returns the planes of the given formation in draw order. The first plane is always the center one. */
export function getFormationPlanes(formation: Formation): readonly PlaneInstance[] {
    return FORMATION_PLANES[formation];
}
