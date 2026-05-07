// Saga browser runtime — IIFE injected into the composition HTML so that
// timelines are seek-driven and clip visibility is managed deterministically.
//
// Globals exposed (Saga-namespaced; do not collide with Hyperframes):
//
//   window.__sagaTimelines     — { [compositionId]: paused gsap.Timeline }
//   window.__sagaClipManifest  — array of { id, start, duration, track }
//   window.__sagaPlayerReady   — true once registration completes
//   window.__sagaRenderReady   — true once timelines are linked & ready to seek
//
// We deliberately mirror the spirit of the Hyperframes runtime contract
// (paused timelines, hidden .clip elements until in-window, seek-driven
// motion) without using their globals.

export const SAGA_RUNTIME_IIFE = String.raw`
(function () {
  if (window.__sagaRuntimeInstalled) return;
  window.__sagaRuntimeInstalled = true;
  window.__sagaTimelines = window.__sagaTimelines || {};
  window.__sagaClipManifest = window.__sagaClipManifest || [];
  window.__sagaSeek = window.__sagaSeek || function (id, t) {
    var tl = window.__sagaTimelines[id];
    if (!tl) return;
    if (typeof tl.seek === "function") tl.seek(Number(t) || 0);
  };

  function clipsInRoot() {
    return Array.prototype.slice.call(document.querySelectorAll(".clip"));
  }

  function readClip(el) {
    return {
      id: el.id,
      start: Number(el.dataset.start || 0),
      duration: Number(el.dataset.duration || 0),
      track: Number(el.dataset.trackIndex || el.dataset.track || 0),
    };
  }

  function updateClipVisibility(now) {
    clipsInRoot().forEach(function (el) {
      var info = readClip(el);
      var inWindow = now >= info.start && now < info.start + info.duration;
      el.style.visibility = inWindow ? "visible" : "hidden";
    });
  }

  window.__sagaRegisterTimeline = function registerTimeline(compositionId, build) {
    var tl = window.gsap ? window.gsap.timeline({ paused: true }) : null;
    if (!tl) {
      window.__sagaTimelines[compositionId] = null;
      window.__sagaPlayerReady = true;
      window.__sagaRenderReady = true;
      return null;
    }
    if (typeof build === "function") {
      try { build(tl); } catch (e) { console.error("[saga] buildTimeline error", e); }
    }
    tl.eventCallback && tl.eventCallback("onUpdate", function () {
      updateClipVisibility(tl.time());
    });
    window.__sagaTimelines[compositionId] = tl;
    window.__sagaClipManifest = clipsInRoot().map(readClip);
    window.__sagaPlayerReady = true;
    window.__sagaRenderReady = true;
    updateClipVisibility(0);
    return tl;
  };

  window.__sagaTransitionTween = function transitionTween(tl, selector, startSeconds, durationSeconds) {
    if (!tl || !window.gsap) return;
    var fadeIn = Math.max(0.12, durationSeconds * 0.4);
    var hold = Math.max(0.06, durationSeconds * 0.2);
    var fadeOut = Math.max(0.12, durationSeconds - fadeIn - hold);
    tl.fromTo(selector, { opacity: 0, xPercent: -28 }, { opacity: 1, xPercent: 0, duration: fadeIn, ease: "power2.out" }, startSeconds);
    tl.to(selector, { opacity: 1, duration: hold, ease: "none" }, startSeconds + fadeIn);
    tl.to(selector, { opacity: 0, xPercent: 28, duration: fadeOut, ease: "sine.inOut" }, startSeconds + fadeIn + hold);
    tl.set(selector, { opacity: 0, visibility: "hidden" }, startSeconds + durationSeconds);
  };

  window.__sagaVignetteTween = function vignetteTween(tl, selector, totalSeconds) {
    if (!tl || !window.gsap) return;
    tl.fromTo(selector, { opacity: 0.55 }, { opacity: 0.85, duration: totalSeconds, ease: "none" }, 0);
  };
}());
`;
