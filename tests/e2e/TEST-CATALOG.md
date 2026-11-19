# E2E test catalog

## Super Blocks core journey

**File:** `specs/game.spec.ts`

| Journey | Acceptance |
| --- | --- |
| Game home | `/` directly shows the menu, modes, ranking, settings, and rules. |
| Classic scoring | A deterministic opening can complete a line and persist score 18. |
| Session restore | Refresh and returning to `/` resume an unfinished game. |
| Daily across midnight | A daily round started at 23:59 keeps its board, score, and round id through a clock change and refresh, and still accepts moves. |
| Expired daily save | A daily save past its grace window is cleared and explained in a dialog instead of being dropped silently. |
| Exit confirmation | Opening the exit dialog freezes the timer and disables board and piece input; keeping playing resumes both. |
| Single settlement | Completing the daily goal opens one result dialog and records exactly one score, even with duplicate input and a refresh. |
| Preferences | Language, music, sound, and reduced motion persist independently. |
| Best scores | The score page summarizes the overall, classic, and daily best scores stored on the device. |
| Assets and routing | Required audio is served and invalid modes redirect to `/`. |
