import { test } from "node:test";
import assert from "node:assert/strict";
import { NONE, aggregateRows, chartConfig, matches, resolveFilter } from "../src/runtime/chartSpec";
import { calendarItems, regionTargets, regionsOf } from "../src/runtime/svgCharts";
import { cellKey, cellMatchesMarker, isSharedMarker, regionKey, sharedMarker, sharedValueEquals } from "../src/runtime/shared";

const square = (name: string, lon: number, lat: number) => ({
	type: "Feature",
	properties: { NAME: name },
	geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1], [lon, lat]]] },
});

const geo = {
	type: "FeatureCollection",
	features: [square("Germany", 10, 50), square("France", 2, 46), square("Spain", -4, 38)],
};

// The three reader shapes (table, Chart.js chart and an SVG chart) all filter
// through `matches`, so exercising it covers every reader block at once.
const filterRows = (rows: Record<string, unknown>[], column: string, shared: Record<string, unknown>, key = "pick") => {
	const filter = resolveFilter({ [column]: `$shared.${key}` }, (k) => shared[k]);
	const wanted = filter[column];
	return wanted === undefined ? rows : rows.filter((r) => matches(r[column], wanted));
};

/** The toggle rule of prelude.toggleShared (second click on the same key clears). */
function toggle(shared: Record<string, unknown>, key: string, value: unknown) {
	const current = shared[key];
	const same = isSharedMarker(value) ? sharedValueEquals(value.kind, current, value.value) : current === value;
	if (same) delete shared[key];
	else shared[key] = value;
}

test("calendar: the day key a cell writes is exactly what the reader filters on", () => {
	// The reader column holds timestamps and spaced text; the writer cell keys are YYYY-MM-DD.
	const rows = [
		{ when: "2026-10-18T09:00", n: 1 },
		{ when: "2026-10-18 Sat", n: 2 },
		{ when: "2026-10-19", n: 3 },
		{ when: "not a date", n: 4 },
	];
	const items = calendarItems({ type: "calendar", x: "when" }, rows);
	const day = [...items.keys()].find((k) => k === "2026-10-18")!;
	assert.equal(day, "2026-10-18");
	const marker = sharedMarker("day", day);
	assert.deepEqual(marker, { kind: "day", value: "2026-10-18" });

	// Click: the shared value selects exactly the rows of that day, despite the raw text differing.
	const shared = { pick: marker };
	const kept = filterRows(rows, "when", shared);
	assert.deepEqual(kept.map((r) => r.n), [1, 2]);
	assert.ok(cellMatchesMarker("2026-10-18T09:00", marker));
	assert.ok(!cellMatchesMarker("2026-10-19", marker));
	assert.equal(cellKey("day", "2026-10-18T09:00"), "2026-10-18");

	// Click again on the same cell: the shared value is cleared and every row comes back.
	toggle(shared, "pick", sharedMarker("day", day));
	assert.deepEqual(shared, {});
	assert.deepEqual(filterRows(rows, "when", shared).map((r) => r.n), [1, 2, 3, 4]);
});

test("calendar: data reload re-resolves the filter against the current shared value", () => {
	const shared = { pick: sharedMarker("day", "2026-10-18") };
	const first = [{ when: "2026-10-18", n: 1 }, { when: "2026-10-19", n: 2 }];
	assert.deepEqual(filterRows(first, "when", shared).map((r) => r.n), [1]);

	// The data file changed: the new rows are filtered with the same selection, no stale result.
	const reloaded = [
		{ when: "2026-10-17T22:30", n: 10 },
		{ when: "2026-10-18 08:00", n: 11 },
		{ when: "2026-10-18", n: 12 },
	];
	assert.deepEqual(filterRows(reloaded, "when", shared).map((r) => r.n), [11, 12]);

	// After the selection was cleared, a later reload shows all rows.
	delete shared.pick;
	assert.deepEqual(filterRows(reloaded, "when", shared).map((r) => r.n), [10, 11, 12]);
});

test("map: the region key written on click matches rows with other case or spacing", () => {
	// Data values do not use the GeoJSON spelling ("Germany"); the writer normalizes both sides.
	const rows = [
		{ country: "  germany ", n: 1 },
		{ country: "GERMANY", n: 2 },
		{ country: "France", n: 3 },
		{ country: "Atlantis", n: 4 },
	];
	const regions = regionsOf(geo);
	const items = new Map<string, { rows: typeof rows }>();
	const grouped = new Map<string, typeof rows>();
	for (const r of rows) {
		const k = regionKey(r.country);
		(grouped.get(k) ?? grouped.set(k, []).get(k)!).push(r);
	}
	for (const [k, g] of grouped) items.set(k, { rows: g } as never);
	const targets = regionTargets(regions, items as never, "NAME");

	// Only regions with data rows are clickable targets; "Spain" has no row and is absent.
	assert.deepEqual(targets.map((t) => t.key).sort(), ["france", "germany"]);
	const germany = targets.find((t) => t.key === "germany")!;
	assert.equal(germany.name, "Germany");

	// Click: the normalized name selects both spellings of Germany, nothing else.
	const marker = sharedMarker("region", germany.key);
	assert.deepEqual(marker, { kind: "region", value: "germany" });
	const shared = { pick: marker };
	assert.deepEqual(filterRows(rows, "country", shared).map((r) => r.n), [1, 2]);
	assert.ok(cellMatchesMarker("  GERMANY ", marker));
	assert.ok(!cellMatchesMarker("France", marker));

	// Click again on the same region clears the shared value; all rows return.
	toggle(shared, "pick", sharedMarker("region", germany.key));
	assert.deepEqual(shared, {});
	assert.deepEqual(filterRows(rows, "country", shared).map((r) => r.n), [1, 2, 3, 4]);
});

test("map: data reload keeps filtering with the current region selection", () => {
	const shared = { pick: sharedMarker("region", "france") };
	const first = [{ country: "France", n: 1 }, { country: "Germany", n: 2 }];
	assert.deepEqual(filterRows(first, "country", shared).map((r) => r.n), [1]);

	const reloaded = [{ country: "  france ", n: 7 }, { country: "FRANCE", n: 8 }, { country: "Spain", n: 9 }];
	assert.deepEqual(filterRows(reloaded, "country", shared).map((r) => r.n), [7, 8]);

	// A selection no longer present in the reloaded data leaves no rows (until cleared).
	shared.pick = sharedMarker("region", "germany");
	assert.deepEqual(filterRows(reloaded, "country", shared).map((r) => r.n), []);
	delete shared.pick;
	assert.deepEqual(filterRows(reloaded, "country", shared).map((r) => r.n), [7, 8, 9]);
});

test("shared value unset: the condition is dropped and all rows show", () => {
	const rows = [{ when: "2026-10-18" }, { when: "2026-10-19" }];
	assert.deepEqual(resolveFilter({ when: "$shared.pick" }, () => undefined), {});
	assert.deepEqual(filterRows(rows, "when", {}), rows);
	assert.deepEqual(resolveFilter({ when: "$shared.pick" }, () => null), {});
});

test("(none) aggregate selection matches empty cells, not the literal string", () => {
	// An aggregate chart labels its empty-cell group NONE; that label is what `select` writes.
	const aggregated = aggregateRows([{ g: "", n: 2 }, { g: null as unknown, n: 3 }, { g: "Roman", n: 4 }], "g", undefined, ["n"], "count").rows;
	assert.deepEqual(aggregated.map((r) => r.g), [NONE, "Roman"]);
	assert.equal(aggregated[0].count, 2);
	const filter = resolveFilter({ g: "$shared.empty" }, (k) => (k === "empty" ? NONE : undefined));
	assert.deepEqual(filter, { g: [null, undefined, ""] });
	const rows = [{ g: NONE, n: 1 }, { g: "", n: 2 }, { g: null as unknown, n: 3 }, { g: "Roman", n: 4 }];
	const kept = rows.filter((r) => matches(r.g, filter.g));
	// Only genuinely empty cells match; the literal "(none)" text and "Roman" do not.
	assert.deepEqual(kept.map((r) => r.n), [2, 3]);
	assert.ok(!matches("(none)", [null, undefined, ""]));

	// End to end through a chart config: the same filter leaves the two empty rows.
	const cfg: any = chartConfig({ type: "bar", x: "g", y: "n", filter }, rows);
	assert.deepEqual(cfg.data.labels, ["", null]);
	assert.deepEqual(cfg.data.datasets[0].data, [2, 3]);
});

test("highlight and toggle compare the normalized key, including legacy plain values", () => {
	// Writer-side highlight: a stored marker matches the cell with the same normalized key.
	assert.ok(sharedValueEquals("region", sharedMarker("region", "germany"), "  Germany "));
	assert.ok(!sharedValueEquals("region", sharedMarker("region", "france"), "Germany"));
	assert.ok(sharedValueEquals("day", sharedMarker("day", "2026-10-18"), "2026-10-18"));
	// A plain YYYY-MM-DD string (selection persisted before markers existed) still highlights its day.
	assert.ok(sharedValueEquals("day", "2026-10-18", "2026-10-18"));
	assert.ok(!sharedValueEquals("day", "2026-10-19", "2026-10-18"));
});
