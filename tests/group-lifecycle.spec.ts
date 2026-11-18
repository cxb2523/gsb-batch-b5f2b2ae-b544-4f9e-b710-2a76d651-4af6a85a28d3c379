import { expect, test, type Page } from "@playwright/test";
import type { TGroupLifecycleEntry } from "../.storybook/stories/GroupLifecycle.stories";
import { defaultGroupStateClassNames as group } from "../src/stateClassNames";

/** Software rendering and a wasm download per story make loading slow */
const TIMEOUT = 120_000;

const openStory = (page: Page, name: string): Promise<void> =>
    page.goto(`/iframe.html?viewMode=story&id=tests-grouplifecycle--${name}`, { waitUntil: "domcontentloaded" });

const getLog = (page: Page): Promise<TGroupLifecycleEntry[]> => page.evaluate(() => window.groupLifecycleLog ?? []);

const steps = (entries: TGroupLifecycleEntry[]): string[] => entries.map(({ step }) => step);

const count = (entries: TGroupLifecycleEntry[], step: string): number =>
    entries.filter(entry => entry.step === step).length;

const waitForStep = async (
    page: Page,
    step: string,
    expectedCount = 1
): Promise<TGroupLifecycleEntry[]> => {
    await page.waitForFunction(
        ({ step: waitedStep, expectedCount: waitedCount }) =>
            (window.groupLifecycleLog ?? []).filter(entry => entry.step === waitedStep).length >= waitedCount,
        { step, expectedCount },
        { timeout: TIMEOUT }
    );

    return getLog(page);
};

const resetLog = (page: Page): Promise<void> => page.getByRole("button", { name: "Reset log" }).click();

/**
 * Clicks a button even while the group fallback overlay covers it: the overlay intercepts pointer
 * events, so a real click at the button's point would land on it. A DOM click still runs onClick.
 */
const clickButton = (page: Page, name: string): Promise<void> =>
    page.getByRole("button", { name }).evaluate(button => button.click());

test.beforeEach(async ({ page }) => {
    // SciChart reads this at module load, so it must be set before navigation
    await page.addInitScript(() => localStorage.setItem("IS_WEB_GPU", "0"));
});

test.describe("healthy group", () => {
    test("onInit and onRendered each fire once for the same charts, before and after the fallback is removed", async ({
        page
    }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));

        await openStory(page, "success");

        const initEntry = await waitForStep(page, "group onInit");
        // onInit runs while the fallback is still shown (captured at the moment the callback ran)
        expect(initEntry.find(entry => entry.step === "group onInit")).toMatchObject({
            count: 2,
            fallbackShown: true
        });

        const renderedEntries = await waitForStep(page, "group onRendered");
        // onRendered runs after the fallback is removed and the chart children are mounted
        expect(renderedEntries.find(entry => entry.step === "group onRendered")).toMatchObject({
            count: 2,
            fallbackShown: false,
            childMounted: true
        });
        await expect(page.getByTestId("group-fallback")).toBeHidden();

        // let any extra, duplicated callbacks surface
        await page.waitForTimeout(1000);

        const log = await getLog(page);
        expect(count(log, "group onInit")).toBe(1);
        expect(count(log, "group onRendered")).toBe(1);
        expect(count(log, "group onInitError")).toBe(0);
        expect(count(log, "group onDelete")).toBe(0);
        await expect(page.locator(`.${group.rendered}`)).toHaveCount(1);
        expect(pageErrors).toEqual([]);
    });
});

test.describe("init failure", () => {
    test("the failing chart leaves the group, onInitError fires, and the remaining chart still initializes and renders", async ({
        page
    }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));

        await openStory(page, "one-init-fails");

        const entries = await waitForStep(page, "group onRendered");

        expect(entries.find(entry => entry.step === "group onInitError")).toMatchObject({
            errorMessage: "initChart failed"
        });
        expect(entries.find(entry => entry.step === "group onInit")).toMatchObject({ count: 1 });
        expect(entries.find(entry => entry.step === "group onRendered")).toMatchObject({ count: 1 });
        await expect(page.getByTestId("group-fallback")).toBeHidden();
        await expect(page.locator(`.${group.rendered}`)).toHaveCount(1);

        await page.waitForTimeout(1000);

        const settledLog = await getLog(page);
        expect(count(settledLog, "group onInit")).toBe(1);
        expect(count(settledLog, "group onRendered")).toBe(1);
        expect(count(settledLog, "group onInitError")).toBe(1);
        expect(pageErrors).toEqual([]);
    });
});

test.describe("unmount before init", () => {
    test("the group no longer waits for the unmounted chart and converges with the remaining chart", async ({
        page
    }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));

        await openStory(page, "unmount-before-init");

        // chart A initializes alone first, but the group still waits for gated chart B
        await waitForStep(page, "chart onInit", 1);
        await expect(page.getByTestId("group-fallback")).toBeVisible();
        let log = await getLog(page);
        expect(count(log, "group onInit")).toBe(0);

        await clickButton(page, "Unmount B");

        // B is gone from the group: A alone satisfies it
        const entries = await waitForStep(page, "group onRendered");
        expect(entries.find(entry => entry.step === "group onInit")).toMatchObject({ count: 1 });
        expect(entries.find(entry => entry.step === "group onRendered")).toMatchObject({ count: 1 });
        await expect(page.getByTestId("group-fallback")).toBeHidden();
        expect(steps(entries)).not.toContain("group onInitError");

        await page.waitForTimeout(1000);

        log = await getLog(page);
        expect(count(log, "group onInit")).toBe(1);
        expect(count(log, "group onRendered")).toBe(1);
        // B never initialized, so it never contributed a group onDelete membership
        expect(count(log, "group onDelete")).toBe(0);
        expect(pageErrors).toEqual([]);
    });
});

test.describe("membership changes", () => {
    test("group callbacks re-fire once per membership when charts are added and removed", async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));

        await openStory(page, "add-and-remove");

        await waitForStep(page, "group onRendered");
        await resetLog(page);

        // add chart C (gated): the group goes back to waiting and the fallback stays up until C starts
        await clickButton(page, "Mount C");
        await expect(page.getByTestId("group-fallback")).toBeVisible();

        // while C is pending, the group must not re-initialize for the two ready charts
        await page.waitForTimeout(500);
        let entries = await getLog(page);
        expect(count(entries, "group onInit")).toBe(0);
        expect(count(entries, "group onDelete")).toBe(1);
        expect(entries.find(entry => entry.step === "group onDelete")).toMatchObject({ count: 2 });

        // let C initialize: the three-chart membership initializes and renders
        await clickButton(page, "Start C");
        entries = await waitForStep(page, "group onRendered");
        expect(entries.filter(entry => entry.step === "group onInit").map(entry => entry.count)).toEqual([3]);
        expect(entries.filter(entry => entry.step === "group onRendered").map(entry => entry.count)).toEqual([3]);
        await expect(page.getByTestId("group-fallback")).toBeHidden();

        await page.waitForTimeout(1000);
        entries = await getLog(page);
        expect(count(entries, "group onInit")).toBe(1);
        expect(count(entries, "group onRendered")).toBe(1);
        expect(count(entries, "group onDelete")).toBe(1);

        await resetLog(page);

        // remove chart C: the remaining two charts form a new membership that initializes and renders again
        await clickButton(page, "Unmount C");

        entries = await waitForStep(page, "group onRendered");
        expect(entries.filter(entry => entry.step === "group onInit").map(entry => entry.count)).toEqual([2]);
        expect(entries.filter(entry => entry.step === "group onRendered").map(entry => entry.count)).toEqual([2]);
        expect(entries.filter(entry => entry.step === "group onDelete").map(entry => entry.count)).toEqual([3]);

        await page.waitForTimeout(1000);
        entries = await getLog(page);
        expect(count(entries, "group onInit")).toBe(1);
        expect(count(entries, "group onRendered")).toBe(1);
        expect(count(entries, "group onDelete")).toBe(1);
        expect(pageErrors).toEqual([]);
    });
});
