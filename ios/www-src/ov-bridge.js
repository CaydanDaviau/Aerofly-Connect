// The overlay page runs inside the app: it uses the host's ov object and starts expanded.
window.ov = window.parent.ov;
new MutationObserver(function () { var b = document.querySelector(".bubble"); if (b) b.click(); }).observe(document.body, { childList: true, subtree: true });
