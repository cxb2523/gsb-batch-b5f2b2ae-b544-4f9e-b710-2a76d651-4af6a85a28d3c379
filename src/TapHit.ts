import { distancePointToLine } from "./MathUtils";
import { PlaneInstance } from "./Formations";

export type Point3 = readonly [number, number, number];

/**
 * Finds the formation plane closest to the tap ray, if any is within the hit radius.
 *
 * `positions` must be parallel to `planes` and hold each plane's current world
 * position. The returned plane is the plane instance itself (its stable
 * identity), not its draw order index, so callers can key the tap animation by
 * identity and never by an index which may refer to another plane after a
 * formation switch.
 *
 * Planes behind the camera are ignored.
 */
export function findTappedPlane(
    planes: readonly PlaneInstance[],
    positions: readonly Point3[],
    camera: Point3,
    forward: Point3,
    ground: Point3,
    hitRadius: number
): PlaneInstance | null {
    let hit: PlaneInstance | null = null;
    let hitDistance = hitRadius;

    for (let i = 0; i < planes.length && i < positions.length; i++) {
        const [planeX, planeY, planeZ] = positions[i];

        // Ignore planes behind the camera.
        if ((planeX - camera[0]) * forward[0]
            + (planeY - camera[1]) * forward[1]
            + (planeZ - camera[2]) * forward[2] <= 0) {
            continue;
        }

        const distance = distancePointToLine(
            planeX, planeY, planeZ,
            camera[0], camera[1], camera[2],
            ground[0], ground[1], ground[2]
        );

        if (distance < hitDistance) {
            hitDistance = distance;
            hit = planes[i];
        }
    }

    return hit;
}
