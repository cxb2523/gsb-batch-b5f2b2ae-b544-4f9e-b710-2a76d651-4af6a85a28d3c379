import type { Meta, StoryObj } from "@storybook/react-webpack5";
import { useEffect, useRef, useState, JSX } from "react";
import { NumericAxis, SciChartSurface, ISciChartSurfaceBase } from "scichart";
import { ChartGroupLoader, IInitResult, SciChartReact } from "scichart-react";

/**
 * Stories for tests/group-lifecycle.spec.ts. Every group and chart lifecycle step is appended to
 * `window.groupLifecycleLog`, including how many charts the group callbacks received.
 */

/** One logged lifecycle step */
export type TGroupLifecycleEntry = {
    step: string;
    chart?: string;
    count?: number;
    errorMessage?: string;
    /** whether the group fallback was in the DOM at that moment */
    fallbackShown?: boolean;
    /** whether a chart's children were mounted at that moment */
    childMounted?: boolean;
};

declare global {
    interface Window {
        groupLifecycleLog: TGroupLifecycleEntry[];
    }
}

const isInDom = (testId: string): boolean => document.querySelector(`[data-testid="${testId}"]`) !== null;

const log = (entry: TGroupLifecycleEntry): void => {
    window.groupLifecycleLog ??= [];
    window.groupLifecycleLog.push({
        ...entry,
        fallbackShown: isInDom("group-fallback"),
        childMounted: isInDom("chart-child")
    });
};

const createLineSurface = async (rootElement: string | HTMLDivElement): Promise<ISciChartSurfaceBase> => {
    const { sciChartSurface, wasmContext } = await SciChartSurface.create(rootElement);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext));

    return sciChartSurface;
};

const chartStyle = { width: 320, height: 160 };

type TGroupChartProps = {
    /** chart name included in every log entry of this chart */
    name: string;
    /** init waits for the "Start {name}" button before creating a surface */
    gateInit?: boolean;
    /** the init function rejects with this message */
    initErrorMessage?: string;
    /** shows an "Unmount {name}" button that removes this chart */
    removable?: boolean;
};

/**
 * A chart whose whole lifecycle is logged. With `gateInit`, its init function does not create its
 * surface until the chart's "Start" button is pressed, so it can be unmounted before initialization.
 */
const GroupChart = ({ name, gateInit, initErrorMessage, removable }: TGroupChartProps): JSX.Element => {
    const [isMounted, setIsMounted] = useState(true);
    const startRef = useRef<() => void>();
    const isMountedRef = useRef(true);

    useEffect(
        () => () => {
            isMountedRef.current = false;
        },
        []
    );

    const initChart = async (rootElement: string | HTMLDivElement): Promise<IInitResult> => {
        log({ step: "chart initChart", chart: name });

        if (gateInit) {
            await new Promise<void>(resolve => {
                startRef.current = resolve;
            });

            // unmounted while gated: no surface was created, resolve never so nothing else runs
            if (!isMountedRef.current) {
                return new Promise<IInitResult>(() => {});
            }
        }

        const sciChartSurface = await createLineSurface(rootElement);
        sciChartSurface.addDeletable({ delete: () => log({ step: "chart surface deleted", chart: name }) });

        if (initErrorMessage) {
            throw new Error(initErrorMessage);
        }

        log({ step: "chart initChart resolved", chart: name });

        return { sciChartSurface, destructor: () => log({ step: "chart destructor", chart: name }) };
    };

    if (!isMounted) {
        return (
            <div>
                <span>{name} unmounted</span>
            </div>
        );
    }

    return (
        <div>
            <span>{name}</span>
            {gateInit ? <button onClick={() => startRef.current?.()}>Start {name}</button> : null}
            {removable ? <button onClick={() => setIsMounted(false)}>Unmount {name}</button> : null}
            <SciChartReact
                initChart={initChart}
                style={chartStyle}
                onInit={() => log({ step: "chart onInit", chart: name })}
                onRendered={() => log({ step: "chart onRendered", chart: name })}
                onDelete={() => log({ step: "chart onDelete", chart: name })}
                onInitError={error => log({ step: "chart onInitError", chart: name, errorMessage: error?.message })}
            >
                <div data-testid="chart-child">child</div>
            </SciChartReact>
        </div>
    );
};

type TLoggedGroupProps = {
    /** names of the charts mounted when the story starts */
    initialCharts: string[];
    /** name of the chart whose init function throws */
    failingChart?: string;
    /** name of the chart whose init waits for its Start button */
    gatedChart?: string;
    /** name of the chart that can be unmounted before init with its own button */
    removableChart?: string;
    /** names of charts that can be added and removed with buttons */
    toggleCharts?: string[];
};

/** A ChartGroupLoader logging every group callback with the number of charts it received */
const LoggedGroup = ({
    initialCharts,
    failingChart,
    gatedChart,
    removableChart,
    toggleCharts = []
}: TLoggedGroupProps): JSX.Element => {
    const [mounted, setMounted] = useState<Record<string, boolean>>(
        Object.fromEntries(toggleCharts.map(name => [name, false]))
    );

    const renderChart = (name: string) => (
        <GroupChart
            key={name}
            name={name}
            gateInit={gatedChart === name}
            removable={removableChart === name}
            initErrorMessage={failingChart === name ? "initChart failed" : undefined}
        />
    );

    return (
        <div>
            <div>
                {toggleCharts.map(name => (
                    <button
                        key={name}
                        onClick={() => setMounted(previous => ({ ...previous, [name]: !previous[name] }))}
                    >
                        {mounted[name] ? `Unmount ${name}` : `Mount ${name}`}
                    </button>
                ))}
                <button onClick={() => (window.groupLifecycleLog = [])}>Reset log</button>
            </div>
            <ChartGroupLoader
                fallback={<div data-testid="group-fallback">Loading group...</div>}
                onInit={initResults => log({ step: "group onInit", count: initResults.length })}
                onRendered={initResults => log({ step: "group onRendered", count: initResults.length })}
                onDelete={initResults => log({ step: "group onDelete", count: initResults.length })}
                onInitError={error => log({ step: "group onInitError", errorMessage: error?.message })}
            >
                {initialCharts.map(renderChart)}
                {toggleCharts.filter(name => mounted[name]).map(renderChart)}
            </ChartGroupLoader>
        </div>
    );
};

const meta = {
    title: "Tests/GroupLifecycle",
    component: ChartGroupLoader,
    // hidden from the sidebar and the docs; tests/visual.spec.ts skips "test-only" stories
    tags: ["!dev", "!autodocs", "test-only"]
} satisfies Meta<typeof ChartGroupLoader>;

export default meta;
type Story = StoryObj<typeof ChartGroupLoader>;

/** Two healthy charts: each group callback fires once, for both charts */
export const Success: Story = { render: () => <LoggedGroup initialCharts={["A", "B"]} /> };

/** One chart fails init, the other still drives the group to initialized and rendered */
export const OneInitFails: Story = {
    render: () => <LoggedGroup initialCharts={["A", "B"]} failingChart="B" />
};

/** A chart unmounted while its init is pending must not keep the group waiting */
export const UnmountBeforeInit: Story = {
    render: () => <LoggedGroup initialCharts={["A", "B"]} gatedChart="B" removableChart="B" />
};

/** A chart added after the group rendered, then removed: callbacks re-fire for the new memberships.
 *  C is gated, so mounting it leaves the group deterministically waiting (fallback shown) until "Start C". */
export const AddAndRemove: Story = {
    render: () => <LoggedGroup initialCharts={["A", "B"]} toggleCharts={["C"]} gatedChart="C" />
};
