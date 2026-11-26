let context = null;

export function getAudioContext() {
  if (!context) context = new AudioContext();
  return context;
}

export function playSound(kind, enabled) {
  if (!enabled) return;
  const audio = getAudioContext();
  const oscillator = audio.createOscillator();
  if (kind === 'error') oscillator.frequency = 220;
  oscillator.start();
  oscillator.stop();
}
