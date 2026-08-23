// Generate an animated terminal-style SVG from a REAL captured run of
// scripts/demo-delegate.mjs. No synthetic output is invented: the SVG simply
// replays the ANSI transcript produced by the actual delegation runtime.
//
// Usage:
//   node plugins/opencode/scripts/demo-delegate.mjs > /tmp/oc-capture.log
//   node plugins/opencode/scripts/make-demo-svg.mjs /tmp/oc-capture.log docs/demo.svg

import fs from "node:fs";

const [, , inputPath = "/tmp/oc-capture.log", outputPath = "docs/demo.svg"] = process.argv;

const PALETTE = {
  bg: "#1b1c24",
  bar: "#262833",
  fg: "#e2e2dc",
  dim: "#6f7286",
  green: "#4ae168",
  yellow: "#f1fa8c",
  cyan: "#8be9fd",
  red: "#ff5555",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Convert a raw ANSI line into { text, spans:[{text,class}] } */
function parseAnsi(line) {
  const spans = [];
  let cls = "fg";
  let buf = "";
  const flush = () => {
    if (buf) spans.push({ cls, text: buf });
    buf = "";
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    buf += line.slice(last, m.index);
    flush();
    const codes = m[1].split(";").map(Number);
    for (const c of codes) {
      if (c === 0) cls = "fg";
      else if (c === 1) cls += " b";
      else if (c === 2) cls = "dim";
      else if (c === 30 || c === 39) cls = "fg";
      else if (c === 32 || c === 92) cls = "green";
      else if (c === 33 || c === 93) cls = "yellow";
      else if (c === 36 || c === 96) cls = "cyan";
      else if (c === 31 || c === 91) cls = "red";
    }
    last = re.lastIndex;
  }
  buf += line.slice(last);
  flush();
  return spans;
}

const raw = fs.readFileSync(inputPath, "utf8");
const lines = raw
  .split("\n")
  .map((l) => l.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")) // OSC strips
  .filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
if (!lines.length) {
  console.error("empty capture");
  process.exit(1);
}

const FONT = 13;
const LINE_H = 19.5;
const PAD_X = 26;
const BAR_H = 44;
const MAX_COLS = 104;

// Parse first, THEN truncate by VISIBLE width so an SGR sequence can never be
// cut mid-escape and leak control bytes into the XML.
function clipSpans(spans) {
  let used = 0;
  const out = [];
  for (const s of spans) {
    s.text = s.text.replace(/[\x00-\x1f\x7f]/g, "");
    if (!s.text) continue;
    const remain = MAX_COLS - used;
    if (s.text.length > remain) {
      if (remain > 0) out.push({ cls: s.cls, text: s.text.slice(0, remain) + "…" });
      return out;
    }
    out.push(s);
    used += s.text.length;
  }
  return out;
}

const parsed = lines
  .map((l) => l.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")) // OSC strips
  .map(parseAnsi)
  .map(clipSpans)
  .filter((spans) => spans.length > 0);

if (!parsed.length) {
  console.error("empty capture");
  process.exit(1);
}

const W = 1000;
const H = BAR_H + PAD_X + parsed.length * LINE_H + 34;

let body = "";
parsed.forEach((spans, i) => {
  const y = BAR_H + PAD_X + i * LINE_H;
  const delay = (0.9 + i * 0.5).toFixed(2);
  const tspan = spans.map((s) => `<tspan class="${s.cls}">${esc(s.text)}</tspan>`).join("");
  body += `<text class="ln" style="animation-delay:${delay}s" x="${PAD_X}" y="${y}">${tspan}</text>\n`;
});

// Blinking cursor on the trailing prompt line.
const cursorY = BAR_H + PAD_X + parsed.length * LINE_H;
body += `<rect class="cursor" x="${PAD_X}" y="${cursorY - FONT}" width="8" height="${FONT + 2}" fill="${PALETTE.fg}" opacity="0.85"/>`;

const css = `
  .fg { fill: ${PALETTE.fg}; } .fg.b { fill: ${PALETTE.fg}; font-weight: 700; }
  .dim { fill: ${PALETTE.dim}; } .green { fill: ${PALETTE.green}; }
  .yellow { fill: ${PALETTE.yellow}; } .cyan { fill: ${PALETTE.cyan}; }
  .red { fill: ${PALETTE.red}; }
  .ln { opacity: 0; animation: appear 0.01s linear forwards; }
  @keyframes appear { to { opacity: 1; } }
  .cursor { animation: blink 1.1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  text { font: ${FONT}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H)}" viewBox="0 0 ${W} ${Math.round(H)}" role="img" aria-label="Live run of the opencode plugin delegation runtime">
  <style>${css}</style>
  <rect width="${W}" height="${Math.round(H)}" rx="14" fill="${PALETTE.bg}"/>
  <rect width="${W}" height="${BAR_H}" rx="14" fill="${PALETTE.bar}"/>
  <rect y="${BAR_H - 14}" width="${W}" height="14" fill="${PALETTE.bar}"/>
  <circle cx="22" cy="${BAR_H / 2}" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="${BAR_H / 2}" r="6" fill="#febc2e"/>
  <circle cx="62" cy="${BAR_H / 2}" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" class="dim" style="font-size:12px">zsh — opencode-plugin-cc · live delegation run</text>
  <text class="ln green" style="animation-delay:0.15s" x="${PAD_X}" y="${BAR_H + PAD_X - LINE_H}"><tspan style="fill:${PALETTE.green};font-weight:700">❯</tspan><tspan class="fg"> node plugins/opencode/scripts/demo-delegate.mjs</tspan></text>
  ${body}
</svg>
`;

fs.mkdirSync(outputPath.substring(0, outputPath.lastIndexOf("/")), { recursive: true });
fs.writeFileSync(outputPath, svg);
console.log(`wrote ${outputPath} (${lines.length} lines, ${(svg.length / 1024).toFixed(1)} KB)`);
