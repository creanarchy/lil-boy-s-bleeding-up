/* telegram-sdk-init.js — plug-and-play helper for Telegram Mini Apps */
(function () {
  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  if (!tg) { return; } // no-op outside Telegram

  window.tg = tg;

  function applyTheme(params) {
    var root = document.documentElement;
    var map = {
      "--tg-bg": params.bg_color,
      "--tg-text": params.text_color,
      "--tg-hint": params.hint_color,
      "--tg-link": params.link_color,
      "--tg-button": params.button_color,
      "--tg-button-text": params.button_text_color,
      "--tg-secondary-bg": params.secondary_bg_color
    };
    for (var key in map) if (map[key]) root.style.setProperty(key, map[key]);
    if (tg.colorScheme === "dark") { root.classList.add("tg-dark"); root.classList.remove("tg-light"); }
    else { root.classList.add("tg-light"); root.classList.remove("tg-dark"); }
  }
  tg.onEvent("themeChanged", function () { applyTheme(tg.themeParams || {}); });

  function signalReady() {
    try { tg.ready(); if (typeof tg.expand === "function") tg.expand(); } catch (e) {}
  }
  if (document.readyState === "complete") setTimeout(signalReady, 0);
  else window.addEventListener("load", function(){ setTimeout(signalReady, 0); });

  applyTheme(tg.themeParams || {});

  var h = tg.HapticFeedback;
  window.tgHaptics = {
    impact: function (style) { if (h && h.impactOccurred) h.impactOccurred(style || "light"); },
    selection: function () { if (h && h.selectionChanged) h.selectionChanged(); },
    notification: function (type) { if (h && h.notificationOccurred) h.notificationOccurred(type || "success"); }
  };

  function setVh(){ document.documentElement.style.setProperty("--tg-vh", window.innerHeight + "px"); }
  setVh(); window.addEventListener("resize", setVh);

  window.tgStartParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || null;
})();