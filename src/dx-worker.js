// Runs the diabetes engine's heavy calculations off the page's main thread.
// forecastAccuracy alone replays the 2-hour hypo forecast hundreds of times
// (tens of seconds of CPU), which froze the whole UI — taps and dropdowns
// dead, half-painted screens — when run on the page itself. app.js talks to
// this through engineAsync(); results are plain data, so they cross the
// worker boundary unchanged.
self.module = { exports: {} };
importScripts('diabetes-engine.js');
const Engine = self.module.exports;

self.onmessage = (event) => {
  const { id, fn, args } = event.data;
  try {
    if (typeof Engine[fn] !== 'function') throw new Error('Unknown engine function: ' + fn);
    self.postMessage({ id, result: Engine[fn](...args) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
