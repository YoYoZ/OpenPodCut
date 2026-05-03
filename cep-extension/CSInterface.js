/**
 * Minimal CSInterface shim for CEP panels.
 * Only implements what podcast-cutter uses: new CSInterface() and evalScript().
 * The real adobe/CEP CSInterface.js is 1000+ lines; this covers 100% of our usage.
 */

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof callback !== 'function') callback = function () {};
  window.__adobe_cep__.evalScript(script, callback);
};
