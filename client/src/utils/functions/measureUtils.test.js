import * as THREE from "three";
import {
  createMeasureLabel,
  formatMeasureLabelText,
  getMaxMeasureNumber,
  getMeasureGroupName,
  getMeasureNumber,
  getMeasureObjectNames,
  groupMeasureObjects,
  removeObjectFromScene,
  updateMeasureLabel,
} from "./measureUtils";

describe("measureUtils numbering", () => {
  it("extracts the full numeric index, also above 9", () => {
    expect(getMeasureNumber("Measure1")).toBe(1);
    expect(getMeasureNumber("Measure9")).toBe(9);
    expect(getMeasureNumber("Measure10")).toBe(10);
    expect(getMeasureNumber("Measure12start")).toBe(12);
    expect(getMeasureNumber("Measure123end")).toBe(123);
  });

  it("returns null for names that are not measures", () => {
    expect(getMeasureNumber("Plane1")).toBeNull();
    expect(getMeasureNumber("Comment2")).toBeNull();
    expect(getMeasureNumber("")).toBeNull();
    expect(getMeasureNumber(undefined)).toBeNull();
  });

  it("computes the group name for every object of a measure", () => {
    expect(getMeasureGroupName("Measure10")).toBe("Measure10");
    expect(getMeasureGroupName("Measure10start")).toBe("Measure10");
    expect(getMeasureGroupName("Measure10end")).toBe("Measure10");
    expect(getMeasureGroupName("Comment1")).toBeNull();
  });

  it("lists the objects that compose a measure", () => {
    expect(getMeasureObjectNames("Measure3")).toEqual(["Measure3", "Measure3start", "Measure3end"]);
  });

  it("returns the max measure number used to continue the counter", () => {
    const list = [{ name: "Measure1" }, { name: "Measure10" }, { name: "Measure2" }, { name: "Measure9end" }];
    expect(getMaxMeasureNumber(list)).toBe(10);
    expect(getMaxMeasureNumber([])).toBe(0);
    expect(getMaxMeasureNumber([{ name: "Plane1" }])).toBe(0);
  });

  it("groups the saved objects by measure and sorts the groups numerically", () => {
    const objects = [
      { objectName: "Measure10start" },
      { objectName: "Measure1" },
      { objectName: "Measure10" },
      { objectName: "Measure2end" },
      { objectName: "Measure1start" },
      { objectName: "Measure10end" },
      { objectName: "Measure2" },
      { objectName: "Measure1end" },
      { objectName: "Measure2start" },
      { objectName: "Comment1" },
    ];

    const groups = groupMeasureObjects(objects);

    // Measure10 must not be grouped with Measure1 and the order must be numeric
    expect(groups.map((group) => getMeasureGroupName(group[0].objectName))).toEqual(["Measure1", "Measure2", "Measure10"]);
    expect(groups.map((group) => group.length)).toEqual([3, 3, 3]);
  });
});

describe("measureUtils label", () => {
  it("formats the label text with the shared rule", () => {
    expect(formatMeasureLabelText(3, 12.345)).toBe("M3: 12.35mm");
    expect(formatMeasureLabelText(10, 0)).toBe("M10: 0.00mm");
  });

  it("creates the label with class, id, text and midpoint position", () => {
    const point1 = new THREE.Vector3(0, 0, 0);
    const point2 = new THREE.Vector3(10, 0, 0);

    const label = createMeasureLabel("Measure4", 4, 10, point1, point2);

    expect(label.name).toBe("Measure4");
    expect(label.element.className).toBe("measurementLabel");
    expect(label.element.id).toBe("Measure4");
    expect(label.element.textContent).toBe("M4: 10.00mm");
    expect(label.position.x).toBe(5);
    expect(label.position.y).toBe(0);
    expect(label.position.z).toBe(0);
  });

  it("updates text and position of an existing label", () => {
    const label = createMeasureLabel("Measure1", 1, 0, new THREE.Vector3(), new THREE.Vector3());

    updateMeasureLabel(label, 1, 20, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 20, 0));

    expect(label.element.textContent).toBe("M1: 20.00mm");
    expect(label.position.y).toBe(10);
  });
});

describe("measureUtils removeObjectFromScene", () => {
  it("removes the object, its label DOM element and disposes the resources", () => {
    const scene = new THREE.Scene();
    const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    line.name = "Measure1";
    const label = createMeasureLabel("Measure1", 1, 0, new THREE.Vector3(), new THREE.Vector3());
    line.add(label);
    scene.add(line);

    // simulates the CSS2DRenderer that appends the element to its dom element
    const labelContainer = document.createElement("div");
    document.body.appendChild(labelContainer);
    labelContainer.appendChild(label.element);

    removeObjectFromScene(scene, line);

    expect(scene.getObjectByName("Measure1")).toBeUndefined();
    expect(scene.children).toHaveLength(0);
    expect(label.element.parentNode).toBeNull();
  });

  it("does nothing without scene or object", () => {
    expect(() => removeObjectFromScene(null, null)).not.toThrow();
    expect(() => removeObjectFromScene(new THREE.Scene(), null)).not.toThrow();
  });
});
