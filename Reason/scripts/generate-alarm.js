/**
 * Writes a short PCM WAV (~0.35s) for bundled notification + expo-av playback.
 * Run: node scripts/generate-alarm.js
 */
const fs = require('fs');
const path = require('path');

const sampleRate = 22050;
const duration = 0.35;
const freq = 880;
const numSamples = Math.floor(sampleRate * duration);
const dataSize = numSamples * 2;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 2, 28);
buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

for (let i = 0; i < numSamples; i++) {
  const attack = Math.min(1, i / (sampleRate * 0.04));
  const release = Math.min(1, (numSamples - i) / (sampleRate * 0.08));
  const envelope = attack * release;
  const sample =
    Math.sin((2 * Math.PI * freq * i) / sampleRate) * envelope * 0.75;
  const intSample = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
  buffer.writeInt16LE(intSample, 44 + i * 2);
}

const out = path.join(__dirname, '..', 'assets', 'alarm.wav');
fs.writeFileSync(out, buffer);
console.log('Wrote', out);
