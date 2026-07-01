import { countMatches } from "./http-html-scanner.mjs";

function check(id, label, passed, priority = "medium", details = "") {
  return { id, label, passed, priority, details };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLabelForInput(html, inputTag) {
  const id = inputTag.match(/\sid=["']([^"']+)["']/i)?.[1];
  const ariaLabel = inputTag.match(/\saria-label=["'][^"']+["']/i);
  const ariaLabelledBy = inputTag.match(/\saria-labelledby=["'][^"']+["']/i);
  const type = inputTag.match(/\stype=["']([^"']+)["']/i)?.[1]?.toLowerCase();

  if (ariaLabel || ariaLabelledBy || type === "hidden" || type === "submit" || type === "button") {
    return true;
  }

  if (id && new RegExp(`<label[^>]+for=["']${escapeRegExp(id)}["']`, "i").test(html)) {
    return true;
  }

  return false;
}

function buttonHasName(buttonTag) {
  if (/\saria-label=["'][^"']+["']/i.test(buttonTag)) {
    return true;
  }

  const text = buttonTag.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0;
}

export function runAccessibilityAdapter(context) {
  const html = context.html;
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || "";
  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const inputTags = [...html.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
  const buttonTags = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)].map((match) => match[0]);
  const headingCounts = [1, 2, 3, 4, 5, 6].reduce((counts, level) => {
    counts[`h${level}`] = countMatches(html, new RegExp(`<h${level}\\b`, "gi"));
    return counts;
  }, {});
  const imagesMissingAlt = imageTags.filter((tag) => !/\salt=["'][^"']*["']/i.test(tag)).length;
  const inputsWithoutLabels = inputTags.filter((tag) => !hasLabelForInput(html, tag)).length;
  const buttonsWithoutNames = buttonTags.filter((tag) => !buttonHasName(tag)).length;
  const hasLang = /\slang=["'][^"']+["']/i.test(htmlTag);
  const hasHeadingStructure = headingCounts.h1 === 1 && Object.values(headingCounts).some((count) => count > 0);

  return {
    adapter: "accessibility",
    signals: {
      imageCount: imageTags.length,
      imagesMissingAlt,
      inputsWithoutLabels,
      buttonsWithoutNames,
      hasLang,
      headingCounts,
      hasHeadingStructure
    },
    checks: {
      accessibility: [
        check("html-lang", "HTML document declares a language.", hasLang, "medium"),
        check("image-alt", "Images include alt attributes.", imagesMissingAlt === 0, "high", `${imagesMissingAlt} missing alt attributes`),
        check("input-labels", "Form inputs have labels or accessible names.", inputsWithoutLabels === 0, "high", `${inputsWithoutLabels} inputs without labels`),
        check("button-names", "Buttons have readable accessible names.", buttonsWithoutNames === 0, "medium", `${buttonsWithoutNames} unnamed buttons`),
        check("heading-structure", "Heading structure starts with one clear H1.", hasHeadingStructure, "medium")
      ]
    },
    warnings: []
  };
}
