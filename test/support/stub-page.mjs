// Stands in for vel.gg's page (src/game/page.js) in the session tests; the test drives the reported screen and view.
export const BASE = "/bsz/";
export const MAP_SLUGS = { zombie_theater: "kino", zombie_cod5_prototype: "nacht" };
export const MAP_NAMES = { kino: "Kino der Toten", nacht: "Nacht der Untoten" };

export const state = { screen: "playing", slug: "kino", horde: false, guns: "classic", zone: "zombie_theater", view: null };

export const screen = () => state.screen;
export const currentSlug = () => state.slug;
export const currentHorde = () => state.horde;
export const currentGuns = () => state.guns;
export const currentZone = () => state.zone;
export const latestView = () => state.view;
export const go = () => {};
export const devmapZone = () => state.zone;
export const insertBeforeDevmap = () => {};
export const applyGameSettings = () => {};
export const gameSettings = () => [];
