(() => {
  "use strict";

  const auditFocusControl = document.querySelector("[data-audit-focus]");
  const auditForm = document.getElementById("auditForm");
  const auditInput = document.getElementById("urlInput");
  const heroVisual = document.querySelector("[data-hero-motion]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const state = {
    frame: 0,
    bounds: null,
    current: { x: 0, y: 0, rotateX: 0, rotateY: 0 },
    target: { x: 0, y: 0, rotateX: 0, rotateY: 0 }
  };

  function focusAuditEntry(event) {
    if (!auditForm || !auditInput) return;

    event.preventDefault();
    window.history.pushState(null, "", "#auditForm");
    auditInput.focus({ preventScroll: true });
    auditForm.scrollIntoView({
      behavior: reducedMotion.matches ? "auto" : "smooth",
      block: "center"
    });
  }

  function setMotionProperties(values) {
    heroVisual.style.setProperty("--nq-pointer-x", `${values.x.toFixed(2)}px`);
    heroVisual.style.setProperty("--nq-pointer-y", `${values.y.toFixed(2)}px`);
    heroVisual.style.setProperty("--nq-pointer-rx", `${values.rotateX.toFixed(2)}deg`);
    heroVisual.style.setProperty("--nq-pointer-ry", `${values.rotateY.toFixed(2)}deg`);
    heroVisual.style.setProperty("--nq-grid-x", `${(values.x * -0.28).toFixed(2)}px`);
    heroVisual.style.setProperty("--nq-grid-y", `${(values.y * -0.28).toFixed(2)}px`);
  }

  function animateTowardTarget() {
    state.frame = 0;
    let needsAnotherFrame = false;

    for (const key of Object.keys(state.current)) {
      const distance = state.target[key] - state.current[key];
      state.current[key] += distance * 0.14;

      if (Math.abs(distance) > 0.02) {
        needsAnotherFrame = true;
      } else {
        state.current[key] = state.target[key];
      }
    }

    setMotionProperties(state.current);

    if (needsAnotherFrame) {
      state.frame = window.requestAnimationFrame(animateTowardTarget);
    }
  }

  function scheduleMotion() {
    if (!state.frame) {
      state.frame = window.requestAnimationFrame(animateTowardTarget);
    }
  }

  function resetMotion() {
    state.target = { x: 0, y: 0, rotateX: 0, rotateY: 0 };
    heroVisual.dataset.pointerActive = "false";
    scheduleMotion();
  }

  function updateMotionBounds() {
    state.bounds = heroVisual.getBoundingClientRect();
  }

  function clearMotionBounds() {
    state.bounds = null;
  }

  function handlePointerLeave() {
    clearMotionBounds();
    resetMotion();
  }

  function handlePointerMove(event) {
    if (heroVisual.dataset.pointerEnabled !== "true") return;

    if (!state.bounds) updateMotionBounds();
    const bounds = state.bounds;
    const horizontal = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
    const vertical = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
    state.target = {
      x: horizontal * 12,
      y: vertical * 9,
      rotateX: vertical * -3,
      rotateY: horizontal * 3.5
    };
    heroVisual.dataset.pointerActive = "true";
    scheduleMotion();
  }

  function updateMotionMode() {
    const pointerEnabled = finePointer.matches && !reducedMotion.matches;
    heroVisual.dataset.pointerEnabled = String(pointerEnabled);

    if (!pointerEnabled) resetMotion();
  }

  function cleanupMotion() {
    if (state.frame) window.cancelAnimationFrame(state.frame);
    heroVisual?.removeEventListener("pointermove", handlePointerMove);
    heroVisual?.removeEventListener("pointerenter", updateMotionBounds);
    heroVisual?.removeEventListener("pointerleave", handlePointerLeave);
    window.removeEventListener("resize", clearMotionBounds);
    reducedMotion.removeEventListener("change", updateMotionMode);
    finePointer.removeEventListener("change", updateMotionMode);
  }

  auditFocusControl?.addEventListener("click", focusAuditEntry);

  if (heroVisual) {
    setMotionProperties(state.current);
    heroVisual.dataset.motionReady = "true";
    heroVisual.addEventListener("pointerenter", updateMotionBounds, { passive: true });
    heroVisual.addEventListener("pointermove", handlePointerMove, { passive: true });
    heroVisual.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    window.addEventListener("resize", clearMotionBounds, { passive: true });
    reducedMotion.addEventListener("change", updateMotionMode);
    finePointer.addEventListener("change", updateMotionMode);
    updateMotionMode();
    window.addEventListener("beforeunload", cleanupMotion, { once: true });
  }
})();
