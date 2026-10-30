/**
 * 三栏布局的几何计算：与 DOM/localStorage 解耦，方便按视口宽度做单元测试。
 * 调用方负责将 window.innerWidth 与存储的原始字符串传进来。
 */

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const PANEL_MIN = 220;
export const PANEL_MAX = 720;
/** 中间聊天区在任何拖拽下都不许被挤到不可用。 */
export const CHAT_MIN = 460;
export const PANE_STEP = 16;
export const LAYOUT_KEY = "ac_layout";

export interface PaneWidths {
  sidebar: number;
  panel: number;
}

export type PaneName = keyof PaneWidths;

/**
 * 右栏的最优预览宽度：文件预览（Markdown、表格、PDF、图片）都在这里展开，
 * 默认值按视口给足可读宽度，上限再交给 panelMax 约束聊天区。
 */
export function preferredPanelWidth(viewportWidth: number): number {
  if (viewportWidth < 1180) return 300;
  if (viewportWidth < 1280) return 340;
  if (viewportWidth < 1440) return 400;
  if (viewportWidth < 1680) return 460;
  if (viewportWidth < 1900) return 520;
  return 560;
}

export function defaultPanes(viewportWidth: number): PaneWidths {
  return {
    sidebar: viewportWidth <= 1180 ? 240 : 264,
    panel: preferredPanelWidth(viewportWidth),
  };
}

export function clampTo(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sidebarMax(viewportWidth: number, pane: PaneWidths): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewportWidth - pane.panel - CHAT_MIN));
}

export function panelMax(viewportWidth: number, pane: PaneWidths): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, viewportWidth - pane.sidebar - CHAT_MIN));
}

export function fitPanes(viewportWidth: number, next: PaneWidths): PaneWidths {
  const sidebar = Math.round(clampTo(next.sidebar, SIDEBAR_MIN, sidebarMax(viewportWidth, next)));
  const widened: PaneWidths = { ...next, sidebar };
  return {
    ...widened,
    panel: Math.round(clampTo(next.panel, PANEL_MIN, panelMax(viewportWidth, widened))),
  };
}

/** 旧版本自动写入的紧凑默认值：等同于「用户从没自定义过」，直接升级成最优预览宽度。 */
const LEGACY_PANEL_DEFAULTS = [272, 300];

export function pickStoredPanes(raw: string | null): PaneWidths | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    if (typeof parsed.sidebar !== "number" || typeof parsed.panel !== "number") return null;
    if (LEGACY_PANEL_DEFAULTS.includes(parsed.panel)) return null;
    return { sidebar: parsed.sidebar, panel: parsed.panel };
  } catch {
    return null;
  }
}

export function readPanes(viewportWidth: number, raw: string | null): PaneWidths {
  return fitPanes(viewportWidth, pickStoredPanes(raw) ?? defaultPanes(viewportWidth));
}
