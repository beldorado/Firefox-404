import { h } from './dom.js';
import { getClip, putClip } from '../shared/pad-store.js';
import { encodeWav } from '../shared/wav.js';

const MAX_SECONDS = 60;
const DECODE_RATE = 48000;

export async function importSample(index, file) {
  let decoded;
  try {
    decoded = await new OfflineAudioContext(2, 1, DECODE_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} isn't an audio file Firefox can read. Try WAV, MP3, OGG or FLAC.`);
  }
  const frames = Math.min(decoded.length, Math.round(MAX_SECONDS * decoded.sampleRate));
  const channels = Array.from({ length: Math.min(2, decoded.numberOfChannels) }, (_, ch) => decoded.getChannelData(ch).slice(0, frames));
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || `Pad ${index + 1}`;
  await putClip({ index, name, bpm: null, sampleRate: decoded.sampleRate, channels });
  return { name, truncated: decoded.length > frames };
}

export async function exportPad(index) {
  const record = await getClip(index);
  if (!record?.channels?.length) throw new Error(`Pad ${index + 1} has no audio to export.`);
  const url = URL.createObjectURL(new Blob([encodeWav(record.channels, record.sampleRate)], { type: 'audio/wav' }));
  const filename = `${(record.name || `Pad ${index + 1}`).replace(/[\\/:*?"<>|]+/g, '-').trim()}.wav`;
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return filename;
}
