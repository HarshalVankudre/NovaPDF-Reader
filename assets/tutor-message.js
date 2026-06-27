(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TutorMessageBuilder = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCREENSHOT_INSTRUCTION =
    "Das Bild enthält den gesamten Kontext der Aufgabe/Frage. Löse bzw. beantworte sie vollständig und " +
    "STRUKTURIERT: gliedere mit klaren Überschriften/Abschnitten, gib je Schritt eine kurze Begründung, " +
    "und schließe mit einem knappen Ergebnis. Nutze Listen, nummerierte Schritte oder eine Tabelle, wo es passt.";

  function buildTutorMessage(question, images) {
    const q = String(question || "").trim();
    const imgs = Array.isArray(images) ? images : [];
    const text = imgs.length ? (q ? q + "\n\n" : "") + SCREENSHOT_INSTRUCTION : q;
    const content = [{ type: "text", text }];
    for (const image of imgs) {
      content.push({
        type: "image",
        media_type: image.media_type || "image/png",
        data: image.data,
      });
    }
    return { text, messages: [{ role: "user", content }] };
  }

  return { buildTutorMessage };
});
