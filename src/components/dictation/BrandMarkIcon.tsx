import React from "react";
import { OverlayGlyph } from "../OverlayMark";

interface BrandMarkIconProps {
  size?: number;
  className?: string;
}

/**
 * Overlay brand mark (sound wave into answer card). Draws in `currentColor` so
 * it follows the neutral foreground treatment of the surface that contains it.
 */
export function BrandMarkIcon({ size = 24, className }: BrandMarkIconProps) {
  return <OverlayGlyph size={size} className={className} />;
}
