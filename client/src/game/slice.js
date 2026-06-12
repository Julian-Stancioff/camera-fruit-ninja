// Slice geometry + speed gate (screen-pixel space).

/** Closest-point line-segment vs circle test. (x0,y0)->(x1,y1) vs circle (cx,cy,r). */
export function segmentHitsCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + t * dx, py = y0 + t * dy;
  const ddx = px - cx, ddy = py - cy;
  return ddx * ddx + ddy * ddy <= r * r;
}

/** Fingertip speed in px/s between two samples. */
export function bladeSpeed(prev, curr, dtMs) {
  if (!prev || !curr || dtMs <= 0) return 0;
  const dx = curr.x - prev.x, dy = curr.y - prev.y;
  return (Math.hypot(dx, dy) / dtMs) * 1000;
}
