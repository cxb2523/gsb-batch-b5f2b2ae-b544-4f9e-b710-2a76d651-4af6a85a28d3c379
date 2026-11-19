// Stands in for src/net/pump.js in the session tests; records every worker message instead of starting one.
export const sent = [];
export function reset() {
  sent.length = 0;
}
export function send(session, message) {
  sent.push(message);
  session.pump?.postMessage({ type: "send", message });
}
