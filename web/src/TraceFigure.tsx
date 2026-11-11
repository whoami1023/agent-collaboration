/**
 * 运行轨迹里的像素小人：灵感来自 AgentGUI 的 20×30 像素角色，
 * 这里按「指挥 / 调研 / 开发 / 写作 / 通用」五种形象绘制，状态驱动走路式的微动画。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { TraceLook, TraceMood } from "./run-trace-model";

const P = 2;
const INK = "#26313a";
const SKIN = "#ffd9b4";
const WHITE = "#f7f5f0";
const TROUSER = "#2f3542";
const SHOE = "#20242b";

function px(x: number, y: number, w: number, h: number, fill: string, key?: string) {
  return (
    <rect
      key={key ?? `${x},${y},${w},${h},${fill}`}
      x={x * P}
      y={y * P}
      width={w * P}
      height={h * P}
      fill={fill}
      shapeRendering="crispEdges"
    />
  );
}

function shade(hex: string, amt: number): string {
  const value = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(value)) return hex;
  const red = Math.min(255, Math.max(0, ((value >> 16) & 0xff) + amt));
  const green = Math.min(255, Math.max(0, ((value >> 8) & 0xff) + amt));
  const blue = Math.min(255, Math.max(0, (value & 0xff) + amt));
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, "0")}`;
}

interface Outfit {
  garment: string;
  garmentHi: string;
  cuff: string;
  torso: ReactNode;
  hair: ReactNode;
  face?: ReactNode;
}

function outfitFor(look: TraceLook, accent: string): Outfit {
  switch (look) {
    case "planner": {
      const blazer = shade(accent, -45);
      return {
        garment: blazer,
        garmentHi: shade(accent, -20),
        cuff: WHITE,
        torso: (
          <>
            {px(9, 16, 2, 9, WHITE, "shirt")}
            {px(9, 17, 2, 1, accent, "tie-top")}
            {px(9, 18, 2, 5, accent, "tie")}
            {px(6, 16, 2, 4, shade(accent, -20), "lapel-l")}
            {px(12, 16, 2, 4, shade(accent, -20), "lapel-r")}
            {px(5, 21, 3, 2, WHITE, "badge")}
            {px(5, 21, 3, 1, accent, "badge-line")}
          </>
        ),
        hair: (
          <>
            {px(5, 4, 10, 3, "#3a322a", "hair")}
            {px(5, 6, 2, 4, "#3a322a", "hair-l")}
            {px(13, 6, 2, 4, "#3a322a", "hair-r")}
            {px(7, 3, 6, 1, "#463c32", "hair-top")}
          </>
        ),
      };
    }
    case "researcher": {
      const coat = shade(accent, -6);
      return {
        garment: coat,
        garmentHi: shade(accent, 16),
        cuff: shade(accent, 24),
        torso: (
          <>
            {px(9, 16, 2, 9, WHITE, "shirt")}
            {px(7, 16, 6, 2, shade(accent, -28), "scarf")}
            {px(12, 17, 2, 5, shade(accent, -28), "scarf-tail")}
            {px(5, 20, 3, 3, shade(accent, 16), "pocket-l")}
            {px(12, 20, 3, 3, shade(accent, 16), "pocket-r")}
          </>
        ),
        hair: (
          <>
            {px(5, 4, 10, 3, "#4a3a2e", "hair")}
            {px(5, 6, 2, 5, "#4a3a2e", "hair-l")}
            {px(13, 6, 2, 5, "#4a3a2e", "hair-r")}
            {px(15, 3, 3, 3, "#4a3a2e", "bun")}
          </>
        ),
        face: (
          <>
            {px(6, 9, 1, 2, INK, "gl-l")}
            {px(8, 9, 1, 2, INK, "gl-l2")}
            {px(9, 9, 2, 1, INK, "gl-bridge")}
            {px(11, 9, 1, 2, INK, "gl-r")}
            {px(13, 9, 1, 2, INK, "gl-r2")}
          </>
        ),
      };
    }
    case "coder": {
      const hood = shade(accent, -50);
      return {
        garment: hood,
        garmentHi: shade(accent, -25),
        cuff: "#1c2733",
        torso: (
          <>
            {px(7, 20, 6, 3, shade(accent, -28), "pocket")}
            {px(9, 17, 1, 3, WHITE, "cord-l")}
            {px(11, 17, 1, 3, WHITE, "cord-r")}
            {px(10, 17, 1, 6, shade(accent, -20), "zip")}
            {px(6, 16, 6, 1, shade(accent, -20), "hood")}
          </>
        ),
        hair: (
          <>
            {px(5, 4, 10, 3, "#2b2f3a", "hair")}
            {px(7, 2, 2, 2, "#2b2f3a", "spike-l")}
            {px(11, 2, 2, 2, "#2b2f3a", "spike-r")}
            {px(5, 4, 10, 1, "#26262e", "hp-band")}
            {px(4, 6, 1, 4, "#26262e", "hp-cup-l")}
            {px(15, 6, 1, 4, "#26262e", "hp-cup-r")}
          </>
        ),
        face: (
          <>
            {px(6, 9, 3, 1, "#101820", "gl-l")}
            {px(11, 9, 3, 1, "#101820", "gl-r")}
            {px(9, 9, 1, 1, "#101820", "gl-bridge")}
            {px(7, 9, 1, 1, "#5ee6a0", "gl-glint")}
          </>
        ),
      };
    }
    case "writer": {
      const knit = shade(accent, -30);
      return {
        garment: knit,
        garmentHi: shade(accent, -10),
        cuff: shade(accent, 10),
        torso: (
          <>
            {px(7, 15, 6, 2, accent, "scarf")}
            {px(12, 16, 2, 6, accent, "scarf-tail")}
            {px(4, 20, 12, 1, shade(accent, -52), "stripe-1")}
            {px(4, 23, 12, 1, shade(accent, -52), "stripe-2")}
            {px(8, 16, 4, 3, shade(accent, -45), "collar")}
          </>
        ),
        hair: (
          <>
            {px(5, 4, 10, 3, "#3b3028", "hair")}
            {px(5, 6, 2, 4, "#3b3028", "hair-l")}
            {px(13, 6, 2, 4, "#3b3028", "hair-r")}
            {px(4, 2, 12, 2, shade(accent, -40), "beret")}
            {px(6, 1, 8, 2, accent, "beret-top")}
            {px(5, 4, 10, 1, shade(accent, -55), "beret-brim")}
          </>
        ),
      };
    }
    default: {
      const polo = shade(accent, -35);
      return {
        garment: polo,
        garmentHi: shade(accent, -12),
        cuff: WHITE,
        torso: (
          <>
            {px(8, 16, 4, 2, polo, "collar")}
            {px(9, 16, 2, 1, INK, "collar-line")}
            {px(5, 21, 3, 2, WHITE, "badge")}
            {px(5, 21, 3, 1, accent, "badge-line")}
            {px(6, 19, 1, 2, accent, "lanyard")}
          </>
        ),
        hair: (
          <>
            {px(5, 4, 10, 2, accent, "cap")}
            {px(5, 6, 11, 1, shade(accent, -30), "cap-brim")}
            {px(5, 7, 2, 3, "#3a322a", "hair-l")}
            {px(13, 7, 2, 3, "#3a322a", "hair-r")}
          </>
        ),
      };
    }
  }
}

function StateFx({ mood, accent }: { mood: TraceMood; accent: string }) {
  if (mood === "working") {
    return (
      <>
        {[0, 1, 2].map((index) => (
          <rect
            key={index}
            x={(14 + index * 2) * P}
            y={(1 - index) * P}
            width={P}
            height={P}
            fill={accent}
            shapeRendering="crispEdges"
            style={{ animation: `trace-dot 0.7s ease-in-out ${index * 0.16}s infinite` }}
          />
        ))}
      </>
    );
  }
  if (mood === "thinking") {
    return (
      <>
        {px(14, 5, 2, 2, "#f2b84b", "think-1")}
        {px(16, 3, 2, 2, "#f2b84b", "think-2")}
        {px(18, 1, 2, 2, "#f2b84b", "think-3")}
      </>
    );
  }
  if (mood === "error") {
    return (
      <>
        {px(16, 1, 2, 4, "#d9534f", "err-bar")}
        {px(16, 6, 2, 1, "#d9534f", "err-dot")}
      </>
    );
  }
  if (mood === "done") {
    return (
      <>
        {px(15, 3, 1, 3, "#3f9d63", "check-a")}
        {px(16, 4, 1, 1, "#3f9d63", "check-b")}
        {px(17, 3, 1, 1, "#3f9d63", "check-c")}
        {px(18, 2, 1, 1, "#3f9d63", "check-d")}
      </>
    );
  }
  if (mood === "cancelled") {
    return px(15, 3, 4, 1, "#8b8b94", "cancel");
  }
  return null;
}

export function TraceFigure({
  look,
  accent,
  mood,
  scale = 1,
  selected = false,
  label,
}: {
  look: TraceLook;
  accent: string;
  mood: TraceMood;
  scale?: number;
  selected?: boolean;
  label?: string;
}) {
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    if (mood === "error" || mood === "cancelled") return;
    let alive = true;
    const timer = setInterval(() => {
      if (!alive) return;
      setBlink(true);
      setTimeout(() => {
        if (alive) setBlink(false);
      }, 110);
    }, 2800 + Math.random() * 2200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [mood]);

  const outfit = outfitFor(look, accent);
  const working = mood === "working";

  return (
    <svg
      className={`trace-figure${selected ? " selected" : ""}`}
      width={40 * scale}
      height={60 * scale}
      viewBox="0 0 40 60"
      role="img"
      aria-label={label ?? "智能体卡通形象"}
      style={{ imageRendering: "pixelated", overflow: "visible" }}
    >
      <g className={`trace-fig-root${working ? " working" : ""}`}>
        <ellipse cx="20" cy="59" rx="11" ry="2" fill="rgba(33, 30, 26, 0.18)" />

        {px(5, 25, 4, 3, TROUSER, "leg-l")}
        {px(5, 28, 3, 2, SHOE, "shoe-l")}
        {px(11, 25, 4, 3, TROUSER, "leg-r")}
        {px(12, 28, 3, 2, SHOE, "shoe-r")}

        {px(4, 16, 12, 9, outfit.garment, "body")}
        {px(4, 16, 1, 8, outfit.garmentHi, "shoulder-l")}
        {px(15, 16, 1, 8, outfit.garmentHi, "shoulder-r")}
        {outfit.torso}

        {px(0, 17, 4, 8, outfit.garment, "arm-l")}
        {px(0, 23, 4, 2, outfit.cuff, "cuff-l")}
        {px(0, 24, 5, 2, SKIN, "hand-l")}

        <g className={`trace-fig-arm${working ? " working" : ""}`}>
          {px(16, 17, 4, 8, outfit.garment, "arm-r")}
          {px(16, 23, 4, 2, outfit.cuff, "cuff-r")}
          {px(15, 24, 5, 2, SKIN, "hand-r")}
        </g>

        {px(8, 14, 4, 2, SKIN, "neck")}
        {px(7, 15, 6, 1, outfit.garmentHi, "collar-shade")}
        {px(5, 6, 10, 9, SKIN, "head")}
        {outfit.hair}

        {blink ? (
          <>
            {px(7, 10, 2, 1, INK, "blink-l")}
            {px(11, 10, 2, 1, INK, "blink-r")}
          </>
        ) : (
          <>
            {px(7, 9, 2, 2, WHITE, "eye-l")}
            {px(11, 9, 2, 2, WHITE, "eye-r")}
            {px(8, 10, 1, 1, INK, "pupil-l")}
            {px(12, 10, 1, 1, INK, "pupil-r")}
          </>
        )}

        {outfit.face}
        {px(8, 12, 4, 1, INK, "mouth")}
        <StateFx mood={mood} accent={accent} />
      </g>
    </svg>
  );
}
