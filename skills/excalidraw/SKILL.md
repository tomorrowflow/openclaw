---
name: excalidraw
description: Programmatic canvas toolkit for creating, editing, and refining Excalidraw diagrams via OpenClaw tools with real-time canvas sync. Use when an agent needs to draw diagrams, create flowcharts, architecture diagrams, or whiteboards. Provides 26 tools for element CRUD, batch creation, layout, snapshots, mermaid conversion, image export, and viewport control. Requires a running Excalidraw canvas server (default http://localhost:3010).
---

# Excalidraw Skill

Diagramming and whiteboard via the Excalidraw canvas REST API. All tools are
prefixed `excalidraw_` (e.g. `excalidraw_create_element`).

## Connection Check

Before doing anything, verify the canvas is reachable:

```
excalidraw_sync_status
```

If it returns element count and WebSocket info, you're connected. If it fails,
the canvas server is not running — tell the user to start it
(`docker-compose up canvas` or `npm run canvas` in the mcp_excalidraw repo).

## Quick Reference (26 tools)

### Element CRUD (7)

| Tool                               | Description                  | Required params   |
| ---------------------------------- | ---------------------------- | ----------------- |
| `excalidraw_create_element`        | Create shape/text/arrow/line | `type`, `x`, `y`  |
| `excalidraw_get_element`           | Get single element by ID     | `id`              |
| `excalidraw_update_element`        | Update element properties    | `id`              |
| `excalidraw_delete_element`        | Delete element               | `id`              |
| `excalidraw_query_elements`        | Query by type/filters        | (optional) `type` |
| `excalidraw_batch_create_elements` | Create many at once          | `elements[]`      |
| `excalidraw_duplicate_elements`    | Clone with offset            | `elementIds[]`    |

### Layout (4)

| Tool                             | Description                                | Required params             |
| -------------------------------- | ------------------------------------------ | --------------------------- |
| `excalidraw_align_elements`      | Align: left/center/right/top/middle/bottom | `elementIds[]`, `alignment` |
| `excalidraw_distribute_elements` | Even spacing horizontal/vertical           | `elementIds[]`, `direction` |
| `excalidraw_group_elements`      | Group elements                             | `elementIds[]`              |
| `excalidraw_ungroup_elements`    | Ungroup                                    | `groupId`                   |

### State Management (6)

| Tool                          | Description           | Required params |
| ----------------------------- | --------------------- | --------------- |
| `excalidraw_lock_elements`    | Lock elements         | `elementIds[]`  |
| `excalidraw_unlock_elements`  | Unlock elements       | `elementIds[]`  |
| `excalidraw_clear_canvas`     | Remove all elements   | (none)          |
| `excalidraw_snapshot_scene`   | Save named snapshot   | `name`          |
| `excalidraw_restore_snapshot` | Restore from snapshot | `name`          |
| `excalidraw_list_snapshots`   | List all snapshots    | (none)          |

### Inspection & Export (5)

| Tool                               | Description                         | Required params |
| ---------------------------------- | ----------------------------------- | --------------- |
| `excalidraw_describe_scene`        | AI-readable scene description       | (none)          |
| `excalidraw_export_scene`          | Export as .excalidraw JSON          | (none)          |
| `excalidraw_import_scene`          | Import .excalidraw JSON             | `data`, `mode`  |
| `excalidraw_export_to_image`       | Export to PNG/SVG (needs browser)   | `format`        |
| `excalidraw_get_canvas_screenshot` | Take PNG screenshot (needs browser) | (none)          |

### Advanced (4)

| Tool                             | Description                  | Required params              |
| -------------------------------- | ---------------------------- | ---------------------------- |
| `excalidraw_create_from_mermaid` | Mermaid to Excalidraw        | `mermaidDiagram`             |
| `excalidraw_set_viewport`        | Camera control / zoom-to-fit | (optional) `scrollToContent` |
| `excalidraw_get_resource`        | Get scene/sync/health        | `resource`                   |
| `excalidraw_sync_status`         | Memory/WebSocket stats       | (none)                       |

## Element Types

`rectangle`, `ellipse`, `diamond`, `arrow`, `text`, `line`, `freedraw`

## Workflow: Draw a Diagram

1. Optional: `excalidraw_clear_canvas` to start fresh.
2. Plan your coordinate grid (see Layout Planning below).
3. Use `excalidraw_batch_create_elements` with shapes AND arrows in one call.
4. **Assign custom `id` to shapes** (e.g. `"id": "auth-svc"`).
5. **Use `label: {text: "..."}` for shape labels** (not bare `text`).
6. **Bind arrows** with `start: {id: "..."}` / `end: {id: "..."}` — auto-routes to edges.
7. **Size shapes for text**: `width: max(160, labelTextLength * 9)`.
8. `excalidraw_set_viewport` with `scrollToContent: true` to auto-fit.
9. `excalidraw_get_canvas_screenshot` and verify quality (see checklist).

### Arrow Binding Example

```json
{
  "elements": [
    {
      "id": "svc-a",
      "type": "rectangle",
      "x": 0,
      "y": 0,
      "width": 160,
      "height": 60,
      "label": { "text": "Service A" }
    },
    {
      "id": "svc-b",
      "type": "rectangle",
      "x": 0,
      "y": 200,
      "width": 160,
      "height": 60,
      "label": { "text": "Service B" }
    },
    { "type": "arrow", "x": 0, "y": 0, "start": { "id": "svc-a" }, "end": { "id": "svc-b" } }
  ]
}
```

### Curved / Elbowed Arrows (avoid overlap)

Curved: add waypoints + `roundness`:

```json
{
  "type": "arrow",
  "x": 100,
  "y": 100,
  "points": [
    [0, 0],
    [50, -40],
    [200, 0]
  ],
  "roundness": { "type": 2 }
}
```

Elbowed: right-angle routing:

```json
{
  "type": "arrow",
  "x": 100,
  "y": 100,
  "points": [
    [0, 0],
    [0, -50],
    [200, -50],
    [200, 0]
  ],
  "elbowed": true
}
```

## Quality Checklist (run after every iteration)

1. **Text truncation**: All text fully visible? Increase width/height if cut off.
2. **Overlap**: No elements sharing space. Background zones must contain children with 50px padding.
3. **Arrow crossing**: Arrows must not cross unrelated elements. Use curved/elbowed routing.
4. **Spacing**: At least 40px gap between elements.
5. **Readability**: Font size >= 16 body, >= 20 titles.

If ANY issue found: fix first, re-verify, then proceed.

## Sizing Rules

- Shape width: `max(160, labelTextLength * 9)` px
- Shape height: 60px (1 line), 80px (2 lines), 100px (3 lines)
- Background zones: 50px padding on all sides
- Element spacing: 60px vertical between tiers, 40px horizontal between siblings

## Layout Planning

Plan coordinates before creating elements:

- Tier 1 (y=50-130): Client apps
- Tier 2 (y=200-280): Gateway / Edge
- Tier 3 (y=350-440): Services (each ~180px apart horizontally)
- Tier 4 (y=510-590): Data stores
- Side panels: x < 0 (left) or x > mainDiagramRight + 80 (right)

## Font Families

`virgil` (1), `helvetica` (2), `cascadia` (3), `excalifont` (5), `nunito` (6), `lilita` (7), `comic` (8)

## Points Format

`points` accepts both tuple `[[0,0],[100,50]]` and object `[{"x":0,"y":0},{"x":100,"y":50}]` format.
