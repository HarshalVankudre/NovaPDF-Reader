/* Hidden per-browser tutor preferences. Credentials stay on the server. */
(function () {
  "use strict";
  const dialog = document.getElementById("adminDialog");
  const modelSelect = document.getElementById("adminModel");
  const effortSelect = document.getElementById("adminEffort");
  const status = document.getElementById("adminStatus");
  const save = document.getElementById("adminSave");
  const retry = document.getElementById("adminRetry");
  const STORAGE_KEY = "readerPreferences";
  const LABELS = { low: "Niedrig", medium: "Mittel", high: "Hoch", xhigh: "Sehr hoch", max: "Maximum" };
  let preferences = {}, catalog = null, catalogPending = null, opening = 0;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (stored && typeof stored.model === "string") preferences.model = stored.model;
    if (stored && Object.prototype.hasOwnProperty.call(LABELS, stored.effort)) preferences.effort = stored.effort;
  } catch (e) {}

  function option(value, label) {
    const item = document.createElement("option");
    item.value = value; item.textContent = label;
    return item;
  }
  function updateEfforts(preferred) {
    const model = catalog.models.find((item) => item.id === modelSelect.value);
    const levels = model ? model.efforts : [];
    effortSelect.replaceChildren(...levels.map((level) => option(level, LABELS[level] || level)));
    effortSelect.value = levels.includes(preferred) ? preferred : (levels.includes(catalog.defaultEffort) ? catalog.defaultEffort : levels[0]);
  }
  function loadCatalog() {
    if (!catalogPending) {
      catalogPending = fetch("/prefs", { cache: "no-store" }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Einstellungen nicht verfügbar.");
        if (!Array.isArray(result.models) || !result.models.length) throw new Error("Keine Modelle verfügbar.");
        catalog = result;
        return result;
      }).finally(() => { catalogPending = null; });
    }
    return catalogPending;
  }
  function close() {
    opening++;
    if (dialog.open) dialog.close();
  }
  async function open() {
    const token = ++opening;
    if (!dialog.open) dialog.showModal();
    modelSelect.disabled = effortSelect.disabled = save.disabled = true;
    retry.hidden = true;
    status.textContent = "Einstellungen werden geladen…";
    try {
      const result = await loadCatalog();
      if (!dialog.open || token !== opening) return;
      modelSelect.replaceChildren(...result.models.map((model) => option(model.id, model.label)));
      modelSelect.value = result.models.some((model) => model.id === preferences.model) ? preferences.model : result.defaultModel;
      const fast = localStorageValue("aiFast") === "1";
      updateEfforts(preferences.effort || (fast ? "medium" : result.defaultEffort));
      modelSelect.disabled = effortSelect.disabled = save.disabled = false;
      status.textContent = "Gilt ab der nächsten Frage. Wird in diesem Browser gespeichert.";
      modelSelect.focus();
    } catch (error) {
      if (!dialog.open || token !== opening) return;
      status.textContent = "Einstellungen konnten nicht geladen werden. Bitte erneut versuchen.";
      retry.hidden = false;
    }
  }
  function localStorageValue(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  modelSelect.addEventListener("change", () => updateEfforts(effortSelect.value));
  document.getElementById("adminForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled) return;
    preferences = { model: modelSelect.value, effort: effortSelect.value };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (e) {}
    close();
  });
  document.getElementById("adminClose").addEventListener("click", close);
  retry.addEventListener("click", open);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
  });
  // Capture Esc before focused controls or the reader's keyboard handlers.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog.open) {
      event.preventDefault(); event.stopImmediatePropagation(); close(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) { if (dialog.open) close(); else open(); }
      return;
    }
    if (dialog.open) event.stopImmediatePropagation();
  }, true);
  window.ReaderSettings = { open, snapshot: () => ({ ...preferences }) };
})();
