module.exports = { randomBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return { toString: () => Array.from(a, b => b.toString(16).padStart(2, "0")).join("") }; } };
