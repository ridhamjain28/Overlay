import React from "react";

// Overlay's own mark: a sound wave whose last beat becomes a floating answer
// card (voice in, answer out). Generated from src/assets/logo.svg.
const BARS_PATH =
  "M168 392H168A36 36 0 0 1 204 428V516A36 36 0 0 1 168 552H168A36 36 0 0 1 132 516V428A36 36 0 0 1 168 392ZM272 296H272A36 36 0 0 1 308 332V612A36 36 0 0 1 272 648H272A36 36 0 0 1 236 612V332A36 36 0 0 1 272 296Z";
// Card + tail, with the answer lines and typing caret cut out (nonzero fill).
const CARD_PATH =
  "M428 256H796A76 76 0 0 1 872 332V596A76 76 0 0 1 796 672H428A76 76 0 0 1 352 596V332A76 76 0 0 1 428 256ZM352 560H452V672H508L378 768A16 16 0 0 1 352 756ZM462 368A26 26 0 0 0 436 394V394A26 26 0 0 0 462 420H730A26 26 0 0 0 756 394V394A26 26 0 0 0 730 368ZM462 484A26 26 0 0 0 436 510V510A26 26 0 0 0 462 536H594A26 26 0 0 0 620 510V510A26 26 0 0 0 594 484ZM674 462A18 18 0 0 0 656 480V540A18 18 0 0 0 674 558H674A18 18 0 0 0 692 540V480A18 18 0 0 0 674 462Z";

interface MarkProps {
  className?: string;
  size?: number;
  title?: string;
}

/** One-colour glyph that follows `currentColor`. */
export function OverlayGlyph({ className, size, title }: MarkProps) {
  return (
    <svg
      viewBox="102 112 800 800"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={BARS_PATH} fill="currentColor" fillOpacity={0.7} />
      <path d={CARD_PATH} fill="currentColor" />
    </svg>
  );
}

/** Full-colour app logo: the glyph on the maroon tile. */
export function OverlayLogo({ className, size, title = "Overlay" }: MarkProps) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
    >
      <rect width="1024" height="1024" rx="232" fill="#800020" />
      <path d={BARS_PATH} fill="#FBF3EE" fillOpacity={0.7} />
      <path d={CARD_PATH} fill="#FBF3EE" />
    </svg>
  );
}
