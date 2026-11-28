module.exports = { join: (...a) => a.join("/").replace(/\/+/g, "/"), dirname: p => p.replace(/\/[^/]*$/, "") || "/" };
