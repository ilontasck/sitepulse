import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(root, "assets", "noqori");
const productionRoot = join(assetRoot, "production");
const contactSheetPath = join(root, "docs", "design-qa", "noqori-current", "ste-25-production-assets.png");

const approvedSources = {
  ink: {
    file: "noqori-mark-ink.png",
    sha256: "ee8548669cdfb47954f13d0ad43da10fce35753dc2aa6a7644f657ca33640e8b"
  },
  light: {
    file: "noqori-mark-light.png",
    sha256: "8ed2d1ba0b6ba191f066c1bc54c145aa478be673c47afa9edf41bbf5de0f6978"
  },
  expressive: {
    file: "noqori-expressive-prototype.png",
    sha256: "148c0ff229739159fd76200222663441ab8735eeb83c69559d311b3258a38742"
  }
};

async function readApprovedSource(source) {
  const buffer = await readFile(join(assetRoot, source.file));
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== source.sha256) {
    throw new Error(`Approved source hash mismatch: ${source.file}`);
  }
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function renderPage(browser, { width, height, deviceScaleFactor = 1, html, output }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await page.screenshot({ path: output, animations: "disabled" });
  await context.close();
}

async function renderIcon(browser, { size, source, scale, threshold, separateComponents = false, output }) {
  const context = await browser.newContext({ viewport: { width: size, height: size } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#F5F5F2}
    canvas{display:block;width:100%;height:100%}img{display:none}
  </style><canvas width="${size}" height="${size}"></canvas><img src="${source}" alt="">`, { waitUntil: "load" });
  await page.locator("img").evaluate((image) => image.decode());
  await page.evaluate(({ drawScale, pixelThreshold, preserveComponents }) => {
    const canvas = document.querySelector("canvas");
    const image = document.querySelector("img");
    const context2d = canvas.getContext("2d", { alpha: false });
    const drawSize = canvas.width * drawScale;
    const x = (canvas.width - drawSize) / 2;
    const y = (canvas.height - drawSize) / 2 + canvas.height * 0.035;
    let outputMask;

    if (preserveComponents) {
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = image.naturalWidth;
      sourceCanvas.height = image.naturalHeight;
      const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
      sourceContext.drawImage(image, 0, 0);
      const sourceRaster = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      const sourceMask = new Uint8Array(sourceCanvas.width * sourceCanvas.height);
      for (let index = 0; index < sourceMask.length; index += 1) {
        const offset = index * 4;
        const luminance = sourceRaster.data[offset] * 0.2126 + sourceRaster.data[offset + 1] * 0.7152 + sourceRaster.data[offset + 2] * 0.0722;
        sourceMask[index] = luminance < 160 ? 1 : 0;
      }

      const labels = new Int32Array(sourceMask.length);
      const queue = new Int32Array(sourceMask.length);
      const components = [];
      let nextLabel = 0;
      for (let start = 0; start < sourceMask.length; start += 1) {
        if (!sourceMask[start] || labels[start]) continue;
        nextLabel += 1;
        let head = 0;
        let tail = 0;
        let count = 0;
        queue[tail++] = start;
        labels[start] = nextLabel;
        while (head < tail) {
          const index = queue[head++];
          count += 1;
          const sourceX = index % sourceCanvas.width;
          const sourceY = Math.floor(index / sourceCanvas.width);
          for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
            for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
              if (deltaX === 0 && deltaY === 0) continue;
              const nextX = sourceX + deltaX;
              const nextY = sourceY + deltaY;
              if (nextX < 0 || nextX >= sourceCanvas.width || nextY < 0 || nextY >= sourceCanvas.height) continue;
              const next = nextY * sourceCanvas.width + nextX;
              if (sourceMask[next] && !labels[next]) {
                labels[next] = nextLabel;
                queue[tail++] = next;
              }
            }
          }
        }
        components.push({ label: nextLabel, count });
      }

      const componentRanks = new Map(components
        .sort((leftComponent, rightComponent) => rightComponent.count - leftComponent.count)
        .slice(0, 4)
        .map((component, index) => [component.label, index + 1]));
      if (componentRanks.size !== 4) throw new Error("Approved mark must expose four optical components");

      const outputLabels = new Uint8Array(canvas.width * canvas.height);
      const outputStrength = new Float32Array(outputLabels.length);
      for (let outputY = 0; outputY < canvas.height; outputY += 1) {
        for (let outputX = 0; outputX < canvas.width; outputX += 1) {
          const sourceLeft = Math.max(0, Math.floor(((outputX - x) / drawSize) * sourceCanvas.width));
          const sourceRight = Math.min(sourceCanvas.width, Math.ceil((((outputX + 1) - x) / drawSize) * sourceCanvas.width));
          const sourceTop = Math.max(0, Math.floor(((outputY - y) / drawSize) * sourceCanvas.height));
          const sourceBottom = Math.min(sourceCanvas.height, Math.ceil((((outputY + 1) - y) / drawSize) * sourceCanvas.height));
          if (sourceLeft >= sourceRight || sourceTop >= sourceBottom) continue;
          const counts = [0, 0, 0, 0, 0];
          for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
            for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
              const rank = componentRanks.get(labels[sourceY * sourceCanvas.width + sourceX]);
              if (rank) counts[rank] += 1;
            }
          }
          let strongestRank = 1;
          for (let rank = 2; rank <= 4; rank += 1) {
            if (counts[rank] > counts[strongestRank]) strongestRank = rank;
          }
          const sampleCount = (sourceRight - sourceLeft) * (sourceBottom - sourceTop);
          const strength = counts[strongestRank] / sampleCount;
          if (strength >= 0.08) {
            const outputIndex = outputY * canvas.width + outputX;
            outputLabels[outputIndex] = strongestRank;
            outputStrength[outputIndex] = strength;
          }
        }
      }

      let conflictFound = true;
      while (conflictFound) {
        conflictFound = false;
        for (let outputY = 0; outputY < canvas.height && !conflictFound; outputY += 1) {
          for (let outputX = 0; outputX < canvas.width && !conflictFound; outputX += 1) {
            const current = outputY * canvas.width + outputX;
            if (!outputLabels[current]) continue;
            for (let deltaY = -1; deltaY <= 1 && !conflictFound; deltaY += 1) {
              for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
                if (deltaX === 0 && deltaY === 0) continue;
                const nextX = outputX + deltaX;
                const nextY = outputY + deltaY;
                if (nextX < 0 || nextX >= canvas.width || nextY < 0 || nextY >= canvas.height) continue;
                const next = nextY * canvas.width + nextX;
                if (!outputLabels[next] || outputLabels[next] === outputLabels[current]) continue;
                const erase = outputStrength[current] <= outputStrength[next] ? current : next;
                outputLabels[erase] = 0;
                outputStrength[erase] = 0;
                conflictFound = true;
                break;
              }
            }
          }
        }
      }
      outputMask = outputLabels;
    } else {
      context2d.fillStyle = "#F5F5F2";
      context2d.fillRect(0, 0, canvas.width, canvas.height);
      context2d.imageSmoothingEnabled = true;
      context2d.imageSmoothingQuality = "high";
      context2d.drawImage(image, x, y, drawSize, drawSize);
      const raster = context2d.getImageData(0, 0, canvas.width, canvas.height);
      outputMask = new Uint8Array(canvas.width * canvas.height);
      for (let index = 0; index < outputMask.length; index += 1) {
        const offset = index * 4;
        const luminance = raster.data[offset] * 0.2126 + raster.data[offset + 1] * 0.7152 + raster.data[offset + 2] * 0.0722;
        outputMask[index] = luminance < pixelThreshold ? 1 : 0;
      }
    }

    const outputRaster = context2d.createImageData(canvas.width, canvas.height);
    for (let index = 0; index < outputMask.length; index += 1) {
      const offset = index * 4;
      const color = outputMask[index] ? [11, 11, 12] : [245, 245, 242];
      outputRaster.data[offset] = color[0];
      outputRaster.data[offset + 1] = color[1];
      outputRaster.data[offset + 2] = color[2];
      outputRaster.data[offset + 3] = 255;
    }
    context2d.putImageData(outputRaster, 0, 0);
  }, { drawScale: scale, pixelThreshold: threshold, preserveComponents: separateComponents });
  await page.screenshot({ path: output, animations: "disabled" });
  await context.close();
}

function campaignMarkup(source, { large = false } = {}) {
  const width = large ? 3840 : 1200;
  const height = large ? 2160 : 630;
  const edge = large ? 280 : 70;
  const title = large ? 232 : 76;
  const copy = large ? 58 : 23;
  const mark = large ? 900 : 470;
  const grid = large ? 160 : 48;
  return `<!doctype html><style>
    *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{position:relative;background:
      radial-gradient(circle at 78% 49%,rgba(180,183,188,.16),transparent 25%),
      linear-gradient(124deg,#0B0B0C 0%,#101114 58%,#1A1C20 100%);color:#F5F5F2;
      font-family:Arial,Helvetica,sans-serif}
    body:before{content:"";position:absolute;inset:0;background-image:
      linear-gradient(rgba(245,245,242,.055) 1px,transparent 1px),
      linear-gradient(90deg,rgba(245,245,242,.055) 1px,transparent 1px);
      background-size:${grid}px ${grid}px;mask-image:linear-gradient(90deg,transparent,black 24%,black 84%,transparent)}
    .frame{position:absolute;inset:${large ? 84 : 25}px;border:1px solid rgba(245,245,242,.16);border-radius:${large ? 50 : 18}px}
    .copy{position:absolute;left:${edge}px;top:50%;width:${large ? 1900 : 610}px;transform:translateY(-50%)}
    .signal{width:${large ? 108 : 34}px;height:${large ? 12 : 4}px;background:#FF4A1A;border-radius:999px;margin-bottom:${large ? 74 : 25}px;box-shadow:0 0 ${large ? 60 : 20}px rgba(255,74,26,.42)}
    h1{margin:0;font-size:${title}px;line-height:.94;letter-spacing:-.055em;font-weight:600}
    p{margin:${large ? 62 : 24}px 0 0;color:#B4B7BC;font-size:${copy}px;line-height:1.3;letter-spacing:-.02em}
    .mark{position:absolute;width:${mark}px;height:${mark}px;right:${large ? 330 : 44}px;top:50%;transform:translateY(-50%);object-fit:contain;
      filter:drop-shadow(0 ${large ? 80 : 24}px ${large ? 110 : 40}px rgba(0,0,0,.58))}
    .orbit{position:absolute;width:${large ? 1250 : 560}px;height:${large ? 1250 : 560}px;right:${large ? 155 : 0}px;top:50%;transform:translateY(-50%);border:1px solid rgba(180,183,188,.12);border-radius:50%}
    .orbit:after{content:"";position:absolute;width:${large ? 26 : 8}px;height:${large ? 26 : 8}px;border-radius:50%;background:#FF4A1A;right:8%;top:20%;box-shadow:0 0 ${large ? 56 : 18}px rgba(255,74,26,.62)}
  </style><div class="frame"></div><div class="copy"><div class="signal"></div><h1>See what<br>others miss.</h1><p>Website intelligence, simplified.</p></div><div class="orbit"></div><img class="mark" src="${source}" alt="">`;
}

function createIco(images) {
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = directorySize;
  images.forEach(({ size, buffer }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size;
    header[entry + 1] = size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(buffer.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, ...images.map(({ buffer }) => buffer)]);
}

async function renderContactSheet(browser) {
  const names = [
    "favicon-16.png",
    "favicon-32.png",
    "apple-touch-icon.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "social-preview.png",
    "noqori-brand-4k.png"
  ];
  const sources = Object.fromEntries(await Promise.all(names.map(async (name) => {
    const data = await readFile(join(productionRoot, name));
    return [name, `data:image/png;base64,${data.toString("base64")}`];
  })));
  const html = `<!doctype html><style>
    *{box-sizing:border-box}html,body{margin:0;background:#F5F5F2;color:#0B0B0C;font-family:Arial,sans-serif}
    body{padding:52px}.head{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid #B4B7BC;padding-bottom:20px;margin-bottom:30px}
    h1{margin:0;font-size:34px;letter-spacing:-.04em}.meta{font:13px ui-monospace,monospace;color:#1A1C20}
    .grid{display:grid;grid-template-columns:440px 1fr;gap:24px}.panel{border:1px solid #B4B7BC;border-radius:18px;padding:24px;background:#fff}
    h2{font:13px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;margin:0 0 18px}
    .icons{display:grid;grid-template-columns:1fr 1fr;gap:16px}.sample{display:grid;gap:9px;justify-items:center;font:12px ui-monospace,monospace}
    .pixel{width:192px;height:192px;display:grid;place-items:center;background:#F5F5F2;border:1px solid #B4B7BC;image-rendering:pixelated}
    .pixel img{width:192px;height:192px;image-rendering:pixelated}.safe{position:relative;width:180px;height:180px}.safe img{display:block;width:100%;height:100%;border-radius:24px}
    .safe:after{content:"";position:absolute;inset:14%;border:1px dashed #FF4A1A;border-radius:12px;pointer-events:none}.icon{width:180px}
    .chromeChecks{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:10px}.chrome{height:54px;border:1px solid #B4B7BC;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:12px;font:11px ui-monospace,monospace}
    .chrome img{width:16px;height:16px}.chrome.light{background:#F5F5F2;color:#0B0B0C}.chrome.dark{background:#1A1C20;color:#F5F5F2}
    .maskTitle{margin-top:28px}.masks{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.mask{display:grid;gap:8px;justify-items:center;font:11px ui-monospace,monospace}
    .mask img{width:112px;height:112px;background:#F5F5F2}.mask.circle img{border-radius:50%}.mask.squircle img{border-radius:34%}.mask.rounded img{border-radius:20%}
    .wide{grid-column:2}.wide img{display:block;width:100%;border-radius:12px}.fourk{margin-top:24px}.footer{margin-top:26px;font:12px ui-monospace,monospace;color:#1A1C20}
  </style><div class="head"><h1>NOQORI production assets</h1><div class="meta">STE-25 · visual review</div></div>
  <div class="grid"><div class="panel"><h2>Small-format clarity</h2><div class="icons">
    <div class="sample"><div class="pixel"><img src="${sources["favicon-16.png"]}"></div>16 × 16 / 12×</div>
    <div class="sample"><div class="pixel"><img src="${sources["favicon-32.png"]}"></div>32 × 32 / 6×</div>
    <div class="sample"><div class="safe"><img src="${sources["apple-touch-icon.png"]}"></div>Apple 180 / safe zone</div>
    <div class="sample"><img class="icon" src="${sources["icon-512.png"]}">Icon 512</div>
    <div class="chromeChecks"><div class="chrome light"><img src="${sources["favicon-16.png"]}">Light chrome</div><div class="chrome dark"><img src="${sources["favicon-16.png"]}">Dark chrome</div></div>
  </div><h2 class="maskTitle">Maskable crops</h2><div class="masks">
    <div class="mask circle"><img src="${sources["icon-maskable-512.png"]}">Circle</div>
    <div class="mask squircle"><img src="${sources["icon-maskable-512.png"]}">Squircle</div>
    <div class="mask rounded"><img src="${sources["icon-maskable-512.png"]}">Rounded square</div>
  </div></div><div class="panel wide"><h2>Social preview · 1200 × 630</h2><img src="${sources["social-preview.png"]}">
    <div class="fourk"><h2>4K brand composition · 3840 × 2160</h2><img src="${sources["noqori-brand-4k.png"]}"></div></div></div>
  <div class="footer">Canvas #F5F5F2 · Ink #0B0B0C · Graphite #1A1C20 · Silver #B4B7BC · Ember #FF4A1A</div>`;
  await mkdir(dirname(contactSheetPath), { recursive: true });
  await renderPage(browser, { width: 1600, height: 1510, html, output: contactSheetPath });
}

async function main() {
  await mkdir(productionRoot, { recursive: true });
  const [ink, light, expressive] = await Promise.all([
    readApprovedSource(approvedSources.ink),
    readApprovedSource(approvedSources.light),
    readApprovedSource(approvedSources.expressive)
  ]);
  void light;

  const browser = await chromium.launch({ headless: true });
  try {
    const contactSheetOnly = process.argv.includes("--contact-sheet-only");
    if (!contactSheetOnly) {
      for (const size of [16, 32, 48, 180, 192, 512]) {
        const name = size === 180 ? "apple-touch-icon.png" : size <= 48 ? `favicon-${size}.png` : `icon-${size}.png`;
        const isFavicon = size <= 48;
        await renderIcon(browser, {
          size,
          source: ink,
          scale: isFavicon ? 1.12 : size === 180 ? 1.12 : 1.19,
          threshold: isFavicon ? 25 : 160,
          separateComponents: isFavicon,
          output: join(productionRoot, name)
        });
      }
      await renderIcon(browser, {
        size: 512,
        source: ink,
        scale: 0.94,
        threshold: 160,
        output: join(productionRoot, "icon-maskable-512.png")
      });
    }
    if (!contactSheetOnly && !process.argv.includes("--small-only")) {
      await renderPage(browser, {
        width: 1200,
        height: 630,
        html: campaignMarkup(expressive),
        output: join(productionRoot, "social-preview.png")
      });
      await renderPage(browser, {
        width: 1200,
        height: 630,
        deviceScaleFactor: 2,
        html: campaignMarkup(expressive),
        output: join(productionRoot, "social-preview@2x.png")
      });
      await renderPage(browser, {
        width: 3840,
        height: 2160,
        html: campaignMarkup(expressive, { large: true }),
        output: join(productionRoot, "noqori-brand-4k.png")
      });
    }

    if (!contactSheetOnly) {
      const icoImages = await Promise.all([16, 32, 48].map(async (size) => ({
        size,
        buffer: await readFile(join(productionRoot, `favicon-${size}.png`))
      })));
      await writeFile(join(productionRoot, "favicon.ico"), createIco(icoImages));
    }

    if (process.argv.includes("--contact-sheet")) {
      await renderContactSheet(browser);
    }
  } finally {
    await browser.close();
  }
}

await main();
