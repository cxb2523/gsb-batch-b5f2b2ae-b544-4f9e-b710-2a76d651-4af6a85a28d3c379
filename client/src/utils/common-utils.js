/**
 * Get element by id
 * @param {String} id Uuid of element
 * @returns Element with the given id
 */
export const findById = (id) => (list) => list.flatMap((item) => (item.children ? [item, ...item.children] : item)).find((item) => item.uuid === id);

/**
 * Filter a list of objects with the name that starts with the given string.
 * @param {String} name The name of the objects to find
 * @returns {Array} A list of objects with the given name
 */
export const filterStartsWithName = (name) => (list) =>
  list.flatMap((item) => (item.children ? [item, ...item.children] : item)).filter((item) => item.name.startsWith(name));

/**
 * Filter a list of objects with the given name
 * @param {String} name The name of the object to find
 * @returns {Array} A list of objects with that name
 */
export const filterByName = (name) => (list) =>
  list.flatMap((item) => (item.children ? [item, ...item.children] : item)).filter((item) => item.name.includes(name));

/**
 * Get the maximum counter of the objects with the given name.
 * The counter is the full trailing number of the name, so it works
 * also for counters greater than 9.
 * @param {Array} list
 * @returns {Number} The highest counter of the given list
 */
export const getMaxCounter = (list) =>
  list.reduce((max, item) => {
    const match = /(\d+)$/.exec(item.name || "");
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);

export const filterObjectByName = (name) => (list) => list.filter((item) => item.objectName.startsWith(name));
