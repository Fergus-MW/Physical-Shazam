// Live system diagram. Pure SVG; time is passed in so the same code renders
// the dashboard (driven by real app state) and the deterministic README loop.
const NS = "http://www.w3.org/2000/svg";

export const NODES = {
  mic: { title: "Microphone", icon: "mic" },
  window: { title: "Audio windows", icon: "wave" },
  encoder: { title: "Audio encoder", icon: "chip" },
  library: { title: "Sound library", icon: "grid" },
  gemini: { title: "Gemini teacher", icon: "cloud", accent: "lavender" },
  match: { title: "Cue match", icon: "sliders" },
  event: { title: "Detection", icon: "bell" },
  journal: { title: "Event journal", icon: "clock" },
  ros: { title: "ROS 2 bridge", icon: "link" },
};

export const EDGES = [
  ["mic", "window"],
  ["window", "encoder"],
  ["encoder", "match"],
  ["library", "match"],
  ["gemini", "library", { optional: true }],
  ["match", "event"],
  ["event", "journal"],
  ["event", "ros"],
];

export const LAYOUTS = {
  landscape: {
    width: 1040,
    height: 250,
    node: [156, 62],
    positions: {
      mic: [80, 170],
      window: [255, 170],
      encoder: [430, 170],
      match: [605, 170],
      library: [605, 45],
      gemini: [430, 45],
      event: [780, 170],
      journal: [960, 105],
      ros: [960, 225],
    },
  },
  portrait: {
    width: 720,
    height: 1280,
    node: [270, 104],
    positions: {
      mic: [230, 150],
      window: [230, 340],
      encoder: [230, 530],
      gemini: [545, 530],
      library: [545, 740],
      match: [230, 740],
      event: [230, 950],
      journal: [170, 1150],
      ros: [550, 1150],
    },
  },
};

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};

function anchors(a, b, [w, h]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  if (Math.abs(dx) * h >= Math.abs(dy) * w) {
    const s = Math.sign(dx);
    return [[a[0] + (s * w) / 2, a[1]], [b[0] - (s * w) / 2, b[1]], "h"];
  }
  const s = Math.sign(dy);
  return [[a[0], a[1] + (s * h) / 2], [b[0], b[1] - (s * h) / 2], "v"];
}

function edgePath(a, b, size) {
  const [p, q, axis] = anchors(a, b, size);
  if (axis === "h") {
    const mx = (p[0] + q[0]) / 2;
    return `M${p[0]},${p[1]} C${mx},${p[1]} ${mx},${q[1]} ${q[0]},${q[1]}`;
  }
  const my = (p[1] + q[1]) / 2;
  return `M${p[0]},${p[1]} C${p[0]},${my} ${q[0]},${my} ${q[0]},${q[1]}`;
}

export class SystemDiagram {
  constructor(svg, { layout = "landscape", scale = 1 } = {}) {
    this.svg = svg;
    this.layout = LAYOUTS[layout];
    this.scale = scale;
    this.nodes = {};
    this.edges = {};
    this.packets = [];
    this.reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.build();
  }

  build() {
    const { width, height, node: size, positions } = this.layout;
    const svg = this.svg;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.classList.add("system-diagram");
    svg.replaceChildren();
    const edgeLayer = el("g", { class: "sd-edges" }, svg);
    for (const [from, to, opts = {}] of EDGES) {
      const d = edgePath(positions[from], positions[to], size);
      const group = el("g", { class: `sd-edge${opts.optional ? " optional" : ""}` }, edgeLayer);
      const base = el("path", { d, class: "sd-edge-base" }, group);
      el("path", { d, class: "sd-edge-flow" }, group);
      this.edges[`${from}>${to}`] = { group, path: base, length: 0, active: false };
    }
    this.packetLayer = el("g", { class: "sd-packets" }, svg);
    const nodeLayer = el("g", { class: "sd-nodes" }, svg);
    const [w, h] = size,
      k = this.scale;
    for (const [id, spec] of Object.entries(NODES)) {
      const [x, y] = positions[id];
      const g = el(
        "g",
        {
          class: `sd-node ${spec.accent || ""}`,
          transform: `translate(${x - w / 2},${y - h / 2})`,
          "data-node": id,
          "data-state": "idle",
        },
        nodeLayer,
      );
      el("rect", { class: "sd-glow", x: -6, y: -6, width: w + 12, height: h + 12, rx: 16 * k }, g);
      el("rect", { class: "sd-box", width: w, height: h, rx: 11 * k }, g);
      const iconSize = 15 * k,
        pad = 11 * k;
      el("rect", { class: "sd-icon-bg", x: pad, y: h / 2 - iconSize, width: iconSize * 2, height: iconSize * 2, rx: 8 * k }, g);
      const use = el("use", { href: `#i-${spec.icon}`, x: pad + iconSize / 2, y: h / 2 - iconSize / 2, width: iconSize, height: iconSize, class: "sd-icon" }, g);
      use.setAttribute("href", `#i-${spec.icon}`);
      const tx = pad + iconSize * 2 + 9 * k;
      const title = el("text", { class: "sd-title", x: tx, y: h / 2 - 3 * k, "font-size": 13 * k }, g);
      title.textContent = spec.title;
      const value = el("text", { class: "sd-value", x: tx, y: h / 2 + 15 * k, "font-size": 10.5 * k }, g);
      el("circle", { class: "sd-dot", cx: w - 13 * k, cy: 13 * k, r: 3.6 * k }, g);
      const label = el("title", {}, g);
      this.nodes[id] = { g, title, value, label, flash: -1e9, state: "idle" };
    }
    for (const edge of Object.values(this.edges)) edge.length = edge.path.getTotalLength();
  }

  set(id, state, value = "") {
    const node = this.nodes[id];
    if (!node) return;
    if (node.state !== state) {
      node.state = state;
      node.g.dataset.state = state;
    }
    const text = value.length > 17 ? `${value.slice(0, 16)}…` : value;
    if (node.value.textContent !== text) node.value.textContent = text;
    node.label.textContent = `${NODES[id].title}: ${value || state}`;
  }

  flow(from, to, on) {
    const edge = this.edges[`${from}>${to}`];
    if (edge && edge.active !== on) {
      edge.active = on;
      edge.group.classList.toggle("live", on);
    }
  }

  flash(id, now) {
    if (this.nodes[id]) this.nodes[id].flash = now;
  }

  // Sends a packet along consecutive edges, e.g. ["mic", "window", "encoder"].
  send(route, now, { duration = 420, kind = "" } = {}) {
    if (this.reduced) {
      this.flash(route[route.length - 1], now);
      return;
    }
    if (this.packets.length > 40) return;
    const dot = el("circle", { r: 4.2 * this.scale, class: `sd-packet ${kind}` }, this.packetLayer);
    this.packets.push({ route, start: now, duration, dot });
  }

  frame(now) {
    this.packets = this.packets.filter((packet) => {
      const t = (now - packet.start) / packet.duration;
      const hop = Math.floor(t);
      if (t < 0) {
        packet.dot.setAttribute("opacity", 0);
        return true;
      }
      if (hop >= packet.route.length - 1) {
        this.flash(packet.route[packet.route.length - 1], packet.start + (packet.route.length - 1) * packet.duration);
        packet.dot.remove();
        return false;
      }
      const edge = this.edges[`${packet.route[hop]}>${packet.route[hop + 1]}`];
      if (!edge) {
        packet.dot.remove();
        return false;
      }
      if (hop > 0 && !packet.flashed?.[hop]) {
        (packet.flashed ||= {})[hop] = true;
        this.flash(packet.route[hop], now);
      }
      const f = t - hop,
        ease = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      const p = edge.path.getPointAtLength(ease * edge.length);
      packet.dot.setAttribute("cx", p.x.toFixed(1));
      packet.dot.setAttribute("cy", p.y.toFixed(1));
      packet.dot.setAttribute("opacity", 1);
      return true;
    });
    for (const node of Object.values(this.nodes)) {
      const glow = Math.max(0, 1 - (now - node.flash) / 650);
      const value = glow > 0.01 ? glow.toFixed(2) : "0";
      if (node.glow !== value) {
        node.glow = value;
        node.g.style.setProperty("--flash", value);
      }
    }
    const offset = (-(now / 40) % 24).toFixed(1);
    if (offset !== this.offset) {
      this.offset = offset;
      this.svg.style.setProperty("--flow-offset", offset);
    }
  }
}
