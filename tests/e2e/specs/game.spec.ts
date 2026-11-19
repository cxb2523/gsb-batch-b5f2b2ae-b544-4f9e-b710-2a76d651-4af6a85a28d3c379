import { expect, test, type Page } from '@playwright/test';

async function preparePage(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript(() => {
    const audioWindow = window as Window & {
      __superBlocksAudioPlays?: string[];
    };
    audioWindow.__superBlocksAudioPlays = [];
    HTMLMediaElement.prototype.play = function play() {
      audioWindow.__superBlocksAudioPlays?.push(
        new URL(this.src, window.location.href).pathname
      );
      return Promise.resolve();
    };

    if (window.sessionStorage.getItem('block-blast-e2e-ready')) {
      return;
    }
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('block-blast-')) {
        window.localStorage.removeItem(key);
      }
    }
    window.localStorage.setItem('block-blast-language', 'en');
    window.localStorage.setItem('block-blast-score-version', '3');
    window.sessionStorage.removeItem('block-blast-active-game');
    window.sessionStorage.setItem('block-blast-e2e-ready', 'true');
  });

  return errors;
}

async function openHome(page: Page) {
  const errors = await preparePage(page);
  await page.goto('/');
  await expect(page.getByTestId('block-game')).toHaveAttribute(
    'data-ready',
    'true'
  );
  return errors;
}

async function placePiece(
  page: Page,
  pieceIndex: number,
  row: number,
  column: number
) {
  await page.getByTestId(`game-piece-${pieceIndex}`).click();
  await page.getByTestId(`board-cell-${row}-${column}`).click();
}

const ACTIVE_GAME_KEY = 'block-blast-active-game';

function createEmptyBoard() {
  return Array.from({ length: 8 }, () => Array<string | null>(8).fill(null));
}

/** A sparse starter board that keeps the round playable. */
function createDailyFixtureBoard() {
  const board = createEmptyBoard();
  board[7][7] = 'purple';
  board[6][6] = 'green';
  return board;
}

function createSessionFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    board: createEmptyBoard(),
    challengeComplete: false,
    combo: 0,
    dailyDate: '2026-11-19',
    elapsedSeconds: 0,
    gameOver: false,
    generation: 1,
    mode: 'daily',
    movesWithoutClear: 0,
    pieces: [
      { cells: [[0, 0]], color: 'yellow', id: 'fixture-0', key: 'single' },
      { cells: [[0, 0]], color: 'blue', id: 'fixture-1', key: 'single' },
      { cells: [[0, 0]], color: 'red', id: 'fixture-2', key: 'single' },
    ],
    roundId: 'e2e-round-fixture',
    score: 0,
    seed: 1,
    version: 5,
    ...overrides,
  };
}

async function seedActiveSession(page: Page, session: Record<string, unknown>) {
  await page.evaluate(
    (payload) => {
      window.sessionStorage.setItem(payload.key, payload.value);
    },
    { key: ACTIVE_GAME_KEY, value: JSON.stringify(session) }
  );
}

async function readActiveSession(page: Page) {
  return page.evaluate((key) => {
    const stored = window.sessionStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  }, ACTIVE_GAME_KEY);
}

async function readScoreHistory(page: Page) {
  return page.evaluate(() => {
    const stored = window.localStorage.getItem('block-blast-score-history');
    return stored ? JSON.parse(stored) : [];
  });
}

interface SessionPiece {
  cells: Array<[number, number]>;
}

interface SessionSnapshot {
  board: Array<Array<string | null>>;
  pieces: Array<SessionPiece | null>;
}

/** Finds the first on-board placement for a piece in a restored session. */
function findValidPlacement(
  session: SessionSnapshot,
  pieceIndex: number
): { column: number; row: number } | null {
  const piece = session.pieces[pieceIndex];
  if (!piece) return null;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const fits = piece.cells.every(([cellRow, cellColumn]) => {
        const targetRow = row + cellRow;
        const targetColumn = column + cellColumn;
        return (
          targetRow >= 0 &&
          targetRow < 8 &&
          targetColumn >= 0 &&
          targetColumn < 8 &&
          session.board[targetRow][targetColumn] === null
        );
      });
      if (fits) return { column, row };
    }
  }
  return null;
}

async function placeFirstAvailablePiece(page: Page) {
  const session = (await readActiveSession(page)) as SessionSnapshot | null;
  if (!session) throw new Error('No active session to place from');
  for (
    let pieceIndex = 0;
    pieceIndex < session.pieces.length;
    pieceIndex += 1
  ) {
    const placement = findValidPlacement(session, pieceIndex);
    if (placement) {
      await placePiece(page, pieceIndex, placement.row, placement.column);
      return;
    }
  }
  throw new Error('No valid placement found');
}

test.describe('Super Blocks', () => {
  test('opens directly on the game menu', async ({ page }) => {
    const errors = await openHome(page);

    await expect(page).toHaveTitle('Super Blocks');
    await expect(page.getByRole('img', { name: 'Super Blocks' })).toBeVisible();
    await expect(page.getByTestId('start-classic')).toBeVisible();
    await expect(page.getByTestId('start-daily')).toBeVisible();
    await expect(page.getByTestId('home-ranking')).toContainText(
      'View your best score for each mode.'
    );
    await expect(page.getByTestId('home-settings')).toBeVisible();
    await expect(page.getByTestId('home-how-to-play')).toBeVisible();
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      '/og.png'
    );
    await expect(
      page.locator('link[rel="icon"][sizes="32x32"]')
    ).toHaveAttribute('href', '/favicon-32x32.png');
    expect(errors).toEqual([]);
  });

  test('dragged piece follows the pointer and can be dropped', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();

    const piece = page.getByTestId('game-piece-0');
    const shape = piece.locator('.piece-shape');
    const target = page.getByTestId('board-cell-3-3');
    const pieceBox = await piece.boundingBox();
    const targetBox = await target.boundingBox();

    expect(pieceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!pieceBox || !targetBox) return;

    const pointerStart = {
      x: pieceBox.x + pieceBox.width / 2,
      y: pieceBox.y + pieceBox.height / 2,
    };
    const pointerEnd = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };

    await page.mouse.move(pointerStart.x, pointerStart.y);
    await page.mouse.down();
    await page.mouse.move(pointerEnd.x, pointerEnd.y, { steps: 12 });

    const draggedShapeBox = await shape.boundingBox();
    expect(draggedShapeBox).not.toBeNull();
    if (!draggedShapeBox) return;

    const draggedShapeCenter = {
      x: draggedShapeBox.x + draggedShapeBox.width / 2,
      y: draggedShapeBox.y + draggedShapeBox.height / 2,
    };
    expect(
      Math.hypot(
        pointerEnd.x - draggedShapeCenter.x,
        pointerEnd.y - draggedShapeCenter.y
      )
    ).toBeLessThan(12);
    await expect(page.locator('.is-preview-valid')).toHaveCount(3);

    await page.mouse.up();
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('plays a deterministic classic round and saves the score', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.locator('[data-testid^="game-piece-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid^="board-cell-"]')).toHaveCount(64);

    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    await placePiece(page, 1, 0, 3);
    await expect(page.getByTestId('game-score')).toHaveText('6');
    await placePiece(page, 2, 0, 6);
    await expect(page.getByTestId('clear-effect')).toHaveAttribute(
      'data-line-count',
      '1'
    );
    await expect(page.getByTestId('game-score')).toHaveText('18');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-best-score'))
      )
      .toBe('18');
    expect(errors).toEqual([]);
  });

  test('restores an active game after reload', async ({ page }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');

    await page.reload();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(3);

    await page.goto('/');
    await expect(page).toHaveURL(/\/play\/classic$/);
    expect(errors).toEqual([]);
  });

  test('returns from settings through browser history without source params', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await page.getByRole('link', { name: 'Settings' }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page).not.toHaveURL(/[?&]from=/);
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    expect(errors).toEqual([]);
  });

  test('omits descriptive text below the how-to-play and settings titles', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-how-to-play').click();
    await expect(page).toHaveURL(/\/how-to-play$/);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);

    await page.goto('/');
    await page.getByTestId('home-settings').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('persists language and independent preferences', async ({ page }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-settings').click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.getByRole('button', { name: /中文/ }).click();
    await expect(page.getByRole('heading', { name: '游戏设置' })).toBeVisible();
    await page.getByRole('button', { name: /背景音乐/ }).click();
    await page.getByRole('button', { name: /音效/ }).click();
    await page.getByRole('button', { name: /减少动态效果/ }).click();

    await page.reload();
    await expect(page.getByRole('heading', { name: '游戏设置' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-language'))
      )
      .toBe('zh');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-music'))
      )
      .toBe('false');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-sound'))
      )
      .toBe('false');
    await expect(page.getByTestId('game-settings-page')).toHaveClass(
      /reduce-game-motion/
    );
    expect(errors).toEqual([]);
  });

  test('shows an overall and per-mode best score summary', async ({ page }) => {
    const errors = await openHome(page);
    await page.evaluate(() => {
      localStorage.setItem('block-blast-best-score', '321');
      localStorage.setItem(
        'block-blast-score-history',
        JSON.stringify([
          { id: 'classic-321', mode: 'classic', score: 321 },
          { id: 'daily-210', mode: 'daily', score: 210 },
        ])
      );
    });
    await page.getByTestId('home-ranking').click();

    await expect(page).toHaveURL(/\/ranking$/);
    await expect(page.locator('.ranking-best-card strong')).toHaveText('321');
    await expect(
      page.locator('.mode-best-card').nth(0).locator('span')
    ).toHaveText('Classic');
    await expect(
      page.locator('.mode-best-card').nth(0).locator('strong')
    ).toHaveText('321');
    await expect(
      page.locator('.mode-best-card').nth(1).locator('span')
    ).toHaveText('Daily Challenge');
    await expect(
      page.locator('.mode-best-card').nth(1).locator('strong')
    ).toHaveText('210');
    await expect(page.locator('.standalone-score-list')).toHaveCount(0);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('serves audio assets and redirects invalid modes', async ({ page }) => {
    const errors = await openHome(page);
    for (const asset of [
      '/game/audio/gameplay-music.ogg',
      '/game/audio/block-place.mp3',
      '/game/audio/game-over.ogg',
    ]) {
      const response = await page.request.get(asset);
      expect(response.ok()).toBe(true);
    }

    await page.goto('/play/not-a-mode');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('start-classic')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('keeps a daily round started before midnight playable after midnight', async ({
    page,
  }) => {
    const errors = await preparePage(page);
    // Start the browser clock late on 2026-11-19 so the round anchors there.
    await page.clock.install({ time: new Date(2026, 10, 19, 23, 59, 30) });
    await page.goto('/');
    await expect(page.getByTestId('start-daily')).toBeVisible();
    await page.getByTestId('start-daily').click();
    await expect(page).toHaveURL(/\/play\/daily$/);
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );

    // The deterministic 2026-11-19 daily board leaves row 0 free from column 2,
    // so the opening three-block piece fits there.
    await placePiece(page, 0, 0, 2);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    const beforeMidnight = await readActiveSession(page);
    expect(beforeMidnight).toMatchObject({
      dailyDate: '2026-11-19',
      mode: 'daily',
      score: 3,
    });
    const roundId = (beforeMidnight as { roundId: string }).roundId;

    // Cross midnight and refresh: the in-progress round must survive with the
    // same board, score, and round identity.
    await page.clock.setSystemTime(new Date(2026, 10, 20, 0, 0, 30));
    await page.reload();
    await expect(page).toHaveURL(/\/play\/daily$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    // 12 seeded daily blocks plus the 3 just placed.
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(15);

    const afterMidnight = await readActiveSession(page);
    expect(afterMidnight).toMatchObject({
      dailyDate: '2026-11-19',
      mode: 'daily',
      roundId,
      score: 3,
    });

    // The round keeps accepting moves after the date change.
    await placeFirstAvailablePiece(page);
    await expect(page.getByTestId('game-score')).not.toHaveText('3');
    expect(errors).toEqual([]);
  });

  test('reports and clears an expired daily session instead of silently dropping it', async ({
    page,
  }) => {
    const errors = await preparePage(page);
    await page.clock.install({ time: new Date(2026, 10, 20, 9, 0, 0) });
    await page.goto('/');
    await expect(page.getByTestId('start-daily')).toBeVisible();

    await seedActiveSession(
      page,
      createSessionFixture({
        board: createDailyFixtureBoard(),
        dailyDate: '2026-11-18',
        score: 77,
      })
    );
    await page.reload();
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );

    const notice = page.getByTestId('session-expired-modal');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Daily challenge expired');
    await expect(notice).toContainText('2026-11-18');
    // The stale save is removed, so a refresh does not resurrect it.
    await expect.poll(async () => readActiveSession(page)).toBeNull();

    await notice.getByRole('button', { name: 'Close' }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    expect(errors).toEqual([]);
  });

  test('freezes the clock and the board while the exit confirmation is open', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');

    const timer = page.getByTestId('game-timer');
    await expect(timer).toHaveAttribute('data-paused', 'false');
    await expect
      .poll(async () => timer.getAttribute('data-elapsed'))
      .not.toBe('0');
    const elapsedBeforeDialog = Number(
      await timer.getAttribute('data-elapsed')
    );

    await page.getByTestId('request-exit').click();
    await expect(page.getByTestId('exit-confirmation-modal')).toBeVisible();
    await expect(timer).toHaveAttribute('data-paused', 'true');
    const frozenElapsed = await timer.getAttribute('data-elapsed');

    // Neither the clock nor a placement may advance while the dialog is open.
    await page.waitForTimeout(1600);
    await expect(timer).toHaveAttribute('data-elapsed', frozenElapsed ?? '0');
    await expect(page.getByTestId('board-cell-0-1')).toBeDisabled();
    await expect(page.getByTestId('game-piece-1')).toBeDisabled();

    await page.getByRole('button', { name: 'Keep playing' }).click();
    await expect(page.getByTestId('exit-confirmation-modal')).toHaveCount(0);
    await expect(timer).toHaveAttribute('data-paused', 'false');
    await expect
      .poll(async () => Number(await timer.getAttribute('data-elapsed')))
      .toBeGreaterThan(Number(frozenElapsed));
    expect(Number(frozenElapsed)).toBeGreaterThanOrEqual(elapsedBeforeDialog);

    await placePiece(page, 1, 0, 3);
    await expect(page.getByTestId('game-score')).toHaveText('6');
    expect(errors).toEqual([]);
  });

  test('settles a completed daily challenge exactly once', async ({ page }) => {
    const errors = await openHome(page);
    await page.clock.install({ time: new Date(2026, 10, 19, 12, 0, 0) });
    await page.goto('/play/daily');
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    await expect(page.getByTestId('game-score')).toBeVisible();

    // Seed a nearly complete challenge: 999 points, one piece left to place.
    await seedActiveSession(
      page,
      createSessionFixture({
        dailyDate: '2026-11-19',
        score: 999,
      })
    );
    await page.reload();
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    await expect(page.getByTestId('game-score')).toHaveText('999');

    await placePiece(page, 0, 4, 4);
    const modal = page.getByTestId('challenge-complete-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveCount(1);

    // Rapid duplicate input must not settle or score again.
    await page.keyboard.press('Space');
    await page.mouse.dblclick(5, 5);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('challenge-complete-modal')).toHaveCount(1);
    await expect
      .poll(async () => (await readScoreHistory(page)).length)
      .toBe(1);
    const history = (await readScoreHistory(page)) as Array<{
      mode: string;
      score: number;
    }>;
    expect(history).toEqual([
      { id: expect.any(String), mode: 'daily', score: 1000 },
    ]);

    // Reloading the settled round must not record a second score.
    await page.reload();
    await expect(page.getByTestId('challenge-complete-modal')).toBeVisible();
    await page.waitForTimeout(300);
    await expect
      .poll(async () => (await readScoreHistory(page)).length)
      .toBe(1);
    expect(errors).toEqual([]);
  });
});
