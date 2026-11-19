// Test-only ESM loader: rewrites the browser-only import paths the session modules use to stubs under test/support,
// so the session layer can run under plain Node with a simulated engine. Relative files and node specifiers pass
// through untouched.
const support = (name) => new URL(name, import.meta.url).href;
const data = (body) => `data:text/javascript,${encodeURIComponent(body)}`;

const IMPORTS = {
  "../game/page.js": support("stub-page.mjs"),
  "../../game/page.js": support("stub-page.mjs"),
  "../net/pump.js": support("stub-pump.mjs"),
  "../../net/pump.js": support("stub-pump.mjs"),
  "../../relay/src/protocol.js": data(`export const MAX_GUESTS = 3; export const GUEST_ID_PATTERN = /^[a-z0-9]{8,32}$/; export const normalizeRoomCode = (x) => x; export const createGuestId = () => "guestid01";`),
  "../ui/strings.js": data(`export const T = new Proxy({}, { get: () => (key) => key });`),
  "../../ui/strings.js": data(`export const T = new Proxy({}, { get: () => (key) => key });`),
  "../util/relay.js": data(`export const isLoopback = () => true; export const normalizeRelay = (x) => x; export const pickRelay = () => "http://127.0.0.1:9"; export const DEFAULT_RELAY = "http://relay";`),
  "../../util/relay.js": data(`export const isLoopback = () => true; export const normalizeRelay = (x) => x; export const pickRelay = () => "http://127.0.0.1:9"; export const DEFAULT_RELAY = "http://relay";`),
  "../util/settings.js": data(`export const cleanName = (x) => x; export const readSetting = () => "";`),
  "../../util/settings.js": data(`export const cleanName = (x) => x; export const readSetting = () => "";`),
};

export async function resolve(specifier, context, nextResolve) {
  if (IMPORTS[specifier]) return nextResolve(IMPORTS[specifier], context);
  return nextResolve(specifier, context);
}
