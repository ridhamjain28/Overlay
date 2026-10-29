import { useEffect, useId, useRef, type RefObject } from "react";
import { cn } from "../lib/utils";
import {
  AGENT_RING_MARK,
  resolveVoiceIdentityMorphPaths,
  VOICE_IDENTITY_MORPH_DURATION_MS,
} from "./voiceIdentityMorph";

interface VoiceIdentityIconProps {
  size?: number;
  agentMode?: boolean;
  /** Agent Mode is hearing the user: the mark's rings gently pulse. */
  listening?: boolean;
  className?: string;
}

const setPath = (ref: RefObject<SVGPathElement | null>, path: string, opacity: number) => {
  ref.current?.setAttribute("d", path);
  if (ref.current) ref.current.style.opacity = String(opacity);
};

/**
 * A real one-SVG morph: the listening ring tightens into the Agent mark's
 * outer ring and its audio bars draw in to the centre dot.
 */
export function VoiceIdentityIcon({
  size = 24,
  agentMode = false,
  listening = false,
  className,
}: VoiceIdentityIconProps) {
  const progressRef = useRef(agentMode ? 1 : 0);
  const shellRef = useRef<SVGPathElement>(null);
  const leftBarRef = useRef<SVGPathElement>(null);
  const centerBarRef = useRef<SVGPathElement>(null);
  const rightBarRef = useRef<SVGPathElement>(null);
  const sparkCrossRef = useRef<SVGPathElement>(null);
  const agentRef = useRef<SVGGElement>(null);
  const gradientId = `voice-ring-${useId().replace(/:/g, "")}`;
  const renderedMorph = resolveVoiceIdentityMorphPaths(progressRef.current);

  useEffect(() => {
    const target = agentMode ? 1 : 0;
    const start = progressRef.current;
    const distance = Math.abs(target - start);

    const applyProgress = (progress: number) => {
      const morph = resolveVoiceIdentityMorphPaths(progress);
      progressRef.current = progress;
      setPath(shellRef, morph.shell, morph.constructionOpacity);
      setPath(leftBarRef, morph.leftBar, morph.constructionOpacity);
      setPath(centerBarRef, morph.centerBar, morph.constructionOpacity);
      setPath(rightBarRef, morph.rightBar, morph.constructionOpacity);
      setPath(sparkCrossRef, morph.sparkCross, morph.sparkOpacity);
      if (agentRef.current) agentRef.current.style.opacity = String(morph.agentOpacity);
    };

    if (distance === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyProgress(target);
      return;
    }

    const startedAt = performance.now();
    const duration = VOICE_IDENTITY_MORPH_DURATION_MS * distance;
    let frame = 0;

    const animate = (now: number) => {
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const eased = elapsed < 0.5 ? 4 * elapsed ** 3 : 1 - (-2 * elapsed + 2) ** 3 / 2;
      applyProgress(start + (target - start) * eased);
      if (elapsed < 1) frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [agentMode]);

  return (
    <span
      className={cn("voice-identity-icon relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      data-agent-mode={agentMode ? "true" : "false"}
      data-listening={agentMode && listening ? "true" : undefined}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="voice-identity-svg absolute inset-0 overflow-visible"
        aria-hidden="true"
      >
        <g className="voice-identity-construction">
          <path
            ref={shellRef}
            className="voice-identity-morph-shell"
            d={renderedMorph.shell}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={leftBarRef}
            className="voice-identity-morph-bar voice-identity-morph-bar-left"
            d={renderedMorph.leftBar}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={centerBarRef}
            className="voice-identity-morph-bar voice-identity-morph-bar-center"
            d={renderedMorph.centerBar}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={rightBarRef}
            className="voice-identity-morph-bar voice-identity-morph-bar-right"
            d={renderedMorph.rightBar}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={sparkCrossRef}
            className="voice-identity-morph-spark"
            d={renderedMorph.sparkCross}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.sparkOpacity }}
          />
        </g>
        <g
          ref={agentRef}
          className="voice-identity-final-agent"
          style={{ opacity: renderedMorph.agentOpacity }}
        >
          <defs>
            <linearGradient id={`${gradientId}-tile`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={AGENT_RING_MARK.tile.from} />
              <stop offset="1" stopColor={AGENT_RING_MARK.tile.to} />
            </linearGradient>
            <radialGradient id={`${gradientId}-glow`} cx="0.5" cy="0.5" r="0.5">
              <stop
                offset="0"
                stopColor={AGENT_RING_MARK.glow.color}
                stopOpacity={AGENT_RING_MARK.glow.opacity}
              />
              <stop offset="1" stopColor={AGENT_RING_MARK.glow.color} stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect
            width={AGENT_RING_MARK.tile.size}
            height={AGENT_RING_MARK.tile.size}
            rx={AGENT_RING_MARK.tile.radius}
            fill={`url(#${gradientId}-tile)`}
          />
          <circle
            className="agent-ring-glow"
            cx="12"
            cy="12"
            r={AGENT_RING_MARK.glow.r}
            fill={`url(#${gradientId}-glow)`}
          />
          <circle
            className="agent-ring agent-ring-outer"
            cx="12"
            cy="12"
            r={AGENT_RING_MARK.outerRing.r}
            fill="none"
            stroke="#fff"
            strokeOpacity={AGENT_RING_MARK.outerRing.opacity}
            strokeWidth={AGENT_RING_MARK.outerRing.strokeWidth}
          />
          <circle
            className="agent-ring agent-ring-inner"
            cx="12"
            cy="12"
            r={AGENT_RING_MARK.innerRing.r}
            fill="none"
            stroke="#fff"
            strokeOpacity={AGENT_RING_MARK.innerRing.opacity}
            strokeWidth={AGENT_RING_MARK.innerRing.strokeWidth}
          />
          <circle
            className="agent-ring-dot"
            cx="12"
            cy="12"
            r={AGENT_RING_MARK.dot.r}
            fill="#fff"
          />
        </g>
      </svg>
    </span>
  );
}
