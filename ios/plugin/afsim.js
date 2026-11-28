// JS side of the native plugin: TCP sim link, CORS-free HTTP, background keep-alive.
var exec = require("cordova/exec");
function call(a, args) { return new Promise(function (res, rej) { exec(res, function (e) { rej(new Error(typeof e === "string" ? e : (e && e.message) || "error")); }, "AFSim", a, args); }); }
module.exports = {
  tcpRead: function (host, port, ms) { return call("tcpRead", [host, port, ms]); },
  tcpClose: function () { return call("tcpClose", []); },
  http: function (method, url, headers, body, ms) { return call("http", [method, url, headers || {}, body == null ? "" : body, ms || 8000]); },
  keepAlive: function (on) { return call("keepAlive", [!!on]); }
};
