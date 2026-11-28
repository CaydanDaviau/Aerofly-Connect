// Full-screen sheets: map / radar / training / events pages, and the ATC panel (overlay page).
(function () {
  var $ = function (i) { return document.getElementById(i); };
  var titles = { map: "Map", atc: "Radar", train: "Training", events: "Events" };
  window.openSheet = function (what, url) { $("sheetTitle").textContent = titles[what] || ""; $("sheetFrame").src = url; $("sheet").hidden = false; };
  $("sheetClose").onclick = function () { $("sheet").hidden = true; $("sheetFrame").src = "about:blank"; };
  $("atcFab").hidden = false;
  $("atcFab").onclick = function () { $("atcSheet").hidden = false; };
  $("atcClose").onclick = function () { $("atcSheet").hidden = true; };
})();
