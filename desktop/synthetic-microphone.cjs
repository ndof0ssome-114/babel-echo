// Executed inside the selftest renderer before any device enumeration.
module.exports = function installSyntheticMicrophone() {
  const media = navigator.mediaDevices;
  const getUserMedia = media.getUserMedia;
  const enumerateDevices = media.enumerateDevices;
  const active = new Set();
  const fixture = { calls: 0, active, cleanup() {
    for (const stream of [...active]) stream.getTracks().forEach((track) => track.stop());
    media.getUserMedia = getUserMedia;
    media.enumerateDevices = enumerateDevices;
  } };
  media.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'selftest-microphone',
    groupId: 'selftest', label: 'Synthetic selftest microphone' }];
  media.getUserMedia = async () => {
    fixture.calls++;
    const context = new AudioContext();
    await context.resume();
    const output = context.createMediaStreamDestination();
    const tone = context.createOscillator();
    const mute = context.createGain();
    mute.gain.value = 0;
    tone.connect(mute).connect(output);
    tone.start();
    const stream = output.stream;
    active.add(stream);
    const track = stream.getAudioTracks()[0];
    const stop = track.stop.bind(track);
    track.getSettings = () => ({ deviceId: 'selftest-microphone' });
    track.stop = () => {
      stop();
      if (!active.delete(stream)) return;
      tone.stop();
      context.close().catch(() => {});
    };
    return stream;
  };
  window.miaojiSyntheticMicrophone = fixture;
};
