export function editDistance(left: string, right: string, maxLength?: number): number {
  const boundedLeft = maxLength === undefined ? left : left.slice(0, maxLength);
  const boundedRight = maxLength === undefined ? right : right.slice(0, maxLength);
  const previous = Array.from({ length: boundedRight.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= boundedLeft.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= boundedRight.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const cost = boundedLeft[leftIndex - 1] === boundedRight[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        (previous[rightIndex - 1] ?? 0) + 1,
        above + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[boundedRight.length] ?? 0;
}
