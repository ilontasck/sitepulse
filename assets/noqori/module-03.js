(() => {
  "use strict";

  const STATES = {
    preparing: {
      kicker: "REQUEST SUBMITTED",
      title: "Preparing analysis.",
      status: "Connecting to the audit service."
    },
    queued: {
      kicker: "ANALYSIS QUEUED",
      title: "Preparing analysis.",
      status: "Your request is queued and waiting for the audit worker."
    },
    running: {
      kicker: "AUDIT IN PROGRESS",
      title: "Analyzing your website.",
      status: "Observing structure and performance signals."
    },
    reconnecting: {
      kicker: "STATUS RECONNECTING",
      title: "Analysis is still running.",
      status: "Reconnecting without starting another audit."
    },
    building: {
      kicker: "AUDIT COMPLETE",
      title: "Building your report.",
      status: "Loading the completed audit report."
    },
    complete: {
      kicker: "REPORT READY",
      title: "Analysis complete.",
      status: "Opening your report."
    },
    error: {
      kicker: "ANALYSIS INCOMPLETE",
      title: "We couldn’t complete this analysis.",
      status: "The audit stopped before a report was ready."
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
    const error = root?.querySelector("#analysisError");
    const errorMessage = root?.querySelector("#analysisErrorMessage");
    const errorDetails = root?.querySelector("#analysisErrorDetails");
    const errorCode = root?.querySelector("#analysisErrorCode");
    const retry = root?.querySelector("#analysisRetry");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (!root || !landing || !title || !kicker || !target || !status || !error || !errorMessage || !errorDetails || !errorCode || !retry) {
      throw new Error("NOQORI analysis experience could not initialize.");
    }

    let active = false;

    function setState(name) {
      const next = STATES[name];
      if (!next) return;

      root.dataset.analysisState = name;
      kicker.textContent = next.kicker;
      title.textContent = next.title;
      status.textContent = next.status;

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
      root.scrollIntoView({
        behavior: reducedMotion.matches ? "auto" : "smooth",
        block: "start"
      });
    }

    function fail(message, options = {}) {
      const code = safeCode(options.code);
      setState("error");
      errorMessage.textContent = String(message || "Please try again.");
      errorCode.textContent = code;
      errorDetails.hidden = !code;
      error.hidden = false;
      retry.focus({ preventScroll: true });
    }

    function reset() {
      active = false;
      root.hidden = true;
      landing.classList.remove("is-analysis-active");
      error.hidden = true;
      errorDetails.hidden = true;
      errorCode.textContent = "";
      setState("preparing");
      input?.focus({ preventScroll: true });
    }

    async function complete() {
      setState("complete");
      const settleMs = reducedMotion.matches ? 40 : 460;
      await new Promise((resolve) => window.setTimeout(resolve, settleMs));
    }

    retry.addEventListener("click", reset);

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
