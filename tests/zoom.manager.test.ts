/*
 * ZoomManager unit tests.
 *
 * Covers the zoom-level state machine that drives block rendering:
 *  - level switches dispatch ZOOM_LEVEL_CHANGE exactly once (no flicker)
 *  - an undetermined level never resets the current one
 *  - active blocks are recomputed from the viewport and cleared when empty
 *  - single-block and multi-block scenarios behave consistently
 *  - multi-select pauses/resumes zoom without losing the current level
 *  - thresholds are recalculated after data reset and window resize
 */

import {describe, it, expect, vi} from 'vitest';
import ZoomManager from '../src/lib/svg/zoom.manager';
import EventManager from '../src/lib/svg/event.manager';
import {EventType, ZoomLevel} from '../src/lib/enums/global';

interface StubSeat {
    id: string;
    x: number;
    y: number;
}

interface StubBlock {
    id: string;
    x: number;
    y: number;
    seats: StubSeat[];
    labels: any[];
    bbox?: any;
    zoom_bbox?: any;
}

interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    bbox?: { x: number; y: number; width: number; height: number };
}

function makeBlock(id: string, seats: Array<[number, number]>): StubBlock {
    return {
        id,
        x: 0,
        y: 0,
        seats: seats.map(([x, y], i) => ({id: `${id}-s${i}`, x, y})),
        labels: [],
    };
}

function makeRect(left: number, top: number, width: number, height: number): Rect {
    return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        bbox: {x: left, y: top, width, height},
    };
}

function makeCanvas(blocks: StubBlock[], opts: { width?: number; height?: number } = {}) {
    const state = {
        blocks,
        rects: {} as Record<string, Rect | null>,
    };
    const eventManager = new EventManager(null as any);
    const svgNode: any = {
        call: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        interrupt: vi.fn().mockReturnThis(),
        attr: vi.fn().mockReturnThis(),
        transition: vi.fn().mockReturnThis(),
        duration: vi.fn().mockReturnThis(),
    };
    const canvas: any = {
        eventManager,
        config: {min_zoom: 0.1, max_zoom: 1.9, animation_speed: 0},
        windowManager: {
            width: opts.width ?? 800,
            height: opts.height ?? 600,
            stage: {width: null, height: null},
        },
        data: {getBlocks: () => state.blocks},
        svg: {
            node: svgNode,
            stage: {
                node: svgNode,
                blocks: {
                    getBlock: (id: string) => {
                        const rect = state.rects[id];
                        if (!rect) return null;
                        return {
                            item: state.blocks.find((b) => b.id === id),
                            node: {
                                node: () => ({
                                    getBoundingClientRect: () => rect,
                                    getBBox: () => rect.bbox,
                                }),
                            },
                        };
                    },
                },
            },
        },
    };
    return {canvas, state, svgNode, eventManager};
}

function zoomLevelSpy(eventManager: EventManager) {
    const levels: ZoomLevel[] = [];
    eventManager.addEventListener(EventType.ZOOM_LEVEL_CHANGE, (e: any) => levels.push(e.level));
    return levels;
}

describe('ZoomManager level switching', () => {
    it('dispatches ZOOM_LEVEL_CHANGE only when the level actually changes', () => {
        const blocks = [
            makeBlock('b1', [[0, 0], [100, 0], [0, 100], [100, 100]]),
            makeBlock('b2', [[500, 0], [600, 0], [500, 100], [600, 100]]),
        ];
        const {canvas, eventManager} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.calculateZoomLevels();
        (zm as any).zoomLevels.BLOCK = {x: 0, y: 0, k: 1.4};

        const levels = zoomLevelSpy(eventManager);

        zm.calculateZoomLevel(1.5); // -> BLOCK
        zm.calculateZoomLevel(1.55); // still BLOCK, no re-dispatch
        zm.calculateZoomLevel(1.8); // -> SEAT (max_zoom - 0.2 = 1.7)
        zm.calculateZoomLevel(1.85); // still SEAT
        zm.calculateZoomLevel(1.1); // -> VENUE
        zm.calculateZoomLevel(1.15); // still VENUE

        expect(levels).toEqual([ZoomLevel.BLOCK, ZoomLevel.SEAT, ZoomLevel.VENUE]);
        expect(zm.zoomLevel).toBe(ZoomLevel.VENUE);
    });

    it('keeps the current level when no threshold matches (never resets to null)', () => {
        const blocks = [
            makeBlock('b1', [[0, 0], [100, 100]]),
            makeBlock('b2', [[500, 0], [600, 100]]),
        ];
        const {canvas, eventManager} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.calculateZoomLevels();
        (zm as any).zoomLevels.BLOCK = {x: 0, y: 0, k: 1.4};

        const levels = zoomLevelSpy(eventManager);

        // Below the VENUE threshold the level is undetermined:
        // the current level must be kept, not reset.
        zm.calculateZoomLevel(0.01);
        expect(zm.zoomLevel).toBe(ZoomLevel.VENUE);
        expect(levels).toEqual([]);

        zm.calculateZoomLevel(1.5); // -> BLOCK
        zm.calculateZoomLevel(0.01); // undetermined again, must stay BLOCK
        expect(zm.zoomLevel).toBe(ZoomLevel.BLOCK);
        expect(levels).toEqual([ZoomLevel.BLOCK]);
    });

    it('zoomToVenue does not re-dispatch when already at VENUE level', () => {
        const blocks = [
            makeBlock('b1', [[0, 0], [100, 100]]),
            makeBlock('b2', [[500, 0], [600, 100]]),
        ];
        const {canvas, eventManager} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.calculateZoomLevels();
        (zm as any).zoomLevels.BLOCK = {x: 0, y: 0, k: 1.4};

        const levels = zoomLevelSpy(eventManager);

        zm.calculateZoomLevel(1.5); // -> BLOCK
        zm.zoomToVenue(false); // -> VENUE
        zm.zoomToVenue(false); // already VENUE: no duplicate event

        expect(levels).toEqual([ZoomLevel.BLOCK, ZoomLevel.VENUE]);
    });
});

describe('ZoomManager active blocks', () => {
    it('clears the active list and the BLOCK threshold when no block is in the viewport', () => {
        const blocks = [makeBlock('b1', [[0, 0], [100, 100]])];
        const {canvas, state} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.calculateZoomLevels();

        // Block completely outside the 800x600 viewport
        state.rects['b1'] = makeRect(5000, 5000, 100, 100);
        zm.calculateActiveBlocks();

        expect(zm.activeBlocks).toEqual([]);
        expect(zm.getZoomLevelValues(ZoomLevel.BLOCK)).toBeNull();
    });

    it('recomputes and sorts active blocks by viewport overlap, dropping stale results', () => {
        const blocks = [
            makeBlock('b1', [[0, 0], [100, 100]]),
            makeBlock('b2', [[200, 0], [300, 100]]),
        ];
        const {canvas, state} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.calculateZoomLevels();

        // b1 fully visible (25% of viewport), b2 half visible horizontally
        state.rects['b1'] = makeRect(0, 0, 400, 300);
        state.rects['b2'] = makeRect(700, 0, 200, 300);

        zm.calculateActiveBlocks();

        expect(zm.activeBlocks.length).toBe(2);
        expect(zm.activeBlocks[0].block.item.id).toBe('b1');
        expect(zm.activeBlocks[0].ratio).toBeCloseTo(25);
        expect(zm.activeBlocks[1].block.item.id).toBe('b2');
        expect(zm.getZoomLevelValues(ZoomLevel.BLOCK)).toEqual(blocks[0].zoom_bbox);

        // Pan both blocks out of the viewport: old results must not survive
        state.rects['b1'] = makeRect(-5000, 0, 100, 100);
        state.rects['b2'] = makeRect(5000, 0, 100, 100);
        zm.calculateActiveBlocks();

        expect(zm.activeBlocks).toEqual([]);
        expect(zm.getZoomLevelValues(ZoomLevel.BLOCK)).toBeNull();
    });
});

describe('ZoomManager single-block scenario', () => {
    it('aligns VENUE with BLOCK and never reports VENUE while zooming in', () => {
        const blocks = [makeBlock('b1', [[0, 0], [400, 300]])];
        const {canvas, state, eventManager} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);

        state.rects['b1'] = makeRect(0, 0, 400, 300);
        zm.calculateActiveBlocks(); // sets the BLOCK threshold from zoom_bbox
        zm.calculateZoomLevels(); // single block: VENUE := BLOCK

        const blockLevel = zm.getZoomLevelValues(ZoomLevel.BLOCK);
        expect(blockLevel).not.toBeNull();
        expect(zm.getZoomLevelValues(ZoomLevel.VENUE)).toEqual(blockLevel);

        const levels = zoomLevelSpy(eventManager);

        zm.calculateZoomLevel(blockLevel.k); // at the block threshold
        expect(zm.zoomLevel).toBe(ZoomLevel.BLOCK);

        zm.calculateZoomLevel(1.8); // -> SEAT
        expect(zm.zoomLevel).toBe(ZoomLevel.SEAT);

        // Any k at/above the block threshold maps to BLOCK/SEAT, never VENUE
        expect(levels).toEqual([ZoomLevel.BLOCK, ZoomLevel.SEAT]);
    });
});

describe('ZoomManager multi-select toggle', () => {
    it('pauses zoom on Ctrl and resumes on keyup without losing the level', () => {
        const blocks = [
            makeBlock('b1', [[0, 0], [100, 100]]),
            makeBlock('b2', [[500, 0], [600, 100]]),
        ];
        const {canvas, svgNode, eventManager} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.init();
        (zm as any).zoomLevels.BLOCK = {x: 0, y: 0, k: 1.4};
        zm.calculateZoomLevel(1.5); // -> BLOCK
        expect(zm.zoomLevel).toBe(ZoomLevel.BLOCK);

        const multiSelectEvents: string[] = [];
        eventManager.addEventListener(EventType.MULTI_SELECT_ENABLE, () => multiSelectEvents.push('enable'));
        eventManager.addEventListener(EventType.MULTI_SELECT_DISABLE, () => multiSelectEvents.push('disable'));

        const callsBefore = svgNode.call.mock.calls.length;

        // Repeated Ctrl keydowns (key auto-repeat) must enable only once
        eventManager.dispatch(EventType.KEYDOWN_SVG, {which: 17, preventDefault: () => {}});
        eventManager.dispatch(EventType.KEYDOWN_SVG, {which: 17, preventDefault: () => {}});
        expect(multiSelectEvents).toEqual(['enable']);
        expect(svgNode.on.mock.calls.filter((c: any[]) => c[0] === '.zoom').length).toBe(1);

        // Zoom interaction is paused: zoomDisable is idempotent
        zm.zoomDisable();
        expect(svgNode.on.mock.calls.filter((c: any[]) => c[0] === '.zoom').length).toBe(1);

        // Unrelated keyups must not disable multi-select
        eventManager.dispatch(EventType.KEYUP_SVG, {which: 65, preventDefault: () => {}});

        eventManager.dispatch(EventType.KEYUP_SVG, {which: 17, preventDefault: () => {}});
        expect(multiSelectEvents).toEqual(['enable', 'disable']);
        expect(svgNode.call.mock.calls.length).toBe(callsBefore + 1); // zoom re-enabled once

        // Level preserved across the pause/resume cycle
        expect(zm.zoomLevel).toBe(ZoomLevel.BLOCK);

        // Further keyups are no-ops
        eventManager.dispatch(EventType.KEYUP_SVG, {which: 17, preventDefault: () => {}});
        expect(multiSelectEvents).toEqual(['enable', 'disable']);
        expect(svgNode.call.mock.calls.length).toBe(callsBefore + 1);
    });
});

describe('ZoomManager threshold recalculation', () => {
    it('recomputes thresholds from scratch when the data is reset', () => {
        const big = [
            makeBlock('b1', [[0, 0], [1000, 0], [0, 1000], [1000, 1000]]),
            makeBlock('b2', [[500, 500], [1000, 1000]]),
        ];
        const {canvas, state} = makeCanvas(big);
        const zm = new ZoomManager(canvas);
        zm.calculateZoomLevels();

        expect(canvas.windowManager.stage.width).toBe(1000);
        const venueBefore = zm.getZoomLevelValues(ZoomLevel.VENUE).k;

        // Data reset: much smaller stage. Old accumulated bounds must not leak.
        state.blocks = [makeBlock('c1', [[0, 0], [100, 100]])];
        zm.calculateZoomLevels();

        expect(canvas.windowManager.stage.width).toBe(100);
        expect(canvas.windowManager.stage.height).toBe(100);
        expect(zm.getZoomLevelValues(ZoomLevel.VENUE).k).not.toBe(venueBefore);
    });

    it('recomputes thresholds when the window is resized', () => {
        const blocks = [
            makeBlock('b1', [[0, 0], [600, 0], [0, 100], [600, 100]]),
            makeBlock('b2', [[0, 0], [100, 100]]),
        ];
        const {canvas, eventManager} = makeCanvas(blocks);
        const zm = new ZoomManager(canvas);
        zm.init();

        const venueBefore = zm.getZoomLevelValues(ZoomLevel.VENUE).k;

        canvas.windowManager.width = 400;
        eventManager.dispatch(EventType.RESIZE_WINDOW, {});

        expect(zm.getZoomLevelValues(ZoomLevel.VENUE).k).not.toBe(venueBefore);
    });
});
