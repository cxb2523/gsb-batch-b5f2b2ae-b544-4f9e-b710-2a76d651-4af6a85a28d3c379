"use client";

import {
    DetailedHTMLProps,
    HTMLAttributes,
    ReactNode,
    useCallback,
    useContext,
    useEffect,
    useState,
    JSX
} from "react";
import { DefaultFallback, groupFallbackWrapperStyle } from "./DefaultFallback";
import { SciChartGroup } from "./SciChartGroup";
import { SciChartGroupContext } from "./SciChartGroupContext";
import { IInitResult, IStateClassNames } from "./types";
import { mergeStateClassNames } from "./utils";
import { defaultGroupStateClassNames } from "./stateClassNames";

type TDivProps = DetailedHTMLProps<HTMLAttributes<HTMLDivElement>, HTMLDivElement>;

/** Props for {@link ChartGroupLoader}: a div's own props, plus the group's loading, init and state-class options */
export type TChartGroupLoaderProps = TDivProps & {
    /** a component that would be rendered while the charts are being initialized */
    fallback?: ReactNode | undefined;
    /** called once all charts are initialized, while the fallback is still shown */
    onInit?: (chartInitResults: IInitResult[]) => void;
    /**
     * called once all charts are initialized and have rendered at least once, after the fallback is removed;
     * see {@link IStateClassNames.rendered}
     */
    onRendered?: (chartInitResults: IInitResult[]) => void;
    /**
     * called when a set of charts that had initialized leaves the group (one of them is unmounted or
     * fails initialization), with the init results of that set
     */
    onDelete?: (chartInitResults: IInitResult[]) => void;
    /** a callback function used when an initialization function has thrown an error */
    onInitError?: (error: any) => void;
    /**
     * class names added to the element as the charts within the group reach each state;
     * a state left out uses its {@link defaultGroupStateClassNames} entry, and an empty string adds no class
     */
    stateClassNames?: Partial<IStateClassNames>;
};

type TGroupContainerProps = Pick<
    TChartGroupLoaderProps,
    "fallback" | "stateClassNames" | "className" | "children" | "style"
> & {
    /** the loader's own initialized flag, flipped up inside the group's onInit callback */
    isInitialized: boolean;
    /** the loader's own rendered flag, flipped up inside the group's onRendered callback */
    isRendered: boolean;
    /** reverts the loader flags when the group goes back to waiting (a chart joined the group) */
    onRevert: (groupInitialized: boolean, groupRendered: boolean) => void;
};

/**
 * The element rendered around the charts. It renders the fallback and state classes from the loader's
 * own flags, which only flip up inside the group callbacks (so onInit still runs while the fallback is
 * shown), while reverting through context when the current membership stops satisfying the group.
 */
const GroupContainer = (props: TGroupContainerProps): JSX.Element => {
    const { fallback, stateClassNames, className, children, isInitialized, isRendered, onRevert, ...divProps } =
        props;
    const groupContext = useContext(SciChartGroupContext);

    const groupInitialized = groupContext?.groupInitialized ?? false;
    const groupRendered = groupContext?.groupRendered ?? false;

    // Only the downward direction is driven here. The upward flips happen in the onInit/onRendered
    // callbacks, after the user callback runs, so the fallback is still shown during onInit. When a
    // chart is added after the group had initialized, the group is no longer satisfied and the fallback
    // returns until the new membership initializes.
    useEffect(() => {
        onRevert(groupInitialized, groupRendered);
        // onRevert is a stable useCallback; only re-run when the group flags actually change
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupInitialized, groupRendered]);

    return (
        <div
            {...divProps}
            className={mergeStateClassNames(
                className,
                { isInitialized, isRendered },
                stateClassNames,
                defaultGroupStateClassNames
            )}
            style={{ position: "relative", ...divProps.style }}
        >
            {children}
            {/* both branches are wrapped, so the default overlay is layered above the
                per-chart overlays exactly as a custom one is */}
            {!isInitialized ? (
                <div style={groupFallbackWrapperStyle}>{fallback ? fallback : <DefaultFallback />}</div>
            ) : null}
        </div>
    );
};

/** The purpose of this component is to hide UI behind a spinner until the charts within it are initialized */
export const ChartGroupLoader = (props: TChartGroupLoaderProps): JSX.Element => {
    const { fallback, onInit, onRendered, onDelete, onInitError, stateClassNames, className, ...divProps } = props;

    const [isInitialized, setIsInitialized] = useState(false);
    const [isRendered, setIsRendered] = useState(false);

    // Reverts the loader flags when the current membership stops satisfying the group. Stable across
    // renders, so the container's effect only runs when the group flags actually change.
    const handleRevert = useCallback((groupInitialized: boolean, groupRendered: boolean) => {
        if (!groupInitialized) {
            setIsInitialized(false);
        }

        if (!groupRendered) {
            setIsRendered(false);
        }
    }, []);

    return (
        <SciChartGroup
            onInit={chartInitResults => {
                // user callback first, while the fallback is still shown; the flag flips only after it
                onInit?.(chartInitResults);
                setIsInitialized(true);
            }}
            onRendered={chartInitResults => {
                onRendered?.(chartInitResults);
                setIsRendered(true);
            }}
            onDelete={onDelete}
            onInitError={onInitError}
        >
            {/* the fallback below is absolutely positioned and must resolve against this element,
                so it needs a positioned ancestor here - without it the overlay escapes to the
                nearest positioned ancestor (often the page) and lands offset from the group.
                A caller's own position wins, since divProps.style is spread last. */}
            <GroupContainer
                {...divProps}
                className={className}
                fallback={fallback}
                stateClassNames={stateClassNames}
                isInitialized={isInitialized}
                isRendered={isRendered}
                onRevert={handleRevert}
            >
                {props.children}
            </GroupContainer>
        </SciChartGroup>
    );
};
