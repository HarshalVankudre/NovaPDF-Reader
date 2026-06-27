"use strict";

const assert = require("assert");
const { buildTutorMessage } = require("../assets/tutor-message.js");

const textOnly = buildTutorMessage("  Was ist eine Relation?  ", []);
assert.strictEqual(textOnly.text, "Was ist eine Relation?");
assert.deepStrictEqual(textOnly.messages, [{
  role: "user",
  content: [{ type: "text", text: "Was ist eine Relation?" }],
}]);

const screenshot = {
  media_type: "image/png",
  data: "abc123",
  dataUrl: "data:image/png;base64,abc123",
};
const withScreenshot = buildTutorMessage("Löse Aufgabe 2", [screenshot]);
assert.match(withScreenshot.text, /^Löse Aufgabe 2/);
assert.deepStrictEqual(withScreenshot.messages[0].content[1], {
  type: "image",
  media_type: "image/png",
  data: "abc123",
});

for (const payload of [textOnly, withScreenshot]) {
  const wire = JSON.stringify(payload.messages);
  assert.doesNotMatch(wire, /Folie|Relevante Folien|lecture|slide/i);
}

console.log("tutor message payload checks passed");
