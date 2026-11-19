import { beforeEach, describe, expect, test, vi } from 'vitest';
import state from './state';
import {
  dock,
  setSail,
  updateWorldStatus,
  worldTimeTick,
} from './actionsWorld';
import { getCurrent, getIsSummer, getWind } from '../game/world/windCurrent';
import updateInterface from './updateInterface';

vi.mock('./updateInterface', () => ({
  default: {
    indicators: vi.fn(),
    dayAtSea: vi.fn(),
    provisions: vi.fn(),
  },
}));

vi.mock('./actionsPort', () => ({
  updateGeneral: vi.fn(),
}));

vi.mock('../input', () => ({
  default: { reset: vi.fn() },
}));

vi.mock('../game/port/port', () => ({
  default: vi.fn(() => ({})),
}));

vi.mock('../game/port/portUtils', () => ({
  portAdjacentAt: vi.fn(() => '1'),
}));

vi.mock('./selectors', () => ({
  getTimeOfDay: () => state.timePassed % 1440,
  shouldUpdateWorldStatus: () => state.timePassed % 240 === 0,
  positionAdjacentToPort: () => ({ x: 0, y: 0 }),
}));

vi.mock('../game/world/windCurrent', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../game/world/windCurrent')>();

  return {
    ...actual,
    getWind: vi.fn(() => ({ direction: 1, speed: 2 })),
    getCurrent: vi.fn(() => ({ direction: 3, speed: 4 })),
    getIsSummer: vi.fn(() => true),
  };
});

const setPlayerPosition = (x: number, y: number) => {
  state.fleets[1].position = { x, y };
};

beforeEach(() => {
  vi.clearAllMocks();

  setPlayerPosition(0, 0);
  state.timePassed = 480;
  state.seaArea = undefined;
  state.isSummer = undefined;
});

describe('updateWorldStatus', () => {
  test('stores the wind, current, sea area, and season in state and updates the indicators', () => {
    updateWorldStatus();

    expect(getWind).toHaveBeenCalledWith(0, true);
    expect(getCurrent).toHaveBeenCalledWith(0);

    expect(state.wind).toEqual({ direction: 1, speed: 2 });
    expect(state.current).toEqual({ direction: 3, speed: 4 });
    expect(state.seaArea).toEqual(0);
    expect(state.isSummer).toEqual(true);

    expect(updateInterface.indicators).toHaveBeenCalledWith({
      wind: state.wind,
      current: state.current,
    });
  });
});

describe('worldTimeTick', () => {
  test('does not refresh the wind and current when nothing has changed', () => {
    updateWorldStatus();
    vi.mocked(getWind).mockClear();
    vi.mocked(getCurrent).mockClear();

    worldTimeTick(); // 480 -> 500, off the regular interval

    expect(getWind).not.toHaveBeenCalled();
    expect(getCurrent).not.toHaveBeenCalled();
  });

  test('refreshes on the regular interval', () => {
    updateWorldStatus();
    vi.mocked(getWind).mockClear();
    vi.mocked(getCurrent).mockClear();

    state.timePassed = 220;
    worldTimeTick(); // 220 -> 240

    expect(getWind).toHaveBeenCalledTimes(1);
    expect(getCurrent).toHaveBeenCalledTimes(1);
  });

  test('refreshes when the player enters another sea area, even off the regular interval', () => {
    updateWorldStatus();
    vi.mocked(getWind).mockClear();

    setPlayerPosition(72, 0); // sea area 1
    worldTimeTick();

    expect(getWind).toHaveBeenCalledWith(1, true);
    expect(getCurrent).toHaveBeenCalledWith(1);
    expect(state.seaArea).toEqual(1);
  });

  test('refreshes across multiple consecutive sea areas', () => {
    updateWorldStatus();

    setPlayerPosition(72, 0);
    worldTimeTick();
    expect(state.seaArea).toEqual(1);

    setPlayerPosition(144, 0);
    worldTimeTick();

    expect(getWind).toHaveBeenLastCalledWith(2, true);
    expect(getCurrent).toHaveBeenLastCalledWith(2);
    expect(state.seaArea).toEqual(2);
  });

  test('refreshes when the season changes, even off the regular interval', () => {
    updateWorldStatus();
    vi.mocked(getWind).mockClear();

    vi.mocked(getIsSummer).mockReturnValue(false);
    worldTimeTick();

    expect(getWind).toHaveBeenCalledWith(0, false);
    expect(state.isSummer).toEqual(false);
  });
});

describe('dock and setSail', () => {
  test('docking does not refresh the wind and current', () => {
    updateWorldStatus();
    vi.mocked(getWind).mockClear();
    vi.mocked(getCurrent).mockClear();

    expect(dock(state.fleets[1].position!)).toEqual(true);

    expect(getWind).not.toHaveBeenCalled();
    expect(getCurrent).not.toHaveBeenCalled();
  });

  test('setting sail again refreshes the wind and current immediately', () => {
    updateWorldStatus();
    dock(state.fleets[1].position!);
    vi.mocked(getWind).mockClear();
    vi.mocked(getCurrent).mockClear();

    setSail();

    expect(getWind).toHaveBeenCalledTimes(1);
    expect(getCurrent).toHaveBeenCalledTimes(1);
    expect(updateInterface.indicators).toHaveBeenCalledWith({
      wind: state.wind,
      current: state.current,
    });
  });
});
