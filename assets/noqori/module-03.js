(() => {
  "use strict";

  const STATES = {
    preparing: {
      kicker: "REQUEST SUBMITTED",
      title: "Preparing analysis.",
      status: "Connecting to the audit service.",
      guidance: "Submitting one audit request. This usually takes a moment.",
      step: 0
    },
    queued: {
      kicker: "ANALYSIS QUEUED",
      title: "Preparing analysis.",
      status: "Your request is queued and waiting for the audit worker.",
      guidance: "Your request is waiting for an audit worker. NOQORI will check its status for up to 90 seconds.",
      step: 1
    },
    running: {
      kicker: "AUDIT IN PROGRESS",
      title: "Analyzing your website.",
      status: "Observing structure and performance signals.",
      guidance: "NOQORI is inspecting observable website signals. This can take a little time.",
      step: 2
    },
    reconnecting: {
      kicker: "STATUS RECONNECTING",
      title: "Analysis is still running.",
      status: "Reconnecting without starting another audit.",
      guidance: "No new audit was started. NOQORI is reconnecting to the current job.",
      step: 2
    },
    building: {
      kicker: "AUDIT COMPLETE",
      title: "Building your report.",
      status: "Loading the completed audit report.",
      guidance: "The audit is complete. NOQORI is loading the report.",
      step: 3
    },
    complete: {
      kicker: "REPORT READY",
      title: "Analysis complete.",
      status: "Opening your report.",
      guidance: "The report is ready to open.",
      step: 3
    },
    error: {
      kicker: "ANALYSIS INCOMPLETE",
      title: "We couldn’t complete this analysis.",
      status: "The audit stopped before a report was ready.",
      guidance: "Review the message below, then edit the URL and retry."
    }
  };

  function formatTarget(value) {
    const raw = String(value || "").trim();

    try {
      const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
      return `${parsed.hostname}${path}`;
    } catch {
      return raw;
    }
  }

  function safeCode(value) {
    const code = String(value || "").trim();
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "";
  }

  function createAnalysisExperience(options = {}) {
    const root = options.root || document.getElementById("analysisExperience");
    const landing = options.landing || document.getElementById("landing");
    const input = options.input || document.getElementById("urlInput");
    const title = root?.querySelector("#analysisTitle");
    const kicker = root?.querySelector("#analysisKicker");
    const target = root?.querySelector("#analysisTarget");
    const status = root?.querySelector("#analysisStatusText");
    const guidance = root?.querySelector("#analysisGuidance");
    const delay = root?.querySelector("#analysisDelayMessage");
    const stopArea = root?.querySelector("#analysisStopArea");
    const stop = root?.querySelector("#analysisStop");
    const steps = [...(root?.querySelectorAll("[data-analysis-step]") || [])];
    const error = root?.querySelector("#analysisError");
    const errorMessage = root?.querySelector("#analysisErrorMessage");
    const errorDetails = root?.querySelector("#analysisErrorDetails");
    const errorCode = root?.querySelector("#analysisErrorCode");
    const retry = root?.querySelector("#analysisRetry");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (!root || !landing || !title || !kicker || !target || !status || !guidance || !delay || !stopArea || !stop || steps.length !== 4 || !error || !errorMessage || !errorDetails || !errorCode || !retry) {
      throw new Error("NOQORI analysis experience could not initialize.");
    }

    let active = false;
    let delayTimer = null;

    function clearDelay() {
      if (delayTimer !== null) window.clearTimeout(delayTimer);
      delayTimer = null;
      delay.hidden = true;
      delete root.dataset.analysisDelayed;
    }

    function updateSteps(currentIndex) {
      steps.forEach((step, index) => {
        const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
        const stateLabel = state === "complete" ? "Completed" : state === "current" ? "Current" : "Upcoming";
        step.dataset.stepState = state;
        step.querySelector(".noqoriAnalysisStepState").textContent = stateLabel;
        if (state === "current") step.setAttribute("aria-current", "step");
        else step.removeAttribute("aria-current");
      });
    }

    function setState(name) {
      const next = STATES[name];
      if (!next) return;

      root.dataset.analysisState = name;
      kicker.textContent = next.kicker;
      title.textContent = next.title;
      status.textContent = next.status;
      guidance.textContent = next.guidance;
      if (Number.isInteger(next.step)) updateSteps(next.step);
      stopArea.hidden = name === "complete" || name === "error";

      if (name !== "error") {
        error.hidden = true;
        errorDetails.hidden = true;
        errorCode.textContent = "";
      }
    }

    function show(value) {
      active = true;
      target.textContent = formatTarget(value);
      landing.classList.add("is-analysis-active");
      root.hidden = false;
      setState("preparing");
      clearDelay();
      delayTimer = window.setTimeout(() => {
        if (!active) return;
        root.dataset.analysisDelayed = "true";
        delay.hidden = false;
      }, options.longWaitMs || 15_000);
      root.scrollIntoView({
        behavior: reducedMotion.matches ? "auto" : "smooth",
        block: "start"
      });
    }

    function fail(message, options = {}) {
      const code = safeCode(options.code);
      clearDelay();
      setState("error");
      errorMessage.textContent = String(message || "Please try again.");
      errorCode.textContent = code;
      errorDetails.hidden = !code;
      error.hidden = false;
      retry.focus({ preventScroll: true });
      window.requestAnimationFrame(() => {
        if (root.dataset.analysisState === "error") retry.focus({ preventScroll: true });
      });
    }

    function reset() {
      active = false;
      clearDelay();
      root.hidden = true;
      landing.classList.remove("is-analysis-active");
      error.hidden = true;
      errorDetails.hidden = true;
      errorCode.textContent = "";
      setState("preparing");
      input?.focus({ preventScroll: true });
    }

    async function complete() {
      clearDelay();
      setState("complete");
      const settleMs = reducedMotion.matches ? 40 : 460;
      await new Promise((resolve) => window.setTimeout(resolve, settleMs));
    }

    retry.addEventListener("click", reset);
    stop.addEventListener("click", () => {
      options.onStop?.();
      reset();
    });

    return {
      show,
      setState,
      fail,
      complete,
      reset,
      isActive() {
        return active;
      }
    };
  }

  window.NOQORIAnalysisExperience = { create: createAnalysisExperience };
})();
