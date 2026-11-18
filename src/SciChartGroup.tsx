"use client";

import { PropsWithChildren, useEffect, useMemo, useRef, useState, JSX } from "react";
import { SciChartGroupContext, TGroupChartState } from "./SciChartGroupContext";
import { IInitResult } from "./types";

export type TSciChartGroupProps = PropsWithChildren<{
    onInit?: (chartInitResults: IInitResult[]) => void;
    /**
     * a callback function used once every chart within the group is initialized and has rendered at least once,
     * whichever happens last; see {@link IStateClassNames.rendered}. Called after {@link TSciChartGroupProps.onInit}
     */
    onRendered?: (chartInitResults: IInitResult[]) => void;
    onDelete?: (chartInitResults: IInitResult[]) => void;
    onInitError?: (error: any) => void;
}>;

type TGroupVersion = {
    /**
     * Identifies the current set of charts. Bumped only when a chart joins or leaves the group
     * (including an init failure), so a "batch of charts" maps to a single version: the group
     * callbacks fire at most once per version and can fire again once the membership changes.
     */
    membershipVersion: number;
    /** Bumped on every chart state change, including flag updates within the same membership, to re-render */
    tick: number;
};

/**
 * Derives whether every chart within the group is initialized, and has rendered at least once
 * @param charts the state of each chart within the group
 * @returns the two group flags
 */
function getGroupFlags(charts: ReadonlyMap<any, TGroupChartState>): {
    groupInitialized: boolean;
    groupRendered: boolean;
} {
    const chartStates = Array.from(charts.values());
    const groupInitialized = chartStates.length > 0 && chartStates.every(({ isInitialized }) => isInitialized);
    const groupRendered = groupInitialized && chartStates.every(({ isRendered }) => isRendered);

    return { groupInitialized, groupRendered };
}

/**
 * Collects the init result of every chart within the group
 * @param charts the state of each chart within the group
 * @returns the init results, or `undefined` while any chart has none
 */
function getGroupInitResults(charts: ReadonlyMap<unknown, TGroupChartState>): IInitResult[] | undefined {
    const initResults = Array.from(charts.values()).map(({ initResult }) => initResult);

    if (!initResults.every((initResult): initResult is IInitResult => initResult !== null)) {
        return undefined;
    }

    return initResults;
}

/**
 * Provides a common context for multiple wrapped {@link SciChartReact} elements.
 * Accepts callbacks used after all charts within the group are initialized, after they have also rendered,
 * and when they are unmounted.
 *
 * The charts live in one mutable map rather than a chain of snapshots: every mutation hits the same
 * object, so a chart event (init resolving, first render) arriving before React commits always reads the
 * current state instead of a stale snapshot. A removal physically deletes the entry too, so the surface
 * reference is released even when React drops the matching state update while the group is unmounting -
 * otherwise deleted surfaces stay reachable and never get garbage collected.
 *
 * The group state converges under every membership change: a chart whose initialization fails or that is
 * unmounted before initializing leaves the group instead of keeping it waiting, and each membership
 * triggers {@link TSciChartGroupProps.onInit}, {@link TSciChartGroupProps.onRendered} and
 * {@link TSciChartGroupProps.onDelete} at most once.
 */
export const SciChartGroup = (props: TSciChartGroupProps): JSX.Element => {
    const { onInit, onRendered, onDelete, onInitError } = props;

    // The authoritative chart store: a single mutable map. Never replaced, only mutated, so reads always
    // see the latest state and removals release surface references immediately.
    const chartsRef = useRef<Map<any, TGroupChartState>>(new Map());
    const [{ membershipVersion, tick }, setVersion] = useState<TGroupVersion>({ membershipVersion: 0, tick: 0 });

    // The latest callback identities. The per-membership effects and the memoized context callbacks read
    // these, so a new callback identity never re-runs an effect and notifyError never goes stale.
    const callbacksRef = useRef({ onInit, onRendered, onDelete, onInitError });
    callbacksRef.current = { onInit, onRendered, onDelete, onInitError };

    /** Mutates the live chart map, then schedules a re-render; `membershipChanged` bumps the membership version */
    const commit = (membershipChanged: boolean) => {
        setVersion(previous => ({
            membershipVersion: previous.membershipVersion + (membershipChanged ? 1 : 0),
            tick: previous.tick + 1
        }));
    };

    const addChartToGroup = (chart: any, isInitialized: boolean, initResult: IInitResult | null) => {
        // the first call for a chart joins the membership; the later one (once initialized) only updates
        // its state within the same membership
        const isNewMember = !chartsRef.current.has(chart);
        chartsRef.current.set(chart, { isInitialized, isRendered: false, initResult });
        commit(isNewMember);
    };

    const setChartRendered = (chart: any) => {
        const chartState = chartsRef.current.get(chart);

        if (!chartState || chartState.isRendered) {
            return;
        }

        chartsRef.current.set(chart, { ...chartState, isRendered: true });
        commit(false);
    };

    const removeChartFromGroup = (chart: any) => {
        if (!chartsRef.current.has(chart)) {
            return;
        }

        // physical delete: releases the init result's surface reference even if the state update below is
        // dropped because the group is unmounting, keeping deleted surfaces collectable
        chartsRef.current.delete(chart);
        commit(true);
    };

    const notifyError = (error: any): boolean => {
        // read the latest callback: this function is memoized with the chart state, not the props
        const handleError = callbacksRef.current.onInitError;

        if (!handleError) {
            return false;
        }

        handleError(error);

        return true;
    };

    const charts = chartsRef.current;
    const { groupInitialized, groupRendered } = getGroupFlags(charts);
    const initResults = getGroupInitResults(charts);
    const isGroupInitialized = groupInitialized && initResults !== undefined;
    const isGroupRendered = groupRendered && initResults !== undefined;

    const contextState = useMemo(
        () => ({
            groupInitialized,
            groupRendered,
            charts,
            addChartToGroup,
            setChartRendered,
            removeChartFromGroup,
            notifyError
        }),
        // tick changes on every chart update, so this is recomputed when the rendered flags change;
        // the callbacks only use refs and setState and are stable by construction
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tick, membershipVersion]
    );

    // The membership versions that have already had each callback, so batched membership transitions
    // cannot fire a callback twice for the same set of charts.
    const initializedMembershipsRef = useRef<Set<number>>(new Set());
    const renderedMembershipsRef = useRef<Set<number>>(new Set());
    // The membership whose onDelete cleanup is currently registered (re-registerable after a StrictMode
    // cleanup-and-re-run), rather than a permanent mark.
    const deleteCleanupMembershipRef = useRef<number | null>(null);

    // Mirrors isGroupInitialized but flips one commit later, so onRendered always runs after the
    // commit in which onInit removed the fallback.
    const [isInitHandled, setIsInitHandled] = useState(false);

    // onInit: once per membership whose charts have all initialized, while the fallback is still shown.
    useEffect(() => {
        if (isGroupInitialized) {
            if (!initializedMembershipsRef.current.has(membershipVersion)) {
                initializedMembershipsRef.current.add(membershipVersion);
                callbacksRef.current.onInit?.(initResults!);
            }

            // flips a commit later than isGroupInitialized, giving onRendered its ordering gate
            setIsInitHandled(true);
        } else {
            setIsInitHandled(false);
        }
        // Runs once per chart membership; re-running on callback or context identity would call
        // onInit again for the same charts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [membershipVersion, isGroupInitialized]);

    // onRendered: once per membership whose charts have all rendered, after onInit and the commit that
    // removes the fallback (isInitHandled flips in that commit).
    useEffect(() => {
        if (!isGroupRendered || !isInitHandled || renderedMembershipsRef.current.has(membershipVersion)) {
            return;
        }

        renderedMembershipsRef.current.add(membershipVersion);
        callbacksRef.current.onRendered?.(initResults!);
        // Runs once per chart membership; re-running on callback identity would call onRendered again
        // for the same charts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [membershipVersion, isGroupRendered, isInitHandled]);

    // onDelete: when a membership that reached initialization ends (a chart leaves the group), with the
    // init results of exactly that membership's charts.
    useEffect(() => {
        if (!isGroupInitialized || deleteCleanupMembershipRef.current === membershipVersion) {
            return;
        }

        deleteCleanupMembershipRef.current = membershipVersion;
        const membershipInitResults = initResults!;
        const membershipOnDelete = callbacksRef.current.onDelete;

        return () => {
            deleteCleanupMembershipRef.current = null;
            membershipOnDelete?.(membershipInitResults);
        };
        // Runs once per chart membership; the cleanup captures that membership's charts, so a later
        // membership cannot change or repeat the call.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [membershipVersion, isGroupInitialized]);

    return <SciChartGroupContext.Provider value={contextState}>{props.children}</SciChartGroupContext.Provider>;
};
