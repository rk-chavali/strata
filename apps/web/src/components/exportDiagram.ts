import type { GraphView, MemberView, NodeView } from "../types";

/**
 * The diagram as a picture you can take away.
 *
 * There was no way at all to get the ERD out of the tool, which matters more than it sounds:
 * a diagram's job is mostly to be shown to someone who is not looking at the modelling tool, * in a slide, a wiki page, a pull request. A model nobody can show is a model nobody agrees to.
 *
 * Drawn from the **graph**, not scraped from the live DOM. Serialising React Flow's rendered
 * nodes would inherit the viewport, the selection highlight, the CSS variables of whichever
 * theme happened to be active, and any box scrolled out of view. Re-drawing from the same data
 * the canvas reads gives a complete diagram at a known size, and it works when the canvas is
 * not even mounted.
 */

/** Colours are literals, not tokens: an exported file has no stylesheet to resolve them. */
const THEME = {
  paper: "#ffffff",
  line: "#c8d0da",
  head: "#eef2f7",
  headText: "#1a2029",
  text: "#38414d",
  type: "#7a8798",
  key: "#2f6feb",
  edge: "#8b97a6",
};

const NODE_WIDTH = 232;
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 19;
const PADDING = 40;
const FONT = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO = "11px ui-monospace, 'Cascadia Mono', Consolas, monospace";

export interface ExportOptions {
  /** Include column rows, or draw title-only boxes. */
  detail?: "names" | "keys" | "fields";
  /** Include the type beside each field. */
  types?: boolean;
  /** Title drawn top-left. Usually the model or diagram name. */
  title?: string;
}

/**
 * Render the diagram to a standalone SVG string.
 *
 * SVG rather than only PNG because it stays sharp at any size and its text is selectable and
 * searchable, a reviewer can find a column name with ctrl-F, which is impossible in a bitmap.
 */
export function diagramToSvg(graph: GraphView, options: ExportOptions = {}): string {
  const detail = options.detail ?? "fields";
  const boxes = graph.nodes.map((node) => ({
    node,
    fields: visibleFields(node, detail),
  }));

  const sized = boxes.map(({ node, fields }) => ({
    node,
    fields,
    x: node.x,
    y: node.y,
    width: node.userSized ? node.width : NODE_WIDTH,
    height: HEADER_HEIGHT + fields.length * ROW_HEIGHT + (fields.length ? 6 : 0),
  }));

  /*
    Bounds from the content, then shifted to the origin.

    A diagram's stored coordinates can be negative, dragging a box up and left is ordinary, and an SVG with negative coordinates simply clips them away. Translating by the minimum is
    what makes the export contain every box rather than only the ones in the positive quadrant.
  */
  const minX = Math.min(...sized.map((box) => box.x), 0);
  const minY = Math.min(...sized.map((box) => box.y), 0);
  const maxX = Math.max(...sized.map((box) => box.x + box.width), 0);
  const maxY = Math.max(...sized.map((box) => box.y + box.height), 0);

  const offsetX = PADDING - minX;
  const offsetY = PADDING - minY + (options.title ? 28 : 0);
  const width = Math.max(maxX - minX + PADDING * 2, 320);
  const height = Math.max(maxY - minY + PADDING * 2 + (options.title ? 28 : 0), 200);

  const byId = new Map(sized.map((box) => [box.node.id, box]));
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${THEME.paper}"/>`,
  );

  if (options.title) {
    parts.push(
      `<text x="${PADDING}" y="${PADDING - 6}" font="${FONT}" font-size="16" font-weight="600" fill="${THEME.headText}">${esc(options.title)}</text>`,
    );
  }

  // Edges first, so boxes paint over the line ends rather than the reverse.
  for (const edge of graph.edges) {
    const from = byId.get(edge.sourceId);
    const to = byId.get(edge.targetId);
    if (!from || !to) continue;

    const x1 = from.x + offsetX + from.width / 2;
    const y1 = from.y + offsetY + from.height / 2;
    const x2 = to.x + offsetX + to.width / 2;
    const y2 = to.y + offsetY + to.height / 2;

    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${THEME.edge}" stroke-width="1.25"${
        // A non-identifying relationship is drawn dashed, matching the canvas.
        edge.identifying ? "" : ' stroke-dasharray="5 3"'
      }/>`,
    );
  }

  for (const box of sized) {
    const x = box.x + offsetX;
    const y = box.y + offsetY;

    parts.push(`<g>`);
    parts.push(
      `<rect x="${x}" y="${y}" width="${box.width}" height="${box.height}" rx="5" fill="${THEME.paper}" stroke="${THEME.line}"/>`,
      `<path d="M${x} ${y + HEADER_HEIGHT} h${box.width}" stroke="${THEME.line}"/>`,
      `<path d="M${x + 5} ${y} h${box.width - 10} a5 5 0 0 1 5 5 v${HEADER_HEIGHT - 5} h-${box.width} v-${HEADER_HEIGHT - 5} a5 5 0 0 1 5 -5 z" fill="${THEME.head}"/>`,
      `<text x="${x + 10}" y="${y + 19}" font="${FONT}" font-weight="600" fill="${THEME.headText}">${esc(truncate(box.node.name, box.width - 20))}</text>`,
    );

    box.fields.forEach((field, index) => {
      const rowY = y + HEADER_HEIGHT + 14 + index * ROW_HEIGHT;
      const isKey = field.isPrimaryKey || field.isForeignKey;

      parts.push(
        `<text x="${x + 10}" y="${rowY}" font="${FONT}" font-size="12" fill="${isKey ? THEME.key : THEME.text}"${
          field.isPrimaryKey ? ' font-weight="600"' : ""
        }>${esc(keyMark(field))}${esc(truncate(field.name, box.width - (options.types ? 110 : 30)))}</text>`,
      );

      if (options.types && field.type) {
        parts.push(
          `<text x="${x + box.width - 10}" y="${rowY}" font="${MONO}" fill="${THEME.type}" text-anchor="end">${esc(truncate(field.type, 90))}</text>`,
        );
      }
    });

    parts.push(`</g>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

/**
 * Rasterise the SVG in the browser.
 *
 * Via a data URL into an `Image` and a canvas, at 2× by default: a 1× PNG of a diagram is
 * unreadable the moment anyone puts it in a slide and scales it up.
 */
export async function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const sizes = /width="(\d+)" height="(\d+)"/.exec(svg);
  const width = Number(sizes?.[1] ?? 1200);
  const height = Number(sizes?.[2] ?? 800);

  /*
    A data URL rather than a blob URL.

    Canvas treats an SVG loaded from a blob URL as tainting in some browsers, and `toBlob`
    then throws a security error, which is a confusing failure for something that looks like
    it worked. `encodeURIComponent` keeps it same-origin by construction.
  */
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("could not rasterise the diagram"));
    element.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const context = canvas.getContext("2d");
  if (!context) throw new Error("this browser has no 2D canvas context");
  context.scale(scale, scale);
  context.drawImage(image, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("could not encode the PNG"));
    }, "image/png");
  });
}

/** Trigger a download of a string or blob, without leaking the object URL. */
export function download(filename: string, data: string | Blob, mime = "text/plain"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  // Revoked on the next tick rather than immediately: revoking synchronously can race the
  // browser's own fetch of the URL and produce an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function visibleFields(node: NodeView, detail: ExportOptions["detail"]): MemberView[] {
  if (detail === "names") return [];
  if (detail === "keys") return node.members.filter((member) => member.isPrimaryKey || member.isForeignKey);
  // Only top-level fields: nested STRUCT children make boxes unreadably tall in a static
  // picture, and the dictionary export is where the full shape belongs.
  return node.members.filter((member) => member.depth === 0);
}

function keyMark(field: MemberView): string {
  if (field.isPrimaryKey) return "PK  ";
  if (field.isForeignKey) return "FK  ";
  return "";
}

/** Rough character budget from a pixel width, SVG cannot measure text before layout. */
function truncate(text: string, pixels: number): string {
  const max = Math.max(4, Math.floor(pixels / 6.6));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
