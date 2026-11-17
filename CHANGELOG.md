# Changelog

## 1.1.0
- **Interactive dashboard in the chat (MCP Apps).** New tool `mrh_dashboard` linked to the UI resource `ui://mrh-p6/pano`:
  KPIs, progress S-curve (baseline / current / actual), Gantt with baseline bars and critical path, schedule health,
  baseline slips and 30-day look-ahead. Live activity details through `tools/call`, project and baseline switch,
  fullscreen, "ask the assistant" buttons (`ui/message`) and the selected activity shared as model context.
  Light/dark theme and English/Turkish follow the host. No external resources. Text summary for clients without MCP Apps.
- **New tools:** `mrh_progress_curve` (S-curve data) and `mrh_critical_activities` (open critical activities by start date).
- Baseline slip lists no longer include level-of-effort activities.
- The server now announces the `resources` capability and serves `resources/list` and `resources/read`.

## 1.0.0
- First release: overview, activity search and details, 15-check health score, baseline slips, look-ahead,
  read-only SQL, XER export, and safe, undoable edits (read-only by default, automatic backup).
