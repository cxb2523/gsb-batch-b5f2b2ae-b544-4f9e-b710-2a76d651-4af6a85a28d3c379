import {
  CardinalDirection,
  Direction,
  directionToChanges,
  Position,
} from '../../types';
import getShipSpeed from './shipSpeed';
import state from '../../state/state';
import { directionMap } from '../../input';
import updateInterface from '../../state/updateInterface';
import { calculateDestination } from './worldUtils';
import { getXWrapAround } from './sharedUtils';
import { getCaptain } from '../../state/selectors';

const createWorldPlayer = (
  startPosition: Position,
  startFrame: number,
  startDirection: CardinalDirection,
) => {
  let position = startPosition;
  let destination: Position | undefined;

  let { frameOffset } = directionToChanges[startDirection];
  let frameAlternate = 0;

  let heading: Direction | '' = '';
  let speed = 0;

  updateInterface.playerFleetDirection(directionMap[heading]);

  const animate = () => {
    frameAlternate = frameAlternate === 0 ? 1 : 0;
  };

  return {
    move: (
      direction: Direction,
      collisionAt: (position: Position) => boolean,
    ) => {
      animate();

      const {
        xDelta,
        yDelta,
        frameOffset: newFrameOffset,
      } = directionToChanges[direction];
      frameOffset = newFrameOffset;

      const isDiagonal = Math.abs(xDelta) > 0 && Math.abs(yDelta) > 0;
      const multiplier = speed / 40 / (isDiagonal ? Math.SQRT2 : 1);

      if (!isDiagonal) {
        destination = calculateDestination(
          position,
          xDelta,
          yDelta,
          multiplier,
          collisionAt,
        );

        return;
      }

      const firstDestination = calculateDestination(
        position,
        xDelta,
        0,
        multiplier,
        collisionAt,
      );

      destination = calculateDestination(
        firstDestination,
        0,
        yDelta,
        multiplier,
        collisionAt,
      );
    },
    update: () => {
      if (destination) {
        position = {
          x: getXWrapAround(destination.x),
          y: destination.y,
        };
      }
    },
    position: (percentNextMove = 0) => {
      if (!destination) {
        return position;
      }

      return {
        x: getXWrapAround(
          position.x + (destination.x - position.x) * percentNextMove,
        ),
        y: position.y + (destination.y - position.y) * percentNextMove,
      };
    },
    destination: () => destination,
    setHeading: (newHeading: Direction | '') => {
      if (newHeading === heading) {
        return;
      }

      heading = newHeading;

      updateInterface.playerFleetDirection(directionMap[heading]);
    },
    heading: () => heading,
    updateSpeed: () => {
      /*
        Always recalculate from the wind and current currently in state.
        These are refreshed on sea area changes, seasonal changes, and when
        setting sail, so the speed must never be skipped just because the
        heading is unchanged.
       */
      const ship = state.fleets[1].ships[0];

      const newSpeed = heading
        ? getShipSpeed(
            ship,
            getCaptain(0),
            directionMap[heading],
            state.wind,
            state.current,
          )
        : 0;

      if (newSpeed === speed) {
        return;
      }

      speed = newSpeed;
      updateInterface.playerFleetSpeed(speed);
    },
    frame: () => startFrame + frameOffset + frameAlternate,
    width: 2,
    height: 2,
  };
};

export type WorldPlayer = ReturnType<typeof createWorldPlayer>;

export default createWorldPlayer;
