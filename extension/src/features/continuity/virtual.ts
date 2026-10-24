export const DAY_HEIGHT = 28,
  HISTORY_HEIGHT = 44;
export function virtualWindow(
  heights: number[],
  scroll: number,
  viewport: number,
  overscan = 5,
) {
  let offset = 0,
    start = 0;
  while (start < heights.length && offset + heights[start] <= scroll)
    offset += heights[start++];
  start = Math.max(0, start - overscan);
  const top = heights.slice(0, start).reduce((a, b) => a + b, 0);
  let end = start,
    bottom = top;
  while (end < heights.length && bottom < scroll + viewport)
    bottom += heights[end++];
  end = Math.min(heights.length, end + overscan);
  return { start, end, top, total: heights.reduce((a, b) => a + b, 0) };
}
