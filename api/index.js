// Vercel serverless entry — every route (static files, /lec, /q, /llm, /sql/*)
// goes through the exact handler that `node serve.js` uses locally, so the
// lecture-PDF disguise and endpoint behavior are identical in the cloud.
const { handleRequest } = require("../serve.js");

module.exports = handleRequest;
module.exports.config = { supportsResponseStreaming: true };
