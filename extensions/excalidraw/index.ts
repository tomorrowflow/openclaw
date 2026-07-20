// Excalidraw Canvas Plugin — diagramming and whiteboard via REST API
// Calls the Excalidraw canvas server (mcp_excalidraw) HTTP endpoints directly.
// All 26 tools registered synchronously; REST calls made on each invocation.

import {
  ELEMENT_TOOLS,
  stripUndefined,
  type CanvasClient,
  type ToolSpec,
} from "./element-tools.js";

interface PluginApi {
  logger: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
  };
  config: { canvasUrl?: string };
  registerTool: (tool: ToolDefinition) => void;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

// ---------- REST client ----------

function createCanvasClient(baseUrl: string, logger: PluginApi["logger"]): CanvasClient {
  async function request(method: string, path: string, body?: unknown): Promise<string> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    logger.info(`Canvas ${method} ${path}`);

    try {
      const res = await fetch(url, init);
      const text = await res.text();

      if (!res.ok) {
        logger.error(`Canvas error ${res.status}: ${text}`);
        return JSON.stringify({
          success: false,
          error: `HTTP ${res.status}: ${text}`,
          hint: `Check if Excalidraw canvas is running at ${baseUrl}`,
        });
      }

      // Pretty-print JSON responses
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Canvas request failed: ${msg}`);
      return JSON.stringify({
        success: false,
        error: msg,
        hint: `Check if Excalidraw canvas is running at ${baseUrl}`,
      });
    }
  }

  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body),
    put: (path: string, body: unknown) => request("PUT", path, body),
    del: (path: string) => request("DELETE", path),
  };
}

const TOOLS: ToolSpec[] = [
  ...ELEMENT_TOOLS,
  // ── Layout (4) ────────────────────────────────────────────────────
  {
    name: "group_elements",
    description: "Group multiple elements together.",
    parameters: {
      type: "object",
      properties: {
        elementIds: { type: "array", description: "Element IDs to group" },
      },
      required: ["elementIds"],
    },
    handler: async (p, api) => {
      const ids = p.elementIds as string[];
      const groupId = `group_${Date.now().toString(36)}`;
      const results: string[] = [];

      for (const id of ids) {
        const raw = await api.get(`/api/elements/${id}`);
        try {
          const parsed = JSON.parse(raw);
          if (parsed.success && parsed.element) {
            const existing = parsed.element.groupIds || [];
            const res = await api.put(`/api/elements/${id}`, { groupIds: [...existing, groupId] });
            results.push(res);
          }
        } catch {
          /* skip */
        }
      }
      return JSON.stringify({ success: true, groupId, updated: results.length });
    },
  },
  {
    name: "ungroup_elements",
    description: "Ungroup a group of elements by group ID.",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "Group ID to dissolve" },
      },
      required: ["groupId"],
    },
    handler: async (p, api) => {
      const groupId = String(p.groupId);
      const raw = await api.get("/api/elements");
      let updated = 0;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.success && Array.isArray(parsed.elements)) {
          for (const el of parsed.elements) {
            if (Array.isArray(el.groupIds) && el.groupIds.includes(groupId)) {
              await api.put(`/api/elements/${el.id}`, {
                groupIds: el.groupIds.filter((g: string) => g !== groupId),
              });
              updated++;
            }
          }
        }
      } catch {
        /* skip */
      }
      return JSON.stringify({ success: true, groupId, updated });
    },
  },
  {
    name: "align_elements",
    description:
      "Align elements to a specific position (left, center, right, top, middle, bottom).",
    parameters: {
      type: "object",
      properties: {
        elementIds: { type: "array", description: "Element IDs to align" },
        alignment: {
          type: "string",
          description: "Alignment: left, center, right, top, middle, bottom",
        },
      },
      required: ["elementIds", "alignment"],
    },
    handler: async (p, api) => {
      const ids = p.elementIds as string[];
      const alignment = String(p.alignment);
      const elems: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];

      for (const id of ids) {
        const raw = await api.get(`/api/elements/${id}`);
        try {
          const parsed = JSON.parse(raw);
          if (parsed.success && parsed.element) {
            elems.push({
              id: parsed.element.id,
              x: parsed.element.x || 0,
              y: parsed.element.y || 0,
              width: parsed.element.width || 0,
              height: parsed.element.height || 0,
            });
          }
        } catch {
          /* skip */
        }
      }
      if (elems.length === 0) {
        return JSON.stringify({ success: false, error: "No elements found" });
      }

      let target: number;
      for (const el of elems) {
        switch (alignment) {
          case "left":
            target = Math.min(...elems.map((e) => e.x));
            await api.put(`/api/elements/${el.id}`, { x: target });
            break;
          case "right":
            target = Math.max(...elems.map((e) => e.x + e.width));
            await api.put(`/api/elements/${el.id}`, { x: target - el.width });
            break;
          case "center":
            target = elems.reduce((s, e) => s + e.x + e.width / 2, 0) / elems.length;
            await api.put(`/api/elements/${el.id}`, { x: target - el.width / 2 });
            break;
          case "top":
            target = Math.min(...elems.map((e) => e.y));
            await api.put(`/api/elements/${el.id}`, { y: target });
            break;
          case "bottom":
            target = Math.max(...elems.map((e) => e.y + e.height));
            await api.put(`/api/elements/${el.id}`, { y: target - el.height });
            break;
          case "middle":
            target = elems.reduce((s, e) => s + e.y + e.height / 2, 0) / elems.length;
            await api.put(`/api/elements/${el.id}`, { y: target - el.height / 2 });
            break;
        }
      }
      return JSON.stringify({ success: true, alignment, updated: elems.length });
    },
  },
  {
    name: "distribute_elements",
    description: "Distribute elements evenly (horizontal or vertical).",
    parameters: {
      type: "object",
      properties: {
        elementIds: { type: "array", description: "Element IDs to distribute" },
        direction: { type: "string", description: "Direction: horizontal or vertical" },
      },
      required: ["elementIds", "direction"],
    },
    handler: async (p, api) => {
      const ids = p.elementIds as string[];
      const dir = String(p.direction);
      const elems: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];

      for (const id of ids) {
        const raw = await api.get(`/api/elements/${id}`);
        try {
          const parsed = JSON.parse(raw);
          if (parsed.success && parsed.element) {
            elems.push({
              id: parsed.element.id,
              x: parsed.element.x || 0,
              y: parsed.element.y || 0,
              width: parsed.element.width || 0,
              height: parsed.element.height || 0,
            });
          }
        } catch {
          /* skip */
        }
      }
      if (elems.length < 3) {
        return JSON.stringify({ success: true, message: "Need 3+ elements to distribute" });
      }

      if (dir === "horizontal") {
        elems.sort((a, b) => a.x - b.x);
        const first = elems[0]!;
        const last = elems[elems.length - 1]!;
        const totalSpan = last.x - first.x;
        const gap = totalSpan / (elems.length - 1);
        for (let i = 1; i < elems.length - 1; i++) {
          await api.put(`/api/elements/${elems[i]!.id}`, { x: first.x + gap * i });
        }
      } else {
        elems.sort((a, b) => a.y - b.y);
        const first = elems[0]!;
        const last = elems[elems.length - 1]!;
        const totalSpan = last.y - first.y;
        const gap = totalSpan / (elems.length - 1);
        for (let i = 1; i < elems.length - 1; i++) {
          await api.put(`/api/elements/${elems[i]!.id}`, { y: first.y + gap * i });
        }
      }
      return JSON.stringify({ success: true, direction: dir, distributed: elems.length });
    },
  },

  // ── State management (4) ──────────────────────────────────────────
  {
    name: "lock_elements",
    description: "Lock elements to prevent modification.",
    parameters: {
      type: "object",
      properties: {
        elementIds: { type: "array", description: "Element IDs to lock" },
      },
      required: ["elementIds"],
    },
    handler: async (p, api) => {
      const ids = p.elementIds as string[];
      for (const id of ids) {
        await api.put(`/api/elements/${id}`, { locked: true });
      }
      return JSON.stringify({ success: true, locked: ids.length });
    },
  },
  {
    name: "unlock_elements",
    description: "Unlock elements to allow modification.",
    parameters: {
      type: "object",
      properties: {
        elementIds: { type: "array", description: "Element IDs to unlock" },
      },
      required: ["elementIds"],
    },
    handler: async (p, api) => {
      const ids = p.elementIds as string[];
      for (const id of ids) {
        await api.put(`/api/elements/${id}`, { locked: false });
      }
      return JSON.stringify({ success: true, unlocked: ids.length });
    },
  },
  {
    name: "clear_canvas",
    description:
      "Clear all elements from the canvas. WARNING: cannot be undone (use snapshot_scene first).",
    parameters: { type: "object", properties: {} },
    handler: (_p, api) => api.del("/api/elements/clear"),
  },
  {
    name: "snapshot_scene",
    description: "Save a named snapshot of the current canvas state for later restoration.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Snapshot name" },
      },
      required: ["name"],
    },
    handler: (p, api) => api.post("/api/snapshots", { name: p.name }),
  },
  {
    name: "restore_snapshot",
    description: "Restore the canvas from a previously saved named snapshot.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Snapshot name to restore" },
      },
      required: ["name"],
    },
    handler: async (p, api) => {
      const raw = await api.get(`/api/snapshots/${encodeURIComponent(String(p.name))}`);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.success && parsed.snapshot?.elements) {
          // Clear then re-create
          await api.del("/api/elements/clear");
          return api.post("/api/elements/batch", { elements: parsed.snapshot.elements });
        }
      } catch {
        /* skip */
      }
      return raw; // Return the error/raw response
    },
  },

  // ── Inspection & export (5) ───────────────────────────────────────
  {
    name: "describe_scene",
    description:
      "Get an AI-readable description of the current canvas: element types, positions, connections, labels, spatial layout, and bounding box.",
    parameters: { type: "object", properties: {} },
    handler: async (_p, api) => {
      const raw = await api.get("/api/elements");
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.success || !Array.isArray(parsed.elements)) {
          return raw;
        }

        const elems = parsed.elements;
        if (elems.length === 0) {
          return JSON.stringify({ description: "Canvas is empty." });
        }

        const types: Record<string, number> = {};
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        const summaries: string[] = [];

        for (const el of elems) {
          types[el.type] = (types[el.type] || 0) + 1;
          const x = el.x || 0,
            y = el.y || 0;
          const w = el.width || 0,
            h = el.height || 0;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);

          let label = `${el.type} (${el.id})`;
          if (el.text) {
            label += ` text="${el.text}"`;
          }
          if (el.label?.text) {
            label += ` label="${el.label.text}"`;
          }
          label += ` at (${x}, ${y})`;
          if (w || h) {
            label += ` ${w}x${h}`;
          }
          if (el.backgroundColor && el.backgroundColor !== "transparent") {
            label += ` bg=${el.backgroundColor}`;
          }
          summaries.push(label);
        }

        return JSON.stringify(
          {
            elementCount: elems.length,
            types,
            boundingBox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
            elements: summaries,
          },
          null,
          2,
        );
      } catch {
        return raw;
      }
    },
  },
  {
    name: "export_scene",
    description: "Export the current canvas as .excalidraw JSON format.",
    parameters: { type: "object", properties: {} },
    handler: async (_p, api) => {
      const raw = await api.get("/api/elements");
      try {
        const parsed = JSON.parse(raw);
        if (parsed.success && Array.isArray(parsed.elements)) {
          const scene = {
            type: "excalidraw",
            version: 2,
            source: "openclaw-excalidraw-plugin",
            elements: parsed.elements,
            appState: { viewBackgroundColor: "#ffffff" },
            files: {},
          };
          return JSON.stringify(scene, null, 2);
        }
      } catch {
        /* skip */
      }
      return raw;
    },
  },
  {
    name: "import_scene",
    description:
      "Import elements from .excalidraw JSON data. Mode: 'replace' clears canvas first, 'merge' appends.",
    parameters: {
      type: "object",
      properties: {
        data: { type: "string", description: "Raw .excalidraw JSON string" },
        mode: { type: "string", description: "'replace' clears canvas first, 'merge' appends" },
      },
      required: ["data", "mode"],
    },
    handler: async (p, api) => {
      const mode = String(p.mode);
      let elements: unknown[];
      try {
        const parsed = JSON.parse(String(p.data));
        elements = parsed.elements || parsed;
        if (!Array.isArray(elements)) {
          throw new Error("No elements array found");
        }
      } catch (err) {
        return JSON.stringify({ success: false, error: `Invalid JSON: ${String(err)}` });
      }

      if (mode === "replace") {
        await api.del("/api/elements/clear");
      }
      return api.post("/api/elements/batch", { elements });
    },
  },
  {
    name: "export_to_image",
    description:
      "Export the current canvas to PNG or SVG image. Requires the canvas frontend open in a browser.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", description: "Image format: png or svg" },
        background: { type: "boolean", description: "Include background (default: true)" },
      },
      required: ["format"],
    },
    handler: (p, api) =>
      api.post("/api/export/image", {
        format: p.format,
        background: p.background ?? true,
      }),
  },
  {
    name: "get_canvas_screenshot",
    description:
      "Take a screenshot of the current canvas (PNG). Requires the canvas frontend open in a browser.",
    parameters: {
      type: "object",
      properties: {
        background: { type: "boolean", description: "Include background (default: true)" },
      },
    },
    handler: (p, api) =>
      api.post("/api/export/image", { format: "png", background: p.background ?? true }),
  },

  // ── Advanced (5) ──────────────────────────────────────────────────
  {
    name: "create_from_mermaid",
    description:
      "Convert a Mermaid diagram to Excalidraw elements and render them on the canvas. Requires frontend open.",
    parameters: {
      type: "object",
      properties: {
        mermaidDiagram: {
          type: "string",
          description: 'Mermaid definition e.g. "graph TD; A-->B; B-->C;"',
        },
      },
      required: ["mermaidDiagram"],
    },
    handler: (p, api) =>
      api.post("/api/elements/from-mermaid", {
        mermaidDiagram: p.mermaidDiagram,
        config: p.config || {},
      }),
  },
  {
    name: "set_viewport",
    description:
      "Control the canvas viewport. Auto-fit all elements, center on an element, or set zoom/scroll. Requires frontend open.",
    parameters: {
      type: "object",
      properties: {
        scrollToContent: { type: "boolean", description: "Auto-fit all elements (zoom-to-fit)" },
        scrollToElementId: { type: "string", description: "Center on a specific element by ID" },
        zoom: { type: "number", description: "Zoom level (0.1–10, 1 = 100%)" },
        offsetX: { type: "number", description: "Horizontal scroll offset" },
        offsetY: { type: "number", description: "Vertical scroll offset" },
      },
    },
    handler: (p, api) => api.post("/api/viewport", stripUndefined(p)),
  },
  {
    name: "get_resource",
    description: "Get an Excalidraw resource: scene (all elements), sync status, or health.",
    parameters: {
      type: "object",
      properties: {
        resource: { type: "string", description: "Resource: scene, sync, health" },
      },
      required: ["resource"],
    },
    handler: (p, api) => {
      switch (p.resource) {
        case "scene":
        case "elements":
          return api.get("/api/elements");
        case "sync":
          return api.get("/api/sync/status");
        case "health":
          return api.get("/health");
        default:
          return api.get("/api/elements");
      }
    },
  },
  {
    name: "list_snapshots",
    description: "List all saved canvas snapshots.",
    parameters: { type: "object", properties: {} },
    handler: (_p, api) => api.get("/api/snapshots"),
  },
  {
    name: "sync_status",
    description: "Get canvas sync status: element count, WebSocket clients, memory usage.",
    parameters: { type: "object", properties: {} },
    handler: (_p, api) => api.get("/api/sync/status"),
  },
];

// ---------- Plugin entry point ----------

export default function register(api: PluginApi) {
  const logger = api.logger;
  const canvasUrl = (api.config?.canvasUrl || "http://localhost:3010").replace(/\/$/, "");

  logger.debug(`Registering Excalidraw canvas tools (endpoint: ${canvasUrl})...`);

  const client = createCanvasClient(canvasUrl, logger);

  for (const tool of TOOLS) {
    const pluginToolName = `excalidraw_${tool.name}`;

    api.registerTool({
      name: pluginToolName,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await tool.handler(params, client);
        return { content: [{ type: "text", text: result }] };
      },
    });
  }

  logger.info(`Excalidraw canvas plugin registered: ${TOOLS.length} tools`);
}
