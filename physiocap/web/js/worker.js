// 분석(보정·역기구학·지표)을 화면 스레드와 분리해 실행
import { analyze } from './analysis.js';

self.onmessage = (e) => {
  const { id, frames, protocol, opts } = e.data;
  try {
    const out = analyze(frames, protocol, opts);
    self.postMessage({ id, ok: true, out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
