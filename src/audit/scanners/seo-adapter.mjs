import { countMatches, firstMatch, stripTags } from "./http-html-scanner.mjs";

function metaContent(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (
    firstMatch(html, new RegExp(`<meta[^>]+name=["']${escapedName}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i")) ||
    firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escapedName}["'][^>]*>`, "i")) ||
    firstMatch(html, new RegExp(`<meta[^>]+property=["']${escapedName}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i")) ||
    firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escapedName}["'][^>]*>`, "i"))
  );
}

function check(id, label, passed, priority = "medium", details = "") {
  return { id, label, passed, priority, details };
}

export function runSeoAdapter(context) {
  const html = context.html;
  const title = stripTags(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const metaDescription = metaContent(html, "description");
  const canonical = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i);
  const robotsMeta = metaContent(html, "robots");
  const h1Count = countMatches(html, /<h1\b/gi);
  const ogTitle = metaContent(html, "og:title");
  const ogDescription = metaContent(html, "og:description");
  const ogImage = metaContent(html, "og:image");

  return {
    adapter: "seo",
    signals: {
      title,
      titleLength: title.length,
      metaDescription,
      metaDescriptionLength: metaDescription.length,
      canonical,
      hasCanonical: Boolean(canonical),
      robotsMeta,
      hasRobotsNoindex: /\bnoindex\b/i.test(robotsMeta),
      h1Count,
      hasOpenGraph: Boolean(ogTitle || ogDescription || ogImage),
      openGraphFields: {
        title: Boolean(ogTitle),
        description: Boolean(ogDescription),
        image: Boolean(ogImage)
      }
    },
    checks: {
      seo: [
        check("title-present", "Page has a title tag.", title.length > 0, "high"),
        check("title-length", "Title length is within a useful search snippet range.", title.length >= 25 && title.length <= 65, "medium", `${title.length} characters`),
        check("meta-description", "Page has a meta description.", metaDescription.length > 0, "high"),
        check("canonical", "Page declares a canonical URL.", Boolean(canonical), "low"),
        check("h1-count", "Page has exactly one H1.", h1Count === 1, "medium", `${h1Count} H1 tags`),
        check("robots-indexable", "Robots meta does not block indexing.", !/\bnoindex\b/i.test(robotsMeta), "high"),
        check("open-graph", "Basic Open Graph metadata is present.", Boolean(ogTitle || ogDescription || ogImage), "low")
      ]
    },
    warnings: []
  };
}
