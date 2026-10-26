const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
const instances = new Map();

function createPoints(count) {
  const points = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points.push({ x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius, seed: Math.random() });
  }
  return points;
}

function project(point, angleX, angleY, radius, centerX, centerY) {
  const cosY = Math.cos(angleY);
  const sinY = Math.sin(angleY);
  const cosX = Math.cos(angleX);
  const sinX = Math.sin(angleX);
  const x1 = point.x * cosY - point.z * sinY;
  const z1 = point.x * sinY + point.z * cosY;
  const y1 = point.y * cosX - z1 * sinX;
  const z2 = point.y * sinX + z1 * cosX;
  const perspective = 2.7 / (2.7 + z2 * 0.55);
  return {
    x: centerX + x1 * radius * perspective,
    y: centerY + y1 * radius * perspective,
    z: z2,
    scale: perspective,
  };
}

function draw(canvas, state, time) {
  const ctx = canvas.getContext('2d');
  const { width, height } = state;
  ctx.clearRect(0, 0, width, height);
  if (!width || !height) return;

  const dpr = state.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const compact = width < 520;
  const radius = Math.min(width, height) * (compact ? 0.31 : 0.29);
  const centerX = width * (compact ? 0.5 : 0.56) + state.pointerX * 12;
  const centerY = height * 0.48 + state.pointerY * 10;
  const t = prefersReducedMotion ? 0.7 : time * 0.00018;
  const angleY = t * 1.1 + state.pointerX * 0.35;
  const angleX = -0.28 + Math.sin(t * 0.8) * 0.08 + state.pointerY * 0.2;

  const halo = ctx.createRadialGradient(centerX, centerY, radius * 0.1, centerX, centerY, radius * 1.75);
  halo.addColorStop(0, 'rgba(255,138,46,.18)');
  halo.addColorStop(0.35, 'rgba(21,94,239,.15)');
  halo.addColorStop(0.7, 'rgba(21,94,239,.05)');
  halo.addColorStop(1, 'rgba(8,16,32,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  const core = ctx.createRadialGradient(
    centerX - radius * 0.14,
    centerY - radius * 0.18,
    radius * 0.02,
    centerX,
    centerY,
    radius * 0.72
  );
  core.addColorStop(0, 'rgba(255,246,232,.95)');
  core.addColorStop(0.16, 'rgba(255,150,70,.78)');
  core.addColorStop(0.48, 'rgba(55,115,255,.36)');
  core.addColorStop(1, 'rgba(10,23,48,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.74, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(-0.18);
  const rings = [
    { r: radius * 1.34, squash: 0.32, color: 'rgba(255,154,80,.42)', speed: 0.55, width: 1.1 },
    { r: radius * 1.12, squash: 0.52, color: 'rgba(112,164,255,.4)', speed: -0.42, width: 1 },
    { r: radius * 0.92, squash: 0.2, color: 'rgba(255,198,132,.34)', speed: 0.3, width: 0.9 },
  ];
  for (const ring of rings) {
    ctx.beginPath();
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = ring.width;
    const segments = 96;
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2 + t * ring.speed;
      const x = Math.cos(a) * ring.r;
      const y = Math.sin(a) * ring.r * ring.squash;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();

  const points = state.points;
  const projected = points.map((point) => project(point, angleX, angleY, radius, centerX, centerY));
  projected.sort((a, b) => a.z - b.z);

  for (let i = 0; i < projected.length; i += 1) {
    const p = projected[i];
    const point = points[i];
    const front = (1 - p.z) / 2;
    const alpha = 0.12 + front * 0.72;
    const size = (0.7 + front * 1.8) * p.scale;
    const mint = point.seed > 0.62;
    ctx.fillStyle = mint
      ? `rgba(255,171,98,${alpha})`
      : `rgba(134,177,255,${alpha * 0.95})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  const satelliteAngle = t * 2.4 + 1.1;
  const satX = centerX + Math.cos(satelliteAngle) * radius * 1.34;
  const satY = centerY + Math.sin(satelliteAngle) * radius * 1.34 * 0.32;
  ctx.fillStyle = 'rgba(255,247,236,.98)';
  ctx.shadowColor = 'rgba(255,138,46,.9)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(satX, satY, 2.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

function setup(canvas) {
  if (!canvas || instances.has(canvas)) return instances.get(canvas);
  const state = {
    canvas,
    ctx: canvas.getContext('2d'),
    width: 0,
    height: 0,
    dpr: Math.min(2, window.devicePixelRatio || 1),
    points: createPoints(prefersReducedMotion ? 280 : 540),
    pointerX: 0,
    pointerY: 0,
    visible: true,
    raf: 0,
    start: performance.now(),
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    if (prefersReducedMotion) draw(canvas, state, state.start);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const visibleObserver = new IntersectionObserver(
    (entries) => {
      state.visible = entries.some((entry) => entry.isIntersecting);
      if (state.visible && !state.raf) loop(state.start);
    },
    { threshold: 0.02 }
  );
  visibleObserver.observe(canvas);

  window.addEventListener(
    'pointermove',
    (event) => {
      state.pointerX = (event.clientX / window.innerWidth - 0.5) * 2;
      state.pointerY = (event.clientY / window.innerHeight - 0.5) * 2;
      if (prefersReducedMotion) draw(canvas, state, state.start);
    },
    { passive: true }
  );

  function loop(now) {
    state.raf = 0;
    if (!state.visible) return;
    draw(canvas, state, now - state.start);
    if (!prefersReducedMotion) state.raf = requestAnimationFrame(loop);
  }

  const instance = {
    redraw: () => draw(canvas, state, performance.now() - state.start),
    destroy: () => {
      observer.disconnect();
      visibleObserver.disconnect();
      if (state.raf) cancelAnimationFrame(state.raf);
      instances.delete(canvas);
    },
  };
  instances.set(canvas, instance);
  if (prefersReducedMotion) draw(canvas, state, state.start);
  else loop(state.start);
  return instance;
}

export function initScene(canvasOrId) {
  const canvas = typeof canvasOrId === 'string' ? document.getElementById(canvasOrId) : canvasOrId;
  return setup(canvas);
}

export function initAllScenes() {
  document.querySelectorAll('canvas.auth-scene, canvas.hero-scene').forEach((canvas) => setup(canvas));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAllScenes, { once: true });
} else {
  initAllScenes();
}

window.NoxScene = { init: initScene, initAll: initAllScenes };
