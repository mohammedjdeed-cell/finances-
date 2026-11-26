// Turns the app's JSX (src/app.jsx) into plain JavaScript (app.js) so phones don't have to
// translate ~8,000 lines on every start. Run `npm run compile` after editing src/app.jsx.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const Babel = createRequire(import.meta.url)("@babel/standalone");
const src = readFileSync(new URL("./src/app.jsx", import.meta.url), "utf8");
const { code: jsx } = Babel.transform(src, { presets: ["react"], sourceType: "script", compact: true, comments: false });
// Minified: a smaller file starts faster on phones and weak connections.
const { minify } = await import("terser");
const { code } = await minify(jsx, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
writeFileSync(new URL("./app.js", import.meta.url), code);

// Point index.html at this exact build, so browsers and the offline cache pick up new versions.
const hash = createHash("sha256").update(code).digest("hex").slice(0, 10);
const htmlUrl = new URL("./index.html", import.meta.url);
const html = readFileSync(htmlUrl, "utf8").replace(/<script src="app\.js(\?v=[0-9a-f]+)?" defer><\/script>/, `<script src="app.js?v=${hash}" defer></script>`);
writeFileSync(htmlUrl, html);
console.log(`app.js ${Math.round(code.length / 1024)} KB, version ${hash}`);
