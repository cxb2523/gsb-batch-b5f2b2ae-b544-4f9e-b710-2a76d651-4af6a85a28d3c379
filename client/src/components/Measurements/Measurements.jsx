import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import PropTypes from "prop-types";
import * as THREE from "three";
import rulerIcon from "../../assets/images/icons/white/ruler-solid.svg";
import { getHeaderHeight, getSidebarWidth } from "../../features/dimensions/dimensionsSlice";
import { getCanvas, getControls, getGroup, getScene, getSceneModified, setSceneModified } from "../../features/scene/sceneSlice";
import Button from "../atoms/Button/Button";
import { getMeasureCounter, setMeasureCounter } from "../../features/counters/countersSlice";
import { setOpenMeausurePanel } from "../../features/measurements/measurementsSlice";
import { createMeasureLabel, getMeasureObjectNames, removeObjectFromScene, updateMeasureLabel } from "../../utils/functions/measureUtils";

export default function Measurements({ openPanel }) {
  const canvas = useSelector(getCanvas);
  const scene = useSelector(getScene);
  const group = useSelector(getGroup);
  const sidebarWidth = useSelector(getSidebarWidth);
  const headerHeight = useSelector(getHeaderHeight);
  const isModified = useSelector(getSceneModified);
  const controls = useSelector(getControls);
  const measureCounter = useSelector(getMeasureCounter);
  const dispatch = useDispatch();

  const [active, setActive] = useState(false);

  // The drawing state lives in refs: a re-render must not lose a half drawn measure
  const drawingRef = useRef(false);
  const lineRef = useRef(null);
  const startPointNameRef = useRef(null);

  // Latest values for the event handlers, they are attached only while measuring
  const stateRef = useRef({});
  stateRef.current = { scene, group, controls, measureCounter, isModified, sidebarWidth, headerHeight };

  const getCamera = () => {
    const { scene } = stateRef.current;
    return scene.children && scene.children.find((child) => child.type === "PerspectiveCamera");
  };

  /**
   * Removes the not completed measure (line, label and start point) from the scene
   */
  const discardPendingMeasure = () => {
    const { scene } = stateRef.current;

    if (scene && lineRef.current) {
      removeObjectFromScene(scene, lineRef.current);
    }
    if (scene && startPointNameRef.current) {
      removeObjectFromScene(scene, scene.getObjectByName(startPointNameRef.current));
    }

    lineRef.current = null;
    startPointNameRef.current = null;
    drawingRef.current = false;
  };

  // The pointer listeners are attached only while the measure tool is active.
  // The cleanup removes the listeners, deletes a half drawn measure and
  // restores the controls, so cancel, finish, tool switch and unmount all
  // leave a clean state without references to the canvas.
  useEffect(() => {
    if (!active || !canvas) return;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const setPointerFromEvent = (event) => {
      const { sidebarWidth, headerHeight } = stateRef.current;
      pointer.x = ((event.clientX - sidebarWidth) / canvas.offsetWidth) * 2 - 1;
      pointer.y = -((event.clientY - headerHeight) / canvas.offsetHeight) * 2 + 1;
    };

    const createPoint = (point, name) => {
      const geometry = new THREE.SphereGeometry(0.5, 32, 16);
      const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.copy(point);
      sphere.name = name;
      stateRef.current.scene.add(sphere);
    };

    /**
     * Creates a group of measure objects.
     * For each measure there are 4 objects: 2 points, 1 line and 1 label (child of the line)
     */
    const createMeasureGroup = (name) => {
      const { scene } = stateRef.current;
      const groupMeasure = new THREE.Group();
      groupMeasure.name = name;

      getMeasureObjectNames(name).forEach((objectName) => {
        const object = objectName === name ? lineRef.current : scene.getObjectByName(objectName);
        if (object) {
          groupMeasure.add(object);
        }
      });

      scene.add(groupMeasure);
    };

    const onPointerDown = (event) => {
      const { scene, group, controls, measureCounter, isModified } = stateRef.current;
      const camera = getCamera();
      if (!camera || !group) return;

      setPointerFromEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(group.children, true);
      if (intersects.length === 0) return;

      // The numbering rule is shared with the rebuilt scene:
      // the next index is always the highest existing one plus one
      const count = measureCounter + 1;
      const measureName = "Measure" + count;

      if (!drawingRef.current) {
        // start the line
        const points = [intersects[0].point, intersects[0].point.clone()];

        createPoint(intersects[0].point, measureName + "start");

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            color: 0xffff00,
            transparent: true,
            linewidth: 100,
            depthTest: false,
            opacity: 0.75,
          }),
        );
        line.frustumCulled = false;
        line.name = measureName;
        line.add(createMeasureLabel(measureName, count, 0, points[0], points[1]));
        scene.add(line);

        lineRef.current = line;
        startPointNameRef.current = measureName + "start";
        drawingRef.current = true;
      } else {
        // finish the line
        const line = lineRef.current;

        createPoint(intersects[0].point, measureName + "end");

        const positions = line.geometry.attributes.position.array;
        positions[3] = intersects[0].point.x;
        positions[4] = intersects[0].point.y;
        positions[5] = intersects[0].point.z;
        line.geometry.attributes.position.needsUpdate = true;

        const startPoint = new THREE.Vector3(positions[0], positions[1], positions[2]);
        updateMeasureLabel(line.children[0], count, startPoint.distanceTo(intersects[0].point), startPoint, intersects[0].point);

        createMeasureGroup(measureName);

        // increment the counter, the next measure continues the numbering
        dispatch(setMeasureCounter(count));
        dispatch(setSceneModified(!isModified));

        lineRef.current = null;
        startPointNameRef.current = null;
        drawingRef.current = false;

        // the measure is completed: the controls are enabled and the button is deactivated,
        // to make a new measure the user clicks again on the button
        controls.enabled = true;
        setActive(false);
      }
    };

    const onPointerMove = (event) => {
      if (!drawingRef.current || !lineRef.current) return;

      const { group, measureCounter } = stateRef.current;
      const camera = getCamera();
      if (!camera || !group) return;

      setPointerFromEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(group.children, false);
      if (intersects.length === 0) return;

      const line = lineRef.current;
      const positions = line.geometry.attributes.position.array;
      const startPoint = new THREE.Vector3(positions[0], positions[1], positions[2]);
      positions[3] = intersects[0].point.x;
      positions[4] = intersects[0].point.y;
      positions[5] = intersects[0].point.z;
      line.geometry.attributes.position.needsUpdate = true;

      updateMeasureLabel(line.children[0], measureCounter + 1, startPoint.distanceTo(intersects[0].point), startPoint, intersects[0].point);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        // cancel the measure in progress
        setActive(false);
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      // cancel, finish, tool switch or unmount: nothing half drawn remains in the scene
      discardPendingMeasure();
      if (stateRef.current.controls) {
        stateRef.current.controls.enabled = true;
      }
    };
  }, [active, canvas]);

  // If another tool re-enables the controls while measuring, the measure is cancelled
  useEffect(() => {
    if (active && controls.enabled) {
      setActive(false);
    }
  }, [controls.enabled, active]);

  /**
   * Activates the measure tool or cancels the measure in progress
   */
  const handleMeasureClick = () => {
    if (active) {
      // cancel: the cleanup of the effect removes the half drawn measure
      // and restores the controls
      setActive(false);
    } else {
      controls.enabled = false;
      setActive(true);
      if (!openPanel) {
        dispatch(setOpenMeausurePanel(true));
      }
    }
  };

  return (
    <div className="popover__wrapper">
      <Button typeClass="btn--img btn__icon button" img={rulerIcon} onClick={handleMeasureClick} title="Measure" active={active} />
      <div className="popover__content rounded">
        <p className="popover__message">
          Press Left Mouse click to start drawing a line. Continue to hold the left mouse and click again to mark the end of the line. Click the
          measure button again or press Escape to cancel the measure in progress.
        </p>
      </div>
    </div>
  );
}

Measurements.propTypes = {
  openPanel: PropTypes.bool,
};
