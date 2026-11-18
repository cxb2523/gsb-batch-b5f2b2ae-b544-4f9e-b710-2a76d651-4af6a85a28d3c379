# Measurement

### Usage

1. The user clicks the dedicated button in the sidebar
2. The user clicks on the mesh
3. To finish the measurement the user has to maintain click button pressed and clicks another time on the mesh.
4. It is possible to see the value of the measurement on the mesh
5. To cancel a measurement in progress the user clicks the measure button again or presses the Escape key: the half drawn line, the temporary start point and the label are removed and the controls are re-enabled.

### How measurement works

The measurement functionality is based on the canvas event of pointerDown and pointerMove (to be adaptive for iPad too). The system creates two events. The movement events are important because they catch the mouse movements to add the point and the distance between the two points.

The measurement object group is composed by four objects, two points, _THREE.Point()_, one line, _THREE.LineSegments()_, and a label, _CSS2DRenderer()_.

### Numbering and rebuild

The measures are named `Measure` + index (`Measure1`, `Measure2`, ...). The same numbering and label rules are shared between the creation of a measure (`Measurements.jsx`) and the rebuild of a saved scene (`useCreateScene.js`): the shared helpers live in `src/utils/functions/measureUtils.js`. When a saved project is loaded, the measure counter is restored from the highest measure index found in the saved objects, so the numbering stays sequential also with more than 9 measures.

The pointer listeners are attached only while the measure tool is active; when the tool is deactivated, cancelled or the component is unmounted, the listeners are removed and no half drawn measure is left in the scene.
