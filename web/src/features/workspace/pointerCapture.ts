export function watchPointerCapture(target: Element, pointer: number, stillDragging: () => boolean, onLost: () => void) {
  const frame = () => {
    if (!stillDragging()) return;
    if (target.hasPointerCapture(pointer)) requestAnimationFrame(frame);
    else onLost();
  };
  requestAnimationFrame(frame);
}
