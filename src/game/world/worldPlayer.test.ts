import { beforeEach, describe, expect, test, vi } from 'vitest';
import createWorldPlayer from './worldPlayer';
import getShipSpeed from './shipSpeed';
import updateInterface from '../../state/updateInterface';
import state from '../../state/state';
import { Position } from '../../types';

vi.mock('../../state/updateInterface', () => ({
  default: {
    playerFleetDirection: vi.fn(),
    playerFleetSpeed: vi.fn(),
  },
}));

vi.mock('../../state/selectors');

vi.mock('./shipSpeed', () => ({ default: vi.fn(() => 40) }));

const collisionAt = (collisionTiles: Position[]) => (position: Position) =>
  collisionTiles.some(
    ({ x, y }) =>
      (position.x === x || position.x + 1 === x) &&
      (position.y === y || position.y + 1 === y),
  );

const expectPositionToBeCloseTo = (p1: Position, p2: Position) => {
  expect(p1.x).toBeCloseTo(p2.x);
  expect(p1.y).toBeCloseTo(p2.y);
};

describe('worldPlayer', () => {
  const byPosition = (position: Position) => {
    const player = createWorldPlayer(position, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();
    return player;
  };

  test('right movement, with no alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ];

    let player = byPosition({ x: 1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });

    player = byPosition({ x: 0.9, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });

    player = byPosition({ x: 0.1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
  });

  test('right movement, with upper alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ];

    let player = byPosition({ x: 1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 0 });

    player = byPosition({ x: 2, y: 0.9 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 2.1, y: 0 });

    player = byPosition({ x: 1.9, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 2, y: 0.1 });

    player = byPosition({ x: 2, y: 1.1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1.1 });
  });

  test('right movement, with lower alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ];

    let player = byPosition({ x: 1, y: 3 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 3 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 4 });

    player = byPosition({ x: 2, y: 2.9 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 2.9 });

    player = byPosition({ x: 1.9, y: 3.1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 2, y: 4 });
  });

  test('left movement, with no alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ];

    let player = byPosition({ x: 2, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 2.1, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.1, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 2.9, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
  });

  test('up movement, with right alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];

    let player = byPosition({ x: 2, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 3, y: 1 });

    player = byPosition({ x: 1.9, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });

    player = byPosition({ x: 2.1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 3, y: 0.9 });
  });

  test('up movement, with no alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];

    let player = byPosition({ x: 1, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 1, y: 1.1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 1, y: 1.9 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
  });

  test('up movement, with left alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];

    let player = byPosition({ x: 1, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 0, y: 1 });

    player = byPosition({ x: 0.9, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 0, y: 0.9 });

    player = byPosition({ x: 1.1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.1, y: 1 });
  });

  test('up movement, with right alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];

    let player = byPosition({ x: 2, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 3, y: 1 });

    player = byPosition({ x: 1.9, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });

    player = byPosition({ x: 2.1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 3, y: 0.9 });
  });
});

describe('updateSpeed', () => {
  beforeEach(() => {
    vi.mocked(getShipSpeed).mockReset().mockReturnValue(40);
    vi.mocked(updateInterface.playerFleetSpeed).mockClear();

    state.wind = { direction: 0, speed: 3 };
    state.current = { direction: 0, speed: 0 };
  });

  test('uses the wind and current currently in state', () => {
    state.current = { direction: 2, speed: 5 };

    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');
    player.setHeading('n');
    player.updateSpeed();

    expect(getShipSpeed).toHaveBeenCalledWith(
      undefined,
      undefined,
      0,
      { direction: 0, speed: 3 },
      { direction: 2, speed: 5 },
    );
    expect(updateInterface.playerFleetSpeed).toHaveBeenLastCalledWith(40);
  });

  test('recalculates when the wind changes even if the heading is unchanged', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');
    player.setHeading('n');
    player.updateSpeed();

    vi.mocked(getShipSpeed).mockReturnValue(30);
    state.wind = { direction: 4, speed: 5 };
    player.updateSpeed();

    expect(updateInterface.playerFleetSpeed).toHaveBeenLastCalledWith(30);
  });

  test('recalculates when the current changes even if the heading is unchanged', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');
    player.setHeading('n');
    player.updateSpeed();

    vi.mocked(getShipSpeed).mockReturnValue(35);
    state.current = { direction: 4, speed: 2 };
    player.updateSpeed();

    expect(updateInterface.playerFleetSpeed).toHaveBeenLastCalledWith(35);
  });

  test('does not update the interface while the speed is unchanged', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');
    player.setHeading('n');
    player.updateSpeed();
    player.updateSpeed();

    expect(updateInterface.playerFleetSpeed).toHaveBeenCalledTimes(1);
  });

  test('speed is recalculated after docking and setting sail again', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');
    player.setHeading('n');
    player.updateSpeed();
    expect(updateInterface.playerFleetSpeed).toHaveBeenLastCalledWith(40);

    // docking clears the heading and stops the fleet
    player.setHeading('');
    player.updateSpeed();
    expect(updateInterface.playerFleetSpeed).toHaveBeenLastCalledWith(0);

    // setting sail again refreshes the wind and current in state
    state.wind = { direction: 4, speed: 7 };
    state.current = { direction: 0, speed: 2 };
    vi.mocked(getShipSpeed).mockReturnValue(25);

    player.setHeading('n');
    player.updateSpeed();

    expect(getShipSpeed).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      0,
      { direction: 4, speed: 7 },
      { direction: 0, speed: 2 },
    );
    expect(updateInterface.playerFleetSpeed).toHaveBeenLastCalledWith(25);
  });
});
