import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

/**
 * Shared rules for the measurement feature.
 * The same numbering and label rules are used when a measure is drawn,
 * when a saved scene is rebuilt and when a half drawn measure is discarded.
 */

export const MEASURE_PREFIX = "Measure";

const MEASURE_NAME_REGEX = /^Measure(\d+)/;

/**
 * Extracts the numeric index from a measure name.
 * Works for the group/line name ("Measure12") and for the points
 * ("Measure12start", "Measure12end"), also for indexes greater than 9.
 * @param {String} name The name of the object
 * @returns {Number|null} The measure index or null if it is not a measure name
 */
export const getMeasureNumber = (name) => {
  const match = MEASURE_NAME_REGEX.exec(name || "");
  return match ? parseInt(match[1], 10) : null;
};

/**
 * Returns the name of the measure group ("Measure12") for any object of the
 * measure ("Measure12", "Measure12start", "Measure12end").
 * @param {String} name The name of the object
 * @returns {String|null} The measure group name or null if it is not a measure name
 */
export const getMeasureGroupName = (name) => {
  const number = getMeasureNumber(name);
  return number === null ? null : MEASURE_PREFIX + number;
};

/**
 * The names of the objects that compose a measure: line, start point, end point.
 * @param {String} name The measure group name
 * @returns {Array} The names of the measure objects
 */
export const getMeasureObjectNames = (name) => [name, name + "start", name + "end"];

/**
 * Returns the highest measure index of a list of objects with a `name` property.
 * @param {Array} list List of objects with a name property
 * @returns {Number} The highest measure index, 0 when there are no measures
 */
export const getMaxMeasureNumber = (list) =>
  list.reduce((max, item) => {
    const number = getMeasureNumber(item.name);
    return number !== null && number > max ? number : max;
  }, 0);

/**
 * Groups the saved objects ({ objectName, objectPath }) by their measure group
 * and sorts the groups by measure number, so the rebuild order matches the
 * creation order also for indexes greater than 9.
 * @param {Array} objects The saved objects of the project
 * @returns {Array} Array of measure groups, each group is a list of saved objects
 */
export const groupMeasureObjects = (objects) => {
  const groups = new Map();

  objects.forEach((object) => {
    const groupName = getMeasureGroupName(object.objectName);
    if (groupName === null) return;
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(object);
  });

  return [...groups.entries()].sort((a, b) => getMeasureNumber(a[0]) - getMeasureNumber(b[0])).map(([, items]) => items);
};

/**
 * The label text of a measure, shared between new and rebuilt measures.
 * @param {Number} count The measure index
 * @param {Number} distance The distance between the two points
 * @returns {String} The label text
 */
export const formatMeasureLabelText = (count, distance) => "M" + count + ": " + Number(distance).toFixed(2) + "mm";

/**
 * Creates the CSS2D label of a measure. Used both when the measure is drawn
 * and when the scene is rebuilt from a saved project, so the two labels
 * always have the same style, content and position.
 * @param {String} name The measure group name
 * @param {Number} count The measure index
 * @param {Number} distance The distance between the two points
 * @param {THREE.Vector3} point1 The start point
 * @param {THREE.Vector3} point2 The end point
 * @returns {CSS2DObject} The label of the measure
 */
export const createMeasureLabel = (name, count, distance, point1, point2) => {
  const div = document.createElement("div");
  div.className = "measurementLabel";
  div.id = name;
  div.textContent = formatMeasureLabelText(count, distance);

  const label = new CSS2DObject(div);
  label.name = name;
  label.position.lerpVectors(point1, point2, 0.5);

  return label;
};

/**
 * Updates text and position of an existing measure label.
 * @param {CSS2DObject} label The label to update
 * @param {Number} count The measure index
 * @param {Number} distance The distance between the two points
 * @param {THREE.Vector3} point1 The start point
 * @param {THREE.Vector3} point2 The end point
 */
export const updateMeasureLabel = (label, count, distance, point1, point2) => {
  label.element.textContent = formatMeasureLabelText(count, distance);
  label.position.lerpVectors(point1, point2, 0.5);
};

/**
 * Removes an object from the scene together with the DOM element of its
 * CSS2D labels (the CSS2DRenderer does not remove them by itself) and
 * disposes geometry and material.
 * @param {THREE.Scene} scene The scene
 * @param {THREE.Object3D} object The object to remove
 */
export const removeObjectFromScene = (scene, object) => {
  if (!scene || !object) return;

  object.traverse((child) => {
    if (child.isCSS2DObject && child.element.parentNode) {
      child.element.parentNode.removeChild(child.element);
    }
  });

  if (object.parent) {
    object.parent.remove(object);
  }
  if (object.geometry) {
    object.geometry.dispose();
  }
  if (object.material) {
    object.material.dispose();
  }
};
