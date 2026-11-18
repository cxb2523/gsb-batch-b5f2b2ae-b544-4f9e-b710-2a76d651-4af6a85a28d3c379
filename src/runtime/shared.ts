// Keys written through `select` into prism.shared by the SVG chart types and
// the rules reader blocks use to match them. Each block runs in its own
// sandboxed iframe, so the kind of a selection travels with the value itself
// (a small marker object) instead of through cross-frame registration.

import { toText } from "../util";
import { isoDay } from "./periods";

/** A selection a calendar cell writes: the day normalized to YYYY-MM-DD. */
export interface DayShared {
	kind: "day";
	value: string;
}

/** A selection a map region writes: the region name normalized for matching. */
export interface RegionShared {
	kind: "region";
	value: string;
}

/** The prism.shared value shape the SVG charts write (bar/pie charts still write raw values). */
export type SharedMarker = DayShared | RegionShared;

/** Region names match case-insensitively and without surrounding whitespace. */
export const regionKey = (value: unknown): string => toText(value).trim().toLowerCase();

/** Wraps the x value a calendar cell or map region writes into its shared marker. */
export function sharedMarker(kind: SharedMarker["kind"], value: unknown): SharedMarker {
	return { kind, value: kind === "day" ? toText(value) : regionKey(value) };
}

export function isSharedMarker(value: unknown): value is SharedMarker {
	if (!value || typeof value !== "object") return false;
	const m = value as Partial<SharedMarker>;
	return (m.kind === "day" || m.kind === "region") && typeof m.value === "string";
}

/** The normalized key of a row cell compared against a selection marker. */
export function cellKey(kind: SharedMarker["kind"], cell: unknown): string | null {
	if (Array.isArray(cell)) return null;
	if (kind === "day") return isoDay(cell);
	const key = regionKey(cell);
	return key || null;
}

/** True when a row cell belongs to the selection (list cells match by containment). */
export function cellMatchesMarker(cell: unknown, marker: SharedMarker): boolean {
	if (Array.isArray(cell)) return cell.some((c) => cellKey(marker.kind, c) === marker.value);
	return cellKey(marker.kind, cell) === marker.value;
}

/**
 * A bare shared value (a marker's value, or a raw string left by an HTML block
 * or an older selection) interpreted as the given kind. Used for the writer
 * side's own highlight: it must use exactly the key the reader filters on.
 */
export function keyForValue(kind: SharedMarker["kind"], value: unknown): string | null {
	if (isSharedMarker(value)) return cellKey(value.kind, value.value);
	return cellKey(kind, value);
}

/** Whether a stored shared value represents the key a cell would write (toggle and highlight). */
export function sharedValueEquals(kind: SharedMarker["kind"], current: unknown, value: unknown): boolean {
	if (isSharedMarker(current)) return current.kind === kind && current.value === (kind === "day" ? toText(value) : regionKey(value));
	const key = keyForValue(kind, current);
	return key !== null && key === (kind === "day" ? toText(value) : regionKey(value));
}
