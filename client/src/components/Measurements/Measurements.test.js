import React from "react";
import "@testing-library/jest-dom";
import { mount } from "enzyme";
import { Provider } from "react-redux";
import { configureStore, getDefaultMiddleware } from "@reduxjs/toolkit";
import { act } from "react-dom/test-utils";
import * as THREE from "three";
import Measurements from "./Measurements";
import { sceneReducer } from "../../features/scene/sceneSlice";
import { countersReducer } from "../../features/counters/countersSlice";
import { dimensionsReducer } from "../../features/dimensions/dimensionsSlice";
import { measurementsReducer } from "../../features/measurements/measurementsSlice";
import { formatMeasureLabelText } from "../../utils/functions/measureUtils";

const createCanvas = () => {
  const canvas = document.createElement("div");
  Object.defineProperty(canvas, "offsetWidth", { value: 1000, configurable: true });
  Object.defineProperty(canvas, "offsetHeight", { value: 1000, configurable: true });
  document.body.appendChild(canvas);
  return canvas;
};

const createScene = () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.position.z = 500;
  scene.add(camera);

  const group = new THREE.Group();
  group.name = "Import";
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial());
  mesh.name = "Group1";
  group.add(mesh);
  scene.add(group);

  scene.updateMatrixWorld(true);

  return scene;
};

const createStore = ({ scene, canvas, controls, measureCounter = 0 }) =>
  configureStore({
    middleware: getDefaultMiddleware({
      serializableCheck: false,
      immutableCheck: false,
    }),
    reducer: {
      scene: sceneReducer,
      counters: countersReducer,
      dimensions: dimensionsReducer,
      measurements: measurementsReducer,
    },
    preloadedState: {
      scene: {
        scene,
        canvas,
        controls,
        sceneModified: false,
        selectedMesh: "",
        positionVector: {},
      },
      counters: { planeCounter: 0, commentCounter: 0, measureCounter, screwCounter: 0 },
      dimensions: { sidebar: 0, header: 0 },
      measurements: { openMeausurePanel: false },
    },
  });

// A class instance like the real TrackballControls: immer does not freeze class instances
class FakeControls {
  constructor() {
    this.enabled = true;
  }
}

const mountMeasurements = ({ measureCounter = 0 } = {}) => {
  const scene = createScene();
  const canvas = createCanvas();
  const controls = new FakeControls();
  const store = createStore({ scene, canvas, controls, measureCounter });

  const wrapper = mount(
    <Provider store={store}>
      <Measurements openPanel={false} />
    </Provider>,
  );

  return { wrapper, store, scene, canvas, controls };
};

const clickButton = (wrapper) => {
  wrapper.find("button").simulate("click");
  wrapper.update();
};

const pointerDown = (canvas, x, y) => {
  act(() => {
    canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
  });
};

const pointerMove = (canvas, x, y) => {
  act(() => {
    canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
  });
};

const measureObjects = (scene) => scene.children.filter((child) => child.name.startsWith("Measure"));

describe("Measurements component", () => {
  it("toggles the controls and the active state with the button", () => {
    const { wrapper, controls } = mountMeasurements();

    clickButton(wrapper);
    expect(controls.enabled).toBe(false);
    expect(wrapper.find("button").hasClass("bg-yellow-600")).toBe(true);

    clickButton(wrapper);
    expect(controls.enabled).toBe(true);
    expect(wrapper.find("button").hasClass("bg-yellow-600")).toBe(false);

    wrapper.unmount();
  });

  it("draws a measure with a label that matches the distance of its endpoints", () => {
    const { wrapper, store, scene, canvas, controls } = mountMeasurements();

    clickButton(wrapper);
    pointerDown(canvas, 500, 500);

    // half drawn measure: line, start point and label are in the scene
    expect(scene.getObjectByName("Measure1")).toBeDefined();
    expect(scene.getObjectByName("Measure1start")).toBeDefined();

    pointerMove(canvas, 600, 500);
    pointerDown(canvas, 600, 500);
    wrapper.update();

    // the finished measure is grouped with line, label and two points
    const groupMeasure = scene.getObjectByName("Measure1");
    expect(groupMeasure.type).toBe("Group");
    expect(groupMeasure.children.map((child) => child.name).sort()).toEqual(["Measure1", "Measure1end", "Measure1start"]);

    const line = groupMeasure.children.find((child) => child.type === "LineSegments");
    const label = line.children[0];
    const startPoint = groupMeasure.children.find((child) => child.name === "Measure1start");
    const endPoint = groupMeasure.children.find((child) => child.name === "Measure1end");
    const distance = startPoint.position.distanceTo(endPoint.position);

    // the label shows the real distance and sits in the middle of the line
    expect(distance).toBeGreaterThan(0);
    expect(label.element.textContent).toBe(formatMeasureLabelText(1, distance));
    expect(label.position.x).toBeCloseTo((startPoint.position.x + endPoint.position.x) / 2, 5);
    expect(label.position.y).toBeCloseTo((startPoint.position.y + endPoint.position.y) / 2, 5);
    expect(label.position.z).toBeCloseTo((startPoint.position.z + endPoint.position.z) / 2, 5);

    // the counter is incremented and the tool is back to the not measuring state
    expect(store.getState().counters.measureCounter).toBe(1);
    expect(controls.enabled).toBe(true);
    expect(wrapper.find("button").hasClass("bg-yellow-600")).toBe(false);

    wrapper.unmount();
  });

  it("continues the numbering above 9 after the scene is rebuilt", () => {
    // simulates a rebuilt scene with 10 saved measures
    const { wrapper, store, scene, canvas } = mountMeasurements({ measureCounter: 10 });

    clickButton(wrapper);
    pointerDown(canvas, 500, 500);
    pointerDown(canvas, 600, 500);
    wrapper.update();

    expect(scene.getObjectByName("Measure11")).toBeDefined();
    expect(scene.getObjectByName("Measure11start")).toBeDefined();
    expect(scene.getObjectByName("Measure11end")).toBeDefined();
    expect(store.getState().counters.measureCounter).toBe(11);

    // a new measure continues the sequential numbering
    clickButton(wrapper);
    pointerDown(canvas, 500, 500);
    expect(scene.getObjectByName("Measure12")).toBeDefined();
    pointerDown(canvas, 600, 500);
    wrapper.update();
    expect(store.getState().counters.measureCounter).toBe(12);

    wrapper.unmount();
  });

  it("cancel with the button removes the half drawn measure and restores the state", () => {
    const { wrapper, scene, canvas, controls } = mountMeasurements();

    clickButton(wrapper);
    pointerDown(canvas, 500, 500);

    const line = scene.getObjectByName("Measure1");
    const label = line.children[0];
    // simulates the CSS2DRenderer that appends the label element to its dom element
    const labelContainer = document.createElement("div");
    document.body.appendChild(labelContainer);
    labelContainer.appendChild(label.element);

    expect(scene.getObjectByName("Measure1start")).toBeDefined();

    // cancel the measure in progress
    clickButton(wrapper);

    // no half line, temporary point or label remains in the scene
    expect(measureObjects(scene)).toHaveLength(0);
    expect(scene.getObjectByName("Measure1start")).toBeUndefined();
    expect(label.element.parentNode).toBeNull();

    // controls and button are back to the not measuring state
    expect(controls.enabled).toBe(true);
    expect(wrapper.find("button").hasClass("bg-yellow-600")).toBe(false);

    // a new measure can be created after the cancel
    clickButton(wrapper);
    pointerDown(canvas, 500, 500);
    expect(scene.getObjectByName("Measure1")).toBeDefined();
    pointerDown(canvas, 600, 500);
    wrapper.update();
    expect(scene.getObjectByName("Measure1").type).toBe("Group");

    wrapper.unmount();
  });

  it("cancel with the Escape key removes the half drawn measure", () => {
    const { wrapper, scene, canvas, controls } = mountMeasurements();

    clickButton(wrapper);
    pointerDown(canvas, 500, 500);
    expect(scene.getObjectByName("Measure1")).toBeDefined();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    wrapper.update();

    expect(measureObjects(scene)).toHaveLength(0);
    expect(controls.enabled).toBe(true);

    wrapper.unmount();
  });

  it("removes all the pointer listeners and the half drawn measure on unmount", () => {
    const { wrapper, scene, canvas, controls } = mountMeasurements();

    const removeListenerSpy = jest.spyOn(canvas, "removeEventListener");

    clickButton(wrapper);
    pointerDown(canvas, 500, 500);
    expect(scene.getObjectByName("Measure1")).toBeDefined();

    wrapper.unmount();

    const removedEvents = removeListenerSpy.mock.calls.map((call) => call[0]);
    expect(removedEvents).toContain("pointerdown");
    expect(removedEvents).toContain("pointermove");

    // the scene and the controls are clean after the unmount
    expect(measureObjects(scene)).toHaveLength(0);
    expect(scene.getObjectByName("Measure1start")).toBeUndefined();
    expect(controls.enabled).toBe(true);

    // no listener reacts to the canvas anymore
    act(() => {
      canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 500, clientY: 500, bubbles: true }));
    });
    expect(measureObjects(scene)).toHaveLength(0);
  });
});
