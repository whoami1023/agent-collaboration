import { describe, expect, it } from "vitest";
import {
  CHAT_MIN,
  PANEL_MAX,
  PANEL_MIN,
  SIDEBAR_MIN,
  defaultPanes,
  fitPanes,
  pickStoredPanes,
  preferredPanelWidth,
  readPanes,
} from "./layout";

describe("右栏最优预览宽度", () => {
  it("按视口分档给出预览宽度，宽屏不低于 460", () => {
    expect(preferredPanelWidth(1000)).toBe(300);
    expect(preferredPanelWidth(1179)).toBe(300);
    expect(preferredPanelWidth(1180)).toBe(340);
    expect(preferredPanelWidth(1279)).toBe(340);
    expect(preferredPanelWidth(1280)).toBe(400);
    expect(preferredPanelWidth(1439)).toBe(400);
    expect(preferredPanelWidth(1440)).toBe(460);
    expect(preferredPanelWidth(1679)).toBe(460);
    expect(preferredPanelWidth(1680)).toBe(520);
    expect(preferredPanelWidth(1899)).toBe(520);
    expect(preferredPanelWidth(1900)).toBe(560);
    expect(preferredPanelWidth(2560)).toBe(560);
  });

  it("默认栏宽 = 紧凑侧栏 + 最优预览宽度", () => {
    expect(defaultPanes(1440)).toEqual({ sidebar: 264, panel: 460 });
    expect(defaultPanes(1180)).toEqual({ sidebar: 240, panel: 340 });
  });

  it("默认宽度在任何视口都不越界，也不挤压聊天区", () => {
    for (let vw = 900; vw <= 2560; vw += 20) {
      const fitted = fitPanes(vw, defaultPanes(vw));
      expect(fitted.sidebar).toBeGreaterThanOrEqual(SIDEBAR_MIN);
      expect(fitted.panel).toBeGreaterThanOrEqual(PANEL_MIN);
      expect(fitted.panel).toBeLessThanOrEqual(PANEL_MAX);
      // 聊天区至少保留 CHAT_MIN（极窄视口会被 PANEL_MIN 兜底，此时布局已切换为堆叠）。
      expect(vw - fitted.sidebar - fitted.panel).toBeGreaterThanOrEqual(
        Math.min(CHAT_MIN, vw - SIDEBAR_MIN - PANEL_MIN),
      );
    }
  });

  it("适配时把聊天区保底放在栏宽之前", () => {
    expect(fitPanes(1000, { sidebar: 264, panel: 800 })).toEqual({ sidebar: 200, panel: 340 });
    expect(fitPanes(1440, { sidebar: 900, panel: 900 })).toEqual({ sidebar: 200, panel: 720 });
  });
});

describe("布局记忆的读取", () => {
  it("旧的紧凑默认值等同于没自定义过，直接升级", () => {
    expect(pickStoredPanes(JSON.stringify({ sidebar: 264, panel: 300 }))).toBeNull();
    expect(pickStoredPanes(JSON.stringify({ sidebar: 240, panel: 272 }))).toBeNull();
  });

  it("用户自定义过的宽度原样读回", () => {
    expect(pickStoredPanes(JSON.stringify({ sidebar: 300, panel: 520 }))).toEqual({
      sidebar: 300,
      panel: 520,
    });
  });

  it("缺字段或坏数据回退到默认", () => {
    expect(pickStoredPanes(null)).toBeNull();
    expect(pickStoredPanes("{")).toBeNull();
    expect(pickStoredPanes(JSON.stringify({ sidebar: 300 }))).toBeNull();
    expect(pickStoredPanes(JSON.stringify({ panel: "520" }))).toBeNull();
  });

  it("readPanes 无存储时按视口取最优预览宽度，有存储时按存储适配", () => {
    expect(readPanes(1440, null)).toEqual({ sidebar: 264, panel: 460 });
    expect(readPanes(1440, JSON.stringify({ sidebar: 264, panel: 640 }))).toEqual({
      sidebar: 264,
      panel: 640,
    });
    expect(readPanes(1000, JSON.stringify({ sidebar: 264, panel: 640 }))).toEqual({
      sidebar: 200,
      panel: 340,
    });
  });
});
