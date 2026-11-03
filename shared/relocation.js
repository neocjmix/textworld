export const insideRelocation = (point, relocation) => {
  const b = relocation.bounds;
  return point && point.x >= b.x && point.x < b.x + b.cols && point.y >= b.y && point.y < b.y + b.rows;
};
export const translatePoint = (point, relocation) => ({ ...point, x: point.x + relocation.dx, y: point.y + relocation.dy });
export const trailFits = (trail, relocation) => trail.every(step => insideRelocation(step.from, relocation) && insideRelocation(step.to, relocation));
export const translateTrail = (trail, relocation) => trail.map(step => ({ ...step,
  from: translatePoint(step.from, relocation), to: translatePoint(step.to, relocation) }));
export const writingFits = (writing, relocation) => writing.lineStartX >= relocation.bounds.x
  && writing.lineStartX < relocation.bounds.x + relocation.bounds.cols && trailFits(writing.trail, relocation);
export function relocateWriting(writing, relocation) {
  writing.lineStartX += relocation.dx;
  writing.trail = translateTrail(writing.trail, relocation);
}
