export function setup() {
  globalThis.AudioContext = class { createOscillator() { return { connect() {}, start() {}, stop() {} }; } };
}
