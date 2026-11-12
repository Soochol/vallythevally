interface AxisText { text: string; x: number; y: number; width: number; height: number }
declare global { interface Window { axisTexts(): { width: number; texts: AxisText[] }[] } }

export function installAxisProbe() {
  const texts = new Map<HTMLCanvasElement, AxisText[]>();
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  const fill = CanvasRenderingContext2D.prototype.fillRect;
  const text = CanvasRenderingContext2D.prototype.fillText;

  CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
    if (x === 0 && y === 0 && width >= this.canvas.width && height >= this.canvas.height) texts.set(this.canvas, []);
    return clear.call(this, x, y, width, height);
  };
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
    if (x === 0 && y === 0 && width >= this.canvas.width && height >= this.canvas.height) texts.set(this.canvas, []);
    return fill.call(this, x, y, width, height);
  };
  CanvasRenderingContext2D.prototype.fillText = function (value, x, y, maxWidth) {
    const box = this.canvas.getBoundingClientRect();
    if (box.width > 0 && box.width <= 100 && value.trim()) {
      const ratio = this.canvas.width / box.width;
      const transform = this.getTransform();
      const metrics = this.measureText(value);
      const width = metrics.width * transform.a / ratio;
      const height = (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) * transform.d / ratio;
      const entries = texts.get(this.canvas) ?? [];
      entries.push({ text: value, x: (x * transform.a + transform.e) / ratio, y: (y * transform.d + transform.f) / ratio, width, height });
      texts.set(this.canvas, entries);
    }
    return text.call(this, value, x, y, maxWidth);
  };
  window.axisTexts = () => [...texts].filter(([canvas, entries]) => canvas.isConnected && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().width <= 100 && entries.length > 0)
    .map(([canvas, entries]) => ({ width: canvas.getBoundingClientRect().width, texts: entries }));
}
