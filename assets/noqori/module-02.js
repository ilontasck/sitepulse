(() => {
  "use strict";

  const auditFocusControl = document.querySelector("[data-audit-focus]");
  const auditForm = document.getElementById("auditForm");
  const auditInput = document.getElementById("urlInput");
  const authPanel = document.getElementById("authPanel");
  const loginEmail = document.getElementById("loginEmail");
  const heroVisual = document.querySelector("[data-hero-motion]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  let motionBounds = null;

  function focusAuditEntry(event) {
    if (!auditForm || !auditInput) return;

    event.preventDefault();
    window.history.pushState(null, "", "#auditForm");
    const target = auditForm.hidden ? loginEmail : auditInput;
    const targetRegion = auditForm.hidden ? authPanel : auditForm;
    target.focus({ preventScroll: true });
    targetRegion.scrollIntoView({
      behavior: reducedMotion.matches ? "auto" : "smooth",
      block: "center"
    });
  }

  function resetMotion() {
    heroVisual.dataset.pointerActive = "false";
    heroVisual.dataset.pointerPosition = "center";
  }

  function updateMotionBounds() {
    motionBounds = heroVisual.getBoundingClientRect();
  }

  function clearMotionBounds() {
    motionBounds = null;
  }

  function handlePointerLeave() {
    clearMotionBounds();
    resetMotion();
  }

  function handlePointerMove(event) {
    if (heroVisual.dataset.pointerEnabled !== "true") return;

    if (!motionBounds) updateMotionBounds();
    const bounds = motionBounds;
    const horizontal = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
    const vertical = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
    const horizontalPosition = horizontal < -0.2 ? "left" : horizontal > 0.2 ? "right" : "center";
    const verticalPosition = vertical < -0.2 ? "top" : vertical > 0.2 ? "bottom" : "middle";
    heroVisual.dataset.pointerPosition = horizontalPosition === "center" && verticalPosition === "middle"
      ? "center"
      : `${verticalPosition}-${horizontalPosition}`;
    heroVisual.dataset.pointerActive = "true";
  }

  function updateMotionMode() {
    const pointerEnabled = finePointer.matches && !reducedMotion.matches;
    heroVisual.dataset.pointerEnabled = String(pointerEnabled);

    if (!pointerEnabled) resetMotion();
  }

  function cleanupMotion() {
    heroVisual?.removeEventListener("pointermove", handlePointerMove);
    heroVisual?.removeEventListener("pointerenter", updateMotionBounds);
    heroVisual?.removeEventListener("pointerleave", handlePointerLeave);
    window.removeEventListener("resize", clearMotionBounds);
    reducedMotion.removeEventListener("change", updateMotionMode);
    finePointer.removeEventListener("change", updateMotionMode);
  }

  auditFocusControl?.addEventListener("click", focusAuditEntry);

  if (heroVisual) {
    resetMotion();
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
