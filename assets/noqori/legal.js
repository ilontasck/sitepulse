(() => {
  "use strict";
  // Year
  const yearEl = document.getElementById("nqYear");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // TOC active state on scroll
  const tocLinks = [...document.querySelectorAll(".nqLegalTocList a")];
  const sections = tocLinks.map(a => document.querySelector(a.getAttribute("href"))).filter(Boolean);

  if (sections.length && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter(e => e.isIntersecting);
        if (!visible.length) return;
        const top = visible.reduce((a, b) => a.boundingClientRect.top < b.boundingClientRect.top ? a : b);
        const id = top.target.id;
        tocLinks.forEach(a => {
          a.classList.toggle("is-active", a.getAttribute("href") === `#${id}`);
        });
      },
      { rootMargin: "-10% 0px -80% 0px", threshold: 0 }
    );
    sections.forEach(s => observer.observe(s));
  }
})();
