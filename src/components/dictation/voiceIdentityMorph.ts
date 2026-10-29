// Agent Mode mark: the "pulsing ring". A maroon rounded tile with a soft pink
// glow, two concentric white rings and a solid white centre dot. Drawn on the
// 300x300 artboard of src/assets/assistant-ring.svg, scaled into the 24x24
// icon box (factor 0.08). Ring strokes are thickened slightly so they stay
// visible at pill size.
export const AGENT_RING_MARK = {
  tile: { size: 24, radius: 5.44, from: "#a3123a", to: "#5c0016" },
  glow: { r: 9.44, color: "#ff9ab0", opacity: 0.55 },
  outerRing: { r: 7.84, strokeWidth: 0.9, opacity: 0.25 },
  innerRing: { r: 5.76, strokeWidth: 1.1, opacity: 0.55 },
  dot: { r: 3.36 },
} as const;

type CubicCurve = readonly [number, number, number, number, number, number];

interface CubicPath {
  start: readonly [number, number];
  curves: readonly CubicCurve[];
  closed?: boolean;
}

interface MorphPair {
  from: CubicPath;
  to: CubicPath;
}

const LISTENING_RING: CubicPath = {
  start: [4.929, 19.071],
  curves: [
    [1.024, 15.166, 1.024, 8.834, 4.929, 4.929],
    [8.834, 1.024, 15.166, 1.024, 19.071, 4.929],
    [22.976, 8.834, 22.976, 15.166, 19.071, 19.071],
    [15.166, 22.976, 8.834, 22.976, 4.929, 19.071],
  ],
  closed: true,
};

const scaleAboutCentre = (path: CubicPath, factor: number): CubicPath => {
  const s = (v: number) => 12 + (v - 12) * factor;
  return {
    start: [s(path.start[0]), s(path.start[1])],
    curves: path.curves.map((c) => c.map(s) as unknown as CubicCurve),
    closed: path.closed,
  };
};

// The listening ring (r 10) tightens into the mark's outer ring (r 7.84).
const AGENT_OUTER_RING = scaleAboutCentre(LISTENING_RING, AGENT_RING_MARK.outerRing.r / 10);

// The sound bars draw in to the centre and become the solid dot.
const CENTRE_POINT: CubicPath = { start: [12, 11.4], curves: [[12, 11.8, 12, 12.2, 12, 12.6]] };

const MORPH_PATHS = {
  shell: { from: LISTENING_RING, to: AGENT_OUTER_RING },
  leftBar: {
    from: { start: [8.75, 10], curves: [[8.75, 11.2, 8.75, 12.8, 8.75, 14]] },
    to: CENTRE_POINT,
  },
  centerBar: {
    from: { start: [12, 8], curves: [[12, 10.2, 12, 13.8, 12, 16]] },
    to: CENTRE_POINT,
  },
  rightBar: {
    from: { start: [15.25, 10], curves: [[15.25, 11.2, 15.25, 12.8, 15.25, 14]] },
    to: CENTRE_POINT,
  },
  sparkCross: {
    from: { start: [8.75, 10], curves: [[8.75, 11.2, 8.75, 12.8, 8.75, 14]] },
    to: CENTRE_POINT,
  },
} satisfies Record<string, MorphPair>;
export const VOICE_IDENTITY_MORPH_DURATION_MS = 480;

const interpolate = (from: number, to: number, progress: number) => from + (to - from) * progress;

const format = (value: number) => Number(value.toFixed(3));

const interpolatePath = ({ from, to }: MorphPair, progress: number) => {
  const startX = format(interpolate(from.start[0], to.start[0], progress));
  const startY = format(interpolate(from.start[1], to.start[1], progress));
  const curves = from.curves.map((curve, curveIndex) => {
    const target = to.curves[curveIndex];
    const values = curve.map((value, valueIndex) =>
      format(interpolate(value, target[valueIndex], progress))
    );
    return `C${values.join(" ")}`;
  });
  return `M${startX} ${startY}${curves.join("")}${from.closed ? "Z" : ""}`;
};

const smoothRange = (progress: number, start: number, end: number) => {
  const normalized = Math.min(1, Math.max(0, (progress - start) / (end - start)));
  return normalized * normalized * (3 - 2 * normalized);
};

export const resolveVoiceIdentityMorphPaths = (progress: number) => {
  const boundedProgress = Math.min(1, Math.max(0, progress));
  return {
    shell: interpolatePath(MORPH_PATHS.shell, boundedProgress),
    leftBar: interpolatePath(MORPH_PATHS.leftBar, boundedProgress),
    centerBar: interpolatePath(MORPH_PATHS.centerBar, boundedProgress),
    rightBar: interpolatePath(MORPH_PATHS.rightBar, boundedProgress),
    sparkCross: interpolatePath(MORPH_PATHS.sparkCross, boundedProgress),
    constructionOpacity: 1 - smoothRange(boundedProgress, 0.7, 0.96),
    sparkOpacity:
      smoothRange(boundedProgress, 0.2, 0.48) * (1 - smoothRange(boundedProgress, 0.72, 0.96)),
    agentOpacity: smoothRange(boundedProgress, 0.58, 0.94),
  };
};
