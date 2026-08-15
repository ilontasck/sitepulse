(() => {
  "use strict";

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function handleCategoryNavigation(event) {
    const link = event.target.closest('a[href^="#category-"]');
    if (!link) return;

    const hash = link.getAttribute("href");
    const targetId = hash.slice(1);
    const target = document.getElementById(targetId);

    if (target) {
      event.preventDefault();

      if (target.tagName === "DETAILS") {
        target.open = true;
      }

      const behavior = prefersReducedMotion() ? "instant" : "smooth";
      target.scrollIntoView({ behavior, block: "start" });

      const summary = target.querySelector("summary");
      if (summary) {
        summary.focus();
      }

      try {
        history.replaceState(null, "", hash);
      } catch {
        // Safe fallback in restricted environments
      }
    }
  }

  document.addEventListener("click", handleCategoryNavigation);
})();
