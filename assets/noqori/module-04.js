(() => {
  "use strict";

  const story = document.querySelector("[data-story]");
  const steps = story ? [...story.querySelectorAll("[data-story-step]")] : [];
  const visual = story?.querySelector("[data-story-visual]");
  const caption = story?.querySelector("[data-story-caption]");
  const auditInput = document.getElementById("urlInput");
  const auditForm = document.getElementById("auditForm");
  const auditLinks = [...document.querySelectorAll("[data-story-audit-focus]")];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const flowLayout = window.matchMedia("(max-width: 900px)");
  let observer = null;

  function setActiveStep(name) {
    if (!story || !steps.some(step => step.dataset.storyStep === name)) return;

    story.dataset.storyActive = name;
    visual?.setAttribute("data-active", name);
    if (caption) caption.textContent = name.toUpperCase();

    for (const step of steps) {
      if (step.dataset.storyStep === name) {
        step.dataset.active = "true";
      } else {
        step.removeAttribute("data-active");
      }
    }
  }

  function updateStoryMode() {
    if (!story) return;
    story.dataset.storyMode = flowLayout.matches ? "flow" : "sticky";
  }

  function chooseClosestVisibleStep(entries) {
    const visible = entries.filter(entry => entry.isIntersecting);
    if (!visible.length) return;

    const viewportCenter = window.innerHeight / 2;
    visible.sort((first, second) => {
      const firstCenter = first.boundingClientRect.top + first.boundingClientRect.height / 2;
      const secondCenter = second.boundingClientRect.top + second.boundingClientRect.height / 2;
      return Math.abs(firstCenter - viewportCenter) - Math.abs(secondCenter - viewportCenter);
    });
    setActiveStep(visible[0].target.dataset.storyStep);
  }

  function setupObserver() {
    observer?.disconnect();
    observer = null;

    if (!story || !steps.length || !("IntersectionObserver" in window)) return;

    observer = new IntersectionObserver(chooseClosestVisibleStep, {
      rootMargin: "-38% 0px -38% 0px",
      threshold: 0
    });
    steps.forEach(step => observer.observe(step));
  }

  function focusAuditEntry(event) {
    if (!auditInput || !auditForm) return;

    event.preventDefault();
    window.history.pushState(null, "", "#auditForm");
    auditInput.focus({ preventScroll: true });
    auditForm.scrollIntoView({
      behavior: reducedMotion.matches ? "auto" : "smooth",
      block: "center"
    });
  }

  function cleanup() {
    observer?.disconnect();
    flowLayout.removeEventListener("change", updateStoryMode);
    auditLinks.forEach(link => link.removeEventListener("click", focusAuditEntry));
  }

  if (story) {
    updateStoryMode();
    setupObserver();
    story.dataset.storyReady = "true";
    flowLayout.addEventListener("change", updateStoryMode);
  }

  auditLinks.forEach(link => link.addEventListener("click", focusAuditEntry));
  window.addEventListener("beforeunload", cleanup, { once: true });
})();
