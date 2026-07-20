// Excalidraw element tool definitions.

export interface CanvasClient {
  get(path: string): Promise<string>;
  post(path: string, body?: unknown): Promise<string>;
  put(path: string, body: unknown): Promise<string>;
  del(path: string): Promise<string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
  handler: (params: Record<string, unknown>, api: CanvasClient) => Promise<string>;
}

export function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

export const ELEMENT_TOOLS: ToolSpec[] = [
  // ── Element CRUD (7) ──────────────────────────────────────────────
  {
    name: "create_element",
    description:
      "Create a new Excalidraw element (rectangle, ellipse, diamond, arrow, text, line, freedraw). For arrows use startElementId/endElementId to bind to shapes.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Element type: rectangle, ellipse, diamond, arrow, text, line, freedraw",
        },
        x: { type: "number", description: "X position" },
        y: { type: "number", description: "Y position" },
        id: {
          type: "string",
          description: "Custom element ID (optional, auto-generated if omitted)",
        },
        width: { type: "number", description: "Width" },
        height: { type: "number", description: "Height" },
        backgroundColor: { type: "string", description: "Fill color" },
        strokeColor: { type: "string", description: "Stroke color" },
        strokeWidth: { type: "number", description: "Stroke width" },
        strokeStyle: { type: "string", description: "Stroke style: solid, dashed, dotted" },
        roughness: { type: "number", description: "Roughness (0=smooth, 1=artist, 2=cartoonist)" },
        opacity: { type: "number", description: "Opacity 0-100" },
        text: { type: "string", description: "Text content (for text elements or labels)" },
        fontSize: { type: "number", description: "Font size" },
        fontFamily: {
          type: "string",
          description:
            "Font: virgil (1), helvetica (2), cascadia (3), excalifont (5), nunito (6), lilita (7), comic (8)",
        },
        startElementId: { type: "string", description: "Arrow start binding element ID" },
        endElementId: { type: "string", description: "Arrow end binding element ID" },
        startArrowhead: {
          type: "string",
          description: "Arrowhead at start: arrow, bar, dot, triangle, or null",
        },
        endArrowhead: {
          type: "string",
          description: "Arrowhead at end: arrow, bar, dot, triangle, or null",
        },
      },
      required: ["type", "x", "y"],
      additionalProperties: true,
    },
    handler: (p, api) => api.post("/api/elements", stripUndefined(p)),
  },
  {
    name: "get_element",
    description: "Get a single Excalidraw element by ID.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Element ID" } },
      required: ["id"],
    },
    handler: (p, api) => api.get(`/api/elements/${String(p.id)}`),
  },
  {
    name: "update_element",
    description: "Update an existing Excalidraw element. Only supplied fields are changed.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Element ID" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        backgroundColor: { type: "string" },
        strokeColor: { type: "string" },
        strokeWidth: { type: "number" },
        strokeStyle: { type: "string" },
        roughness: { type: "number" },
        opacity: { type: "number" },
        text: { type: "string" },
        fontSize: { type: "number" },
        fontFamily: { type: "string" },
      },
      required: ["id"],
      additionalProperties: true,
    },
    handler: (p, api) => {
      const { id, ...rest } = p;
      return api.put(`/api/elements/${String(id)}`, stripUndefined(rest));
    },
  },
  {
    name: "delete_element",
    description: "Delete an Excalidraw element by ID.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Element ID" } },
      required: ["id"],
    },
    handler: (p, api) => api.del(`/api/elements/${String(p.id)}`),
  },
  {
    name: "query_elements",
    description: "Query/list all Excalidraw elements. Optionally filter by type.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by element type" },
      },
      additionalProperties: true,
    },
    handler: (p, api) => {
      const qs = p.type ? `?type=${encodeURIComponent(p.type as string)}` : "";
      return api.get(`/api/elements/search${qs}`);
    },
  },
  {
    name: "batch_create_elements",
    description:
      "Create multiple Excalidraw elements at once. For arrows use startElementId/endElementId to bind to shapes. Assign custom id to shapes so arrows can reference them.",
    parameters: {
      type: "object",
      properties: {
        elements: {
          type: "array",
          description: "Array of element objects (each needs type, x, y at minimum)",
        },
      },
      required: ["elements"],
    },
    handler: (p, api) => api.post("/api/elements/batch", { elements: p.elements }),
  },
  {
    name: "duplicate_elements",
    description: "Duplicate elements with a configurable offset.",
    parameters: {
      type: "object",
      properties: {
        elementIds: { type: "array", description: "IDs of elements to duplicate" },
        offsetX: { type: "number", description: "Horizontal offset (default: 20)" },
        offsetY: { type: "number", description: "Vertical offset (default: 20)" },
      },
      required: ["elementIds"],
    },
    handler: async (p, api) => {
      // Fetch each element, clone with offset, batch create
      const ids = p.elementIds as string[];
      const offsetX = (p.offsetX as number) || 20;
      const offsetY = (p.offsetY as number) || 20;
      const clones: Record<string, unknown>[] = [];

      for (const id of ids) {
        const raw = await api.get(`/api/elements/${id}`);
        try {
          const parsed = JSON.parse(raw);
          if (parsed.success && parsed.element) {
            const el = parsed.element;
            const { id: _id, createdAt: _c, updatedAt: _u, version: _v, ...rest } = el;
            clones.push({ ...rest, x: (rest.x || 0) + offsetX, y: (rest.y || 0) + offsetY });
          }
        } catch {
          /* skip */
        }
      }

      if (clones.length === 0) {
        return JSON.stringify({ success: false, error: "No elements found to duplicate" });
      }
      return api.post("/api/elements/batch", { elements: clones });
    },
  },
];
