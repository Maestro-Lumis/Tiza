const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;

/** Подгоняет холст под размер окна с учётом плотности пикселей экрана. */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw(): void {
  ctx.fillStyle = '#f6f1e5';
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}

window.addEventListener('resize', resize);
resize();
