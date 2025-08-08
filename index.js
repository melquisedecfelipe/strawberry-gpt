/**
 * Flappy Strawberry — vanilla Canvas 2D implementation
 *
 * Controls: tap/click or press Space/ArrowUp/W to flap.
 * Audio is initialized lazily on first user interaction.
 */

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Canvas element #game not found or is not a <canvas>');
}
// On-screen context (only composites the low-res buffer → upscaled without smoothing)
const screenCtx = canvas.getContext('2d');
if (!screenCtx) {
  throw new Error('2D rendering context not available for on-screen canvas');
}

// Offscreen low-res buffer for pixel-art look
const PIXEL_SCALE = 1; // 2x upscale → buffer is half of logical resolution
const buffer = document.createElement('canvas');
const ctx = buffer.getContext('2d');
if (!ctx) {
  throw new Error('2D rendering context not available for offscreen buffer');
}

// Audio (initialized on first user interaction)
let audioCtx = null;
const PASS_SCALE = [680];
/**
 * Ensures a single AudioContext exists and is resumed if suspended.
 * No-ops on platforms without WebAudio support.
 */
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC({ latencyHint: 'interactive' });
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    // Best-effort resume; browsers may gate this behind user gestures.
    audioCtx.resume().catch(() => {});
  }
}

/**
 * Plays a short beep when the player passes a pipe.
 * @param {number} score - Current score, used to vary the tone.
 */
function playPassBeep(score) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const idx = score % PASS_SCALE.length;
  const freq = PASS_SCALE[idx];
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.07, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.14);

  // Little flourish when hitting the last step of the scale
  if (idx === PASS_SCALE.length - 1) {
    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(freq * 1.15, t + 0.04);
    gain2.gain.setValueAtTime(0, t + 0.04);
    gain2.gain.linearRampToValueAtTime(0.05, t + 0.05);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc2.connect(gain2).connect(audioCtx.destination);
    osc2.start(t + 0.04);
    osc2.stop(t + 0.18);
  }
}

/** Plays a brief start chime when the game begins. */
function playStartChime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const freqs = [520, 680, 820];
  freqs.forEach((f, i) => {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, t + i * 0.08);
    g.gain.setValueAtTime(0, t + i * 0.08);
    g.gain.linearRampToValueAtTime(0.06, t + i * 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t + i * 0.08);
    osc.stop(t + i * 0.2);
  });
}

/** Plays a short descending tone on game over. */
function playGameOverFx() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(600, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.4);
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.46);
}

// Logical resolution (game units). The canvas will be scaled via CSS.
const GAME_WIDTH = 360; // narrow, mobile-first
const GAME_HEIGHT = 640; // 9:16 aspect

// Configure the canvas/backing stores
/**
 * Sets the backing store size based on device pixel ratio
 * while keeping logical coordinates at GAME_WIDTH x GAME_HEIGHT.
 */
function setupCanvasResolution() {
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.width = GAME_WIDTH * dpr;
  canvas.height = GAME_HEIGHT * dpr;
  screenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  screenCtx.imageSmoothingEnabled = false;
}

/** Configures the low-res offscreen buffer used for a pixel-art look. */
function setupPixelBuffer() {
  buffer.width = Math.floor(GAME_WIDTH / PIXEL_SCALE);
  buffer.height = Math.floor(GAME_HEIGHT / PIXEL_SCALE);
  ctx.imageSmoothingEnabled = false;
  // Use a fixed scale so all drawing code keeps using logical game units
  ctx.setTransform(1 / PIXEL_SCALE, 0, 0, 1 / PIXEL_SCALE, 0, 0);
}

setupCanvasResolution();
setupPixelBuffer();
// Schedule resize work to the next animation frame to avoid jank on rapid resizes.
let resizeScheduled = false;
window.addEventListener('resize', () => {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    setupCanvasResolution();
    setupPixelBuffer();
    resizeScheduled = false;
  });
}, { passive: true });

// Game state
const STORAGE_KEYS = { best: 'flappy_strawberry_best' };

/**
 * Safely reads the best score from localStorage.
 * @returns {number}
 */
function readBestScore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.best);
    const parsed = raw == null ? 0 : Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Best-effort write of best score to localStorage. Swallows quota/access errors.
 * @param {number} value
 */
function writeBestScore(value) {
  try {
    localStorage.setItem(STORAGE_KEYS.best, String(value));
  } catch {}
}

const state = {
  started: false,
  gameOver: false,
  score: 0,
  best: readBestScore(),
  /** Whether this run has surpassed the stored best at least once. */
  newBestAchieved: false,
};

// Strawberry (the player)
const strawberry = {
  x: 80,
  y: GAME_HEIGHT / 2,
  radius: 18,
  vy: 0,
  rotation: 0,
};

// Physics
// Values in pixels per second (px/s) and px/s^2
const gravity = 1800; // downward acceleration
const flapImpulse = -420; // upward instant velocity when flapping
const terminalVelDown = 600; // clamp downward speed
const terminalVelUp = -700; // clamp upward speed

// Pipes (obstacles)
const pipes = [];
const pipeGap = 160; // vertical gap between top and bottom (slightly easier)
const pipeWidth = 56;
const pipeSpacing = 240; // distance between pipes on x axis
const pipeSpeed = 125; // scroll speed (px/s) ~25% faster

// Ground line for visual reference
const groundHeight = 72;
// Background parallax layers speeds (px/s)
const parallax = {
  stars: 10,
  hills: 20,
  clouds: 35,
  bushes: 60,
};

let bgOffset = { stars: 0, hills: 0, clouds: 0, bushes: 0 };

// Controls
/** Handles a single flap input depending on the current game state. */
function flap() {
  ensureAudio();
  if (!state.started) {
    startGame();
    return;
  }
  if (state.gameOver) {
    resetGame();
    return;
  }
  strawberry.vy = flapImpulse;
}

window.addEventListener('pointerdown', flap, { passive: true });
window.addEventListener('keydown', (e) => {
  ensureAudio();
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    flap();
  }
}, { passive: false });

// Game loop timing
let lastTime = 0;
function loop(ts) {
  const dt = Math.min(32, ts - lastTime);
  lastTime = ts;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/** Resets state to begin a new game run and seeds initial pipes. */
function startGame() {
  state.started = true;
  state.gameOver = false;
  state.score = 0;
  strawberry.y = GAME_HEIGHT / 2;
  strawberry.vy = 0;
  pipes.length = 0;
  // Seed initial pipes to the right
  let x = GAME_WIDTH + 120;
  for (let i = 0; i < 4; i++) {
    pipes.push(generatePipeAtX(x));
    x += pipeSpacing;
  }
  playStartChime();
}

/** Resets state to the idle pre-start screen. */
function resetGame() {
  state.started = false;
  state.gameOver = false;
  state.score = 0;
  state.newBestAchieved = false;
  strawberry.y = GAME_HEIGHT / 2;
  strawberry.vy = 0;
  pipes.length = 0;
}

/**
 * Creates a new pipe pair at the provided world x position.
 * @param {number} x
 * @returns {{x:number,width:number,topHeight:number,passed:boolean,styleTop:string,styleBottom:string}}
 */
function generatePipeAtX(x) {
  // Random top segment height, keeping reasonable margins
  const margin = 40;
  const topHeight = Math.floor(
    margin + Math.random() * (GAME_HEIGHT - groundHeight - pipeGap - margin * 2)
  );
  // Theme: Copilot (top) vs Sonnet (bottom)
  const styleTop = 'Copilot';
  const styleBottom = 'Sonnet';
  return {
    x,
    width: pipeWidth,
    topHeight,
    passed: false, // for scoring
    styleTop,
    styleBottom,
  };
}

/**
 * Advances the simulation by dt milliseconds (frame independent).
 * Handles physics, spawning, scoring and collision detection.
 * @param {number} dt - Delta time in ms.
 */
function update(dt) {
  if (!state.started || state.gameOver) return;

  // dt in seconds for framerate-independent movement
  const dtS = dt / 1000;

  // Apply gravity and integrate with clamped velocities
  strawberry.vy += gravity * dtS;
  if (strawberry.vy > terminalVelDown) strawberry.vy = terminalVelDown;
  if (strawberry.vy < terminalVelUp) strawberry.vy = terminalVelUp;
  strawberry.y += strawberry.vy * dtS;

  // Smooth rotation toward a target based on velocity
  const targetRot = Math.min(0.45, Math.max(-0.6, strawberry.vy / 600));
  const rotLerp = Math.min(1, dtS * 10); // responsive but smooth
  strawberry.rotation += (targetRot - strawberry.rotation) * rotLerp;

  // Ground and ceiling collision
  if (strawberry.y + strawberry.radius > GAME_HEIGHT - groundHeight) {
    strawberry.y = GAME_HEIGHT - groundHeight - strawberry.radius;
    die();
  }
  if (strawberry.y - strawberry.radius < 0) {
    strawberry.y = strawberry.radius;
    strawberry.vy = 0; // prevent clipping
  }

  // Move pipes
  for (const pipe of pipes) {
    pipe.x -= pipeSpeed * dtS;
  }

  // Parallax offsets
  // Advance offsets continuously; wrap only when drawing to avoid visible jumps
  bgOffset.stars += parallax.stars * dtS;
  bgOffset.hills += parallax.hills * dtS;
  bgOffset.clouds += parallax.clouds * dtS;
  bgOffset.bushes += parallax.bushes * dtS;

  // Spawn new pipes and remove offscreen
  const first = pipes[0];
  if (first && first.x + pipeWidth < -10) {
    pipes.shift();
  }
  const last = pipes[pipes.length - 1];
  if (last && last.x < GAME_WIDTH - pipeSpacing) {
    pipes.push(generatePipeAtX(last.x + pipeSpacing));
  }

  // Scoring and collisions
  for (const pipe of pipes) {
    // Score when passing pipe center
    if (!pipe.passed && strawberry.x > pipe.x + pipe.width) {
      pipe.passed = true;
      state.score += 1;
      playPassBeep(state.score);
      if (state.score > state.best) {
        state.newBestAchieved = true;
        state.best = state.score;
        writeBestScore(state.best);
      }
    }

    // Collision: circle vs axis-aligned rectangles (top and bottom segments)
    if (circleRectCollision(strawberry.x, strawberry.y, strawberry.radius, pipe.x, 0, pipe.width, pipe.topHeight)) {
      die();
    }
    const bottomY = pipe.topHeight + pipeGap;
    const bottomHeight = GAME_HEIGHT - groundHeight - bottomY;
    if (circleRectCollision(strawberry.x, strawberry.y, strawberry.radius, pipe.x, bottomY, pipe.width, bottomHeight)) {
      die();
    }
  }
}

/** Flags the current run as over and plays a sound effect. */
function die() {
  state.gameOver = true;
  playGameOverFx();
}

/**
 * Circle vs axis-aligned rectangle collision test.
 * @param {number} cx
 * @param {number} cy
 * @param {number} cr
 * @param {number} rx
 * @param {number} ry
 * @param {number} rw
 * @param {number} rh
 * @returns {boolean}
 */
function circleRectCollision(cx, cy, cr, rx, ry, rw, rh) {
  const nearestX = Math.max(rx, Math.min(cx, rx + rw));
  const nearestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy <= cr * cr;
}

// Drawing helpers
function drawBackground() {
  const groundY = GAME_HEIGHT - groundHeight;

  // Sky gradient banding (subtle stripes)
  for (let y = 0; y < groundY; y += 8) {
    const shade = 16 + Math.floor((y / groundY) * 8);
    ctx.fillStyle = `rgb(${shade}, ${shade + 1}, ${shade + 6})`;
    ctx.fillRect(0, y, GAME_WIDTH, 8);
  }

  // Stars layer (tiny squares)
  ctx.fillStyle = '#cbd5e1';
  const starsStep = 32;
  const starsOffset = Math.round(bgOffset.stars % starsStep);
  for (let x = -GAME_WIDTH; x < GAME_WIDTH * 2; x += starsStep) {
    const px = Math.round(x - starsOffset);
    const py = 8 + ((x * 17) % (groundY - 120));
    if (py < groundY - 120) ctx.fillRect(px, py, 2, 2);
  }

  // Hills layer
  ctx.fillStyle = '#0f2b2b';
  const hillY = groundY - 40;
  const hillsStep = 80;
  const hillsOffset = Math.round(bgOffset.hills % hillsStep);
  for (let x = -GAME_WIDTH; x < GAME_WIDTH * 2; x += hillsStep) {
    const px = Math.round(x - hillsOffset);
    ctx.fillRect(px, hillY, 60, 40);
  }

  // Clouds (blocky)
  ctx.fillStyle = '#1f2937';
  const cloudsStep = 120;
  const cloudsOffset = Math.round(bgOffset.clouds % cloudsStep);
  for (let x = -GAME_WIDTH; x < GAME_WIDTH * 2; x += cloudsStep) {
    const px = Math.round(x - cloudsOffset);
    const base = 60 + ((x * 13) % 60);
    ctx.fillRect(px, base, 40, 10);
    ctx.fillRect(px + 16, base - 8, 32, 10);
    ctx.fillRect(px + 28, base + 8, 28, 10);
  }

  // Ground
  ctx.fillStyle = '#0c0f18';
  ctx.fillRect(0, groundY, GAME_WIDTH, groundHeight);

  // Foreground bushes
  ctx.fillStyle = '#064e3b';
  const bushesStep = 64;
  const bushesOffset = Math.round(bgOffset.bushes % bushesStep);
  for (let x = -GAME_WIDTH; x < GAME_WIDTH * 2; x += bushesStep) {
    const px = Math.round(x - bushesOffset);
    const by = groundY - 12;
    ctx.fillRect(px, by, 24, 12);
    ctx.fillRect(px + 12, by - 8, 24, 12);
    ctx.fillRect(px + 24, by, 24, 12);
  }

  // Horizon line
  ctx.fillStyle = '#0f1220';
  ctx.fillRect(0, groundY - 2, GAME_WIDTH, 2);
}

function drawCopilotRect(x, y, w, h) {
  // Copilot block: purple panel with stripes and label
  ctx.fillStyle = '#1d1147';
  ctx.fillRect(x, y, w, h);
  // stripes
  ctx.fillStyle = '#4c1d95';
  for (let yy = y + 10; yy < y + h - 6; yy += 12) {
    ctx.fillRect(x + 4, yy, w - 8, 3);
  }
  // header
  ctx.fillStyle = '#6d28d9';
  ctx.fillRect(x, y, w, 8);
  // label
  ctx.fillStyle = '#e7e8ea';
  ctx.font = 'bold 10px Silkscreen, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('COPILOT', Math.round(x + w / 2), Math.round(y + Math.min(h - 10, 14)));
  // border
  ctx.fillStyle = '#2a1566';
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
}

function drawSonnetRect(x, y, w, h) {
  // Sonnet block: amber/orange panel with a sieve pattern and label
  ctx.fillStyle = '#3a1d09';
  ctx.fillRect(x, y, w, h);
  // sieve dots
  ctx.fillStyle = '#d97706';
  for (let yy = y + 8; yy < y + h - 10; yy += 12) {
    for (let xx = x + 6; xx < x + w - 6; xx += 12) {
      ctx.fillRect(xx, yy, 2, 2);
    }
  }
  // footer
  ctx.fillStyle = '#b45309';
  ctx.fillRect(x, y + h - 8, w, 8);
  // label
  ctx.fillStyle = '#e7e8ea';
  ctx.font = 'bold 10px Silkscreen, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SONNET', Math.round(x + w / 2), Math.round(y + h - 14));
  // border
  ctx.fillStyle = '#4a240c';
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
}

function drawPipes() {
  for (const pipe of pipes) {
    // Quantize to pixel grid
    const px = Math.round(pipe.x);
    // Top obstacle: Copilot
    if (pipe.styleTop === 'Copilot') {
      drawCopilotRect(px, 0, pipe.width, pipe.topHeight);
    } else {
      drawSonnetRect(px, 0, pipe.width, pipe.topHeight);
    }
    // Bottom pipe
    const bottomY = pipe.topHeight + pipeGap;
    const bottomHeight = GAME_HEIGHT - groundHeight - bottomY;
    // Bottom obstacle: Sonnet
    if (pipe.styleBottom === 'Sonnet') {
      drawSonnetRect(px, bottomY, pipe.width, bottomHeight);
    } else {
      drawCopilotRect(px, bottomY, pipe.width, bottomHeight);
    }
  }
}

/**
 * Renders the strawberry at the given position and radius.
 * Rotation comes from `strawberry.rotation`.
 * @param {number} x
 * @param {number} y
 * @param {number} r
 */
function drawStrawberry(x, y, r) {
  // Minimal strawberry using vector drawing, no external image dependency
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(strawberry.rotation);

  // Body with outline
  const bodyGradient = ctx.createRadialGradient(0, -r * 0.2, r * 0.3, 0, 0, r);
  bodyGradient.addColorStop(0, '#ff7087');
  bodyGradient.addColorStop(1, '#ff2f67');
  ctx.fillStyle = bodyGradient;
  ctx.strokeStyle = '#0b0d12';
  ctx.lineWidth = Math.max(2, r * 0.12);

  ctx.beginPath();
  // heart-like strawberry body
  ctx.moveTo(0, -r);
  ctx.bezierCurveTo(r, -r * 1.2, r * 1.2, -r * 0.2, 0, r);
  ctx.bezierCurveTo(-r * 1.2, -r * 0.2, -r, -r * 1.2, 0, -r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Seeds (pixel squares)
  ctx.fillStyle = '#ffe08a';
  const seedSize = Math.max(2, Math.round(r * 0.18));
  for (let i = -2; i <= 2; i++) {
    for (let j = -1; j <= 1; j++) {
      const sx = Math.round(i * r * 0.36 + (j % 2 === 0 ? r * 0.16 : 0));
      const sy = Math.round(j * r * 0.34 + r * 0.12);
      ctx.fillRect(sx - seedSize / 2, sy - seedSize / 2, seedSize, seedSize);
    }
  }

  // Leaves (pixel triangles)
  ctx.fillStyle = '#22c55e';
  const leafLen = Math.round(r * 0.9);
  for (let k = 0; k < 4; k++) {
    const angle = (k * Math.PI * 2) / 4;
    const lx = Math.round(Math.cos(angle) * r * 0.4);
    const ly = Math.round(-r + Math.sin(angle) * r * 0.2 - r * 0.2);
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(lx + Math.round(Math.cos(angle) * leafLen * 0.5), ly + Math.round(Math.sin(angle) * leafLen * 0.5));
    ctx.lineTo(lx + Math.round(Math.cos(angle + 0.6) * leafLen * 0.3), ly + Math.round(Math.sin(angle + 0.6) * leafLen * 0.3));
    ctx.closePath();
    ctx.fill();
  }

  // No face — keep it clean/minimal

  ctx.restore();
}

/**
 * Measures the width of a stylized number rendered as `major,minor`.
 * @param {number|string} value
 * @param {number} majorPx
 * @param {number} minorPx
 * @returns {number}
 */
function scoreNumber(value, majorPx, minorPx) {
  const major = String(value);
  const minor = '00';
  ctx.font = `bold ${majorPx}px Silkscreen, monospace`;
  const wMajor = ctx.measureText(major).width;
  ctx.font = `bold ${minorPx}px Silkscreen, monospace`;
  const wComma = ctx.measureText(',').width;
  const wMinor = ctx.measureText(minor).width;
  return wMajor + wComma + wMinor;
}

/**
 * Draws a stylized number as `major,minor` with independent font sizes.
 * Returns the total drawn width.
 * @param {number|string} value
 * @param {number} x
 * @param {number} y
 * @param {number} majorPx
 * @param {number} minorPx
 * @param {'left'|'center'|'right'} [align]
 * @param {string} [color]
 * @returns {number}
 */
function drawScoreNumber(value, x, y, majorPx, minorPx, align = 'left', color = '#e7e8ea') {
  const major = String(value);
  const minor = '00';
  // Measure
  const totalW = scoreNumber(value, majorPx, minorPx);
  let startX = x;
  if (align === 'center') startX = Math.round(x - totalW / 2);
  if (align === 'right') startX = Math.round(x - totalW);

  // Positions
  const baselineYMajor = Math.round(y);
  const baselineYMinor = Math.round(y - (majorPx - minorPx) + 2);

  // Draw major
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `bold ${majorPx}px Silkscreen, monospace`;
  ctx.fillText(major, startX, baselineYMajor);
  const wMajor = ctx.measureText(major).width;

  // Draw comma + minor
  ctx.font = `bold ${minorPx}px Silkscreen, monospace`;
  ctx.fillText(',', startX + wMajor, baselineYMinor);
  const wComma = ctx.measureText(',').width;
  ctx.fillText(minor, startX + wMajor + wComma, baselineYMinor);

  return totalW;
}

function measureTextWithFont(text, px) {
  ctx.font = `bold ${px}px Silkscreen, monospace`;
  return ctx.measureText(String(text)).width;
}

function drawHud() {
  // Centered: "score/best" with score bigger
  const scorePx = 36;
  const bestPx = 18;
  const slashPx = 18;
  const gap = 6;
  const slash = '/';

  const wScore = Math.ceil(measureTextWithFont(state.score, scorePx));
  const wSlash = Math.ceil(measureTextWithFont(slash, slashPx));
  const wBest = Math.ceil(measureTextWithFont(state.best, bestPx));
  const paddingX = 16;
  const totalW = wScore + gap + wSlash + gap + wBest + paddingX * 2;
  const rectX = Math.round(GAME_WIDTH / 2 - totalW / 2);
  const rectY = 24;
  const rectH = 54;
  const rectW = Math.round(totalW);

  // Background plate
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(rectX, rectY, rectW, rectH);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(rectX, rectY, rectW, rectH);

  // Baselines aligned to look like promo: smaller items slightly higher
  const baseY = rectY + 38;
  const baselineFor = (px) => Math.round(baseY - (scorePx - px) * 0.55);

  // Draw score
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let cursorX = rectX + paddingX;
  // Gold when current score surpasses best at least once in this run
  ctx.fillStyle = state.newBestAchieved ? '#facc15' : '#e7e8ea';
  ctx.font = `bold ${scorePx}px Silkscreen, monospace`;
  ctx.fillText(String(state.score), cursorX, baseY);
  cursorX += wScore + gap;

  // Draw slash
  ctx.fillStyle = '#9aa0a6';
  ctx.font = `bold ${slashPx}px Silkscreen, monospace`;
  ctx.fillText(slash, cursorX, baselineFor(slashPx));
  cursorX += wSlash + gap;

  // Draw best (smaller)
  ctx.font = `bold ${bestPx}px Silkscreen, monospace`;
  ctx.fillText(String(state.best), cursorX, baselineFor(bestPx));

  if (!state.started) {
    drawCenterMessage(['Toque para começar']);
  } else if (state.gameOver) {
    drawCenterMessage(['GAME OVER', 'Toque para reiniciar']);
  }
}

/**
 * Draws a centered, multi-line message panel above the playfield.
 * @param {string|string[]} lines
 */
function drawCenterMessage(lines) {
  const safeLines = Array.isArray(lines) ? lines : [String(lines)];
  const paddingX = 16;
  const paddingY = 12;
  const lineHeight = 22;
  ctx.font = 'bold 16px Silkscreen, monospace';
  let maxW = 0;
  for (const l of safeLines) {
    const w = ctx.measureText(l).width;
    if (w > maxW) maxW = w;
  }
  const w = Math.round(maxW + paddingX * 2);
  const h = Math.round(safeLines.length * lineHeight + paddingY * 2);
  const x = Math.round((GAME_WIDTH - w) / 2);
  const y = Math.round(GAME_HEIGHT * 0.28);

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#e7e8ea';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < safeLines.length; i++) {
    ctx.fillText(safeLines[i], GAME_WIDTH / 2, y + paddingY + i * lineHeight + lineHeight / 2);
  }
}

/** Performs a full frame render: background, pipes, player, HUD and composite. */
function draw() {
  // Clear buffer at native resolution (ignore current transform)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, buffer.width, buffer.height);
  ctx.restore();

  drawBackground();
  drawPipes();
  drawStrawberry(strawberry.x, strawberry.y, strawberry.radius);
  drawHud();

  // Composite buffer → screen (no smoothing → pixel-art upscale)
  screenCtx.save();
  screenCtx.imageSmoothingEnabled = false;
  screenCtx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  screenCtx.drawImage(buffer, 0, 0, GAME_WIDTH, GAME_HEIGHT);
  screenCtx.restore();
}
