import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const productionRoot = join(root, "assets", "noqori", "production");

const expectedPngs = new Map([
  ["favicon-16.png", [16, 16]],
  ["favicon-32.png", [32, 32]],
  ["favicon-48.png", [48, 48]],
  ["apple-touch-icon.png", [180, 180]],
  ["icon-192.png", [192, 192]],
  ["icon-512.png", [512, 512]],
  ["icon-maskable-512.png", [512, 512]],
  ["social-preview.png", [1200, 630]],
  ["social-preview@2x.png", [2400, 1260]],
  ["noqori-brand-4k.png", [3840, 2160]]
]);

const sourceHashes = new Map([
  ["noqori-mark-ink.png", "ee8548669cdfb47954f13d0ad43da10fce35753dc2aa6a7644f657ca33640e8b"],
  ["noqori-mark-light.png", "8ed2d1ba0b6ba191f066c1bc54c145aa478be673c47afa9edf41bbf5de0f6978"],
  ["noqori-expressive-prototype.png", "148c0ff229739159fd76200222663441ab8735eeb83c69559d311b3258a38742"]
]);

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function pngTextMetadata(buffer) {
  const textChunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (["tEXt", "iTXt", "zTXt"].includes(type)) {
      textChunks.push(buffer.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return textChunks.join("\n");
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgbPng(buffer) {
  const [width, height] = pngDimensions(buffer);
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IHDR") {
      assert.equal(buffer[offset + 16], 8, "PNG must use 8-bit channels");
      assert.equal(buffer[offset + 17], 2, "PNG must use RGB color");
      assert.equal(buffer[offset + 20], 0, "PNG must be non-interlaced");
    }
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }

  const bytesPerPixel = 3;
  const rowLength = width * bytesPerPixel;
  const compressed = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = compressed[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const encoded = compressed[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[rowOffset + x - rowLength] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[rowOffset + x - rowLength - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : filter === 4 ? paeth(left, above, upperLeft)
                : assert.fail(`Unsupported PNG filter ${filter}`);
      pixels[rowOffset + x] = (encoded + predictor) & 0xff;
    }
    sourceOffset += rowLength;
  }
  return { width, height, pixels };
}

function darkPixelMap(image) {
  const dark = new Uint8Array(image.width * image.height);
  for (let index = 0; index < dark.length; index += 1) {
    const offset = index * 3;
    dark[index] = image.pixels[offset] < 64 && image.pixels[offset + 1] < 64 && image.pixels[offset + 2] < 64 ? 1 : 0;
  }
  return dark;
}

function darkBoundingBox(image) {
  const dark = darkPixelMap(image);
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  dark.forEach((value, index) => {
    if (!value) return;
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  });
  assert.ok(right >= left && bottom >= top, "image must contain the ink mark");
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

function darkComponents(image) {
  const dark = darkPixelMap(image);
  const visited = new Uint8Array(dark.length);
  let components = 0;
  for (let start = 0; start < dark.length; start += 1) {
    if (!dark[start] || visited[start]) continue;
    components += 1;
    const queue = [start];
    visited[start] = 1;
    while (queue.length) {
      const index = queue.pop();
      const x = index % image.width;
      const y = Math.floor(index / image.width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= image.width || nextY < 0 || nextY >= image.height) continue;
          const next = nextY * image.width + nextX;
          if (dark[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
  }
  return components;
}

function assertHeadAssets(html) {
  assert.match(html, /<link rel="icon" type="image\/png" sizes="16x16" href="\/assets\/noqori\/production\/favicon-16\.png" \/>/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="\/assets\/noqori\/production\/favicon-32\.png" \/>/);
  assert.match(html, /<link rel="icon" href="\/assets\/noqori\/production\/favicon\.ico" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/assets\/noqori\/production\/apple-touch-icon\.png" \/>/);
  assert.match(html, /<link rel="manifest" href="\/assets\/noqori\/production\/manifest\.json" \/>/);
  assert.match(html, /<meta name="theme-color" content="#F5F5F2" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(html, /<meta name="theme-color" content="#0B0B0C" media="\(prefers-color-scheme: dark\)" \/>/);
}

describe("NOQORI production assets", () => {
  let server;
  let baseUrl;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "noqori-production-assets-"));
    const config = loadConfig({
      PORT: 0,
      NODE_ENV: "test",
      DATABASE_FILE_PATH: join(dir, "sitepulse.sqlite")
    });
    server = createApp(config);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("ships every required PNG at its exact production dimensions", async () => {
    for (const [name, dimensions] of expectedPngs) {
      const file = await readFile(join(productionRoot, name));
      assert.deepEqual(pngDimensions(file), dimensions, name);
      assert.ok((await stat(join(productionRoot, name))).size > 0, name);
    }
  });

  it("ships a valid multi-size ICO", async () => {
    const ico = await readFile(join(productionRoot, "favicon.ico"));
    assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 3, 0]);
    assert.deepEqual([ico[6], ico[7], ico[22], ico[23], ico[38], ico[39]], [16, 16, 32, 32, 48, 48]);
  });

  it("keeps touch and app marks inside their specified optical padding", async () => {
    const cases = [
      ["apple-touch-icon.png", 0.68, 0.72],
      ["icon-192.png", 0.72, 0.76],
      ["icon-512.png", 0.72, 0.76]
    ];
    for (const [name, minimum, maximum] of cases) {
      const image = decodeRgbPng(await readFile(join(productionRoot, name)));
      const box = darkBoundingBox(image);
      const occupancy = Math.max(box.width / image.width, box.height / image.height);
      assert.ok(box.left > 0 && box.top > 0 && box.right < image.width - 1 && box.bottom < image.height - 1, `${name} touches the canvas edge`);
      assert.ok(occupancy >= minimum && occupancy <= maximum, `${name} occupancy ${occupancy.toFixed(4)} outside ${minimum}-${maximum}`);
    }
  });

  it("keeps every important maskable pixel inside the central safe circle", async () => {
    const image = decodeRgbPng(await readFile(join(productionRoot, "icon-maskable-512.png")));
    const dark = darkPixelMap(image);
    const center = (image.width - 1) / 2;
    const safeRadius = image.width * 0.4;
    dark.forEach((value, index) => {
      if (!value) return;
      const x = index % image.width;
      const y = Math.floor(index / image.width);
      assert.ok(Math.hypot(x - center, y - center) <= safeRadius, `maskable dark pixel (${x}, ${y}) is outside the safe circle`);
    });
  });

  it("uses a crisp four-part optical adaptation for every favicon", async () => {
    for (const size of [16, 32, 48]) {
      const name = `favicon-${size}.png`;
      const image = decodeRgbPng(await readFile(join(productionRoot, name)));
      const box = darkBoundingBox(image);
      assert.ok(box.left >= 1 && box.top >= 1 && box.right <= size - 2 && box.bottom <= size - 2, `${name} lacks edge padding`);
      assert.equal(darkComponents(image), 4, `${name} must preserve four separated petals`);

      const permitted = new Set(["11,11,12", "245,245,242"]);
      for (let index = 0; index < image.pixels.length; index += 3) {
        const color = `${image.pixels[index]},${image.pixels[index + 1]},${image.pixels[index + 2]}`;
        assert.ok(permitted.has(color), `${name} contains a soft edge color ${color}`);
      }
    }
  });

  it("declares installable any and maskable icons in the manifest", async () => {
    const manifest = JSON.parse(await readFile(join(productionRoot, "manifest.json"), "utf8"));
    assert.deepEqual(
      {
        name: manifest.name,
        shortName: manifest.short_name,
        theme: manifest.theme_color,
        background: manifest.background_color,
        display: manifest.display
      },
      {
        name: "NOQORI",
        shortName: "NOQORI",
        theme: "#F5F5F2",
        background: "#F5F5F2",
        display: "standalone"
      }
    );
    assert.deepEqual(
      manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
      [
        { src: "/assets/noqori/production/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/assets/noqori/production/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/assets/noqori/production/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
      ]
    );
  });

  it("connects production icons and theme metadata from every HTML head", async () => {
    for (const name of ["index.html", "privacy.html", "impressum.html", "terms.html"]) {
      assertHeadAssets(await readFile(join(root, name), "utf8"));
    }
  });

  it("publishes only root-relative Open Graph and Twitter preview metadata", async () => {
    const html = await readFile(join(root, "index.html"), "utf8");
    assert.match(html, /<meta name="description" content="Website intelligence, simplified\." \/>/);
    assert.match(html, /<meta property="og:type" content="website" \/>/);
    assert.match(html, /<meta property="og:title" content="See what others miss\." \/>/);
    assert.match(html, /<meta property="og:description" content="Website intelligence, simplified\." \/>/);
    assert.match(html, /<meta property="og:image" content="\/assets\/noqori\/production\/social-preview\.png" \/>/);
    assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
    assert.match(html, /<meta property="og:image:height" content="630" \/>/);
    assert.match(html, /<meta property="og:image:alt" content="NOQORI — See what others miss\." \/>/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
    assert.match(html, /<meta name="twitter:title" content="See what others miss\." \/>/);
    assert.match(html, /<meta name="twitter:description" content="Website intelligence, simplified\." \/>/);
    assert.match(html, /<meta name="twitter:image" content="\/assets\/noqori\/production\/social-preview\.png" \/>/);
    assert.doesNotMatch(html, /rel="canonical"|property="og:url"/);
  });

  it("keeps production asset metadata free of internal and legacy labels", async () => {
    const prohibited = /SitePulse|\bbeta\b|placeholder|internal|QA/iu;
    for (const name of expectedPngs.keys()) {
      const png = await readFile(join(productionRoot, name));
      assert.doesNotMatch(pngTextMetadata(png), prohibited, name);
    }
    const manifest = await readFile(join(productionRoot, "manifest.json"), "utf8");
    assert.doesNotMatch(manifest, prohibited, "manifest.json");
  });

  it("serves production raster and manifest files with exact MIME types", async () => {
    const cases = [
      ["favicon-16.png", "image/png"],
      ["favicon.ico", "image/x-icon"],
      ["social-preview.png", "image/png"],
      ["manifest.json", "application/json; charset=utf-8"]
    ];
    for (const [name, contentType] of cases) {
      const response = await fetch(`${baseUrl}/assets/noqori/production/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), contentType, name);
    }
  });

  it("does not modify the three approved source marks", async () => {
    for (const [name, expectedHash] of sourceHashes) {
      const source = await readFile(join(root, "assets", "noqori", name));
      assert.equal(createHash("sha256").update(source).digest("hex"), expectedHash, name);
    }
  });
});
