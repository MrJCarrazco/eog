/* EMPIRE OF GODS — keyless public demo engine.
 *
 * A self-contained "living diorama": one station room, the god crew walking it on the shipped
 * sprite engine (js/assets.js SPRITES.drawBody), and a scripted banter director (data/banter.js).
 * There is NO backend, NO API key, NO network: nothing here calls fetch/XHR/WebSocket, and the
 * page's CSP (connect-src 'none') would refuse it if anything tried. Nothing is persisted.
 */
(function () {
  'use strict';

  /* ---------- config ---------- */
  var PLAY_URL = 'https://mrjcarrazco.github.io/eog';
  var PLAY_LABEL = 'mrjcarrazco.github.io/eog';
  var GITHUB_URL = 'https://github.com/MrJCarrazco/eog';          // placeholder until the public repo URL is final

  var T = 12;                                  // world tile, in world units
  var COLS = 28, ROWS = 16;
  var WW = COLS * T, WH = ROWS * T;
  var WALL_ROWS = 3;                           // top wall depth in tiles
  var SPEED = 28;                              // walk speed, world units / s (matches the full game's crew)
  var MAX_CONVOS = 2;

  var BANTER = window.EOG_BANTER;
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------- seeded RNG (?seed=N for a reproducible run) ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var seedParam = Number(new URLSearchParams(location.search).get('seed'));
  var SEED = Number.isFinite(seedParam) && seedParam ? seedParam : (Date.now() % 2147483647);
  var rand = mulberry32(SEED);
  function rnd(a, b) { return a + rand() * (b - a); }
  function pickOne(arr) { return arr[Math.floor(rand() * arr.length)]; }
  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /* shuffle-bag: every item plays once before anything repeats */
  function bag(items) {
    var q = [];
    return function next(accept) {
      for (var tries = 0; tries < 2; tries++) {
        if (!q.length) q = shuffled(items);
        for (var i = 0; i < q.length; i++) {
          if (!accept || accept(q[i])) return q.splice(i, 1)[0];
        }
        q = [];   // nothing acceptable in the remainder: refill once and retry
      }
      return null;
    };
  }

  /* ---------- station layout ---------- */
  var IMG = {};
  function img(src) {
    if (IMG[src]) return IMG[src];
    var im = new Image();
    im.decoding = 'async';
    im.src = src;
    return (IMG[src] = im);
  }
  function ok(im) { return im && im.complete && im.naturalWidth > 0; }

  /* props: x,y,w,h = floor footprint in tiles. Art is scaled to the footprint width (× fit) and
     anchored bottom-centre on it; `floor` props draw under everything and never block. */
  var PROPS = [
    { art: 'bigscreen', x: 11, y: 0, w: 6, h: 2, wall: true, fit: 1.0 },
    { art: 'core',      x: 1,  y: 3, w: 1, h: 1, fit: 1.3 },
    { art: 'core',      x: 26, y: 3, w: 1, h: 1, fit: 1.3 },
    { art: 'rack',      x: 6,  y: 3, w: 2, h: 1 },
    { art: 'tank',      x: 9,  y: 3, w: 2, h: 1 },
    { art: 'coffee',    x: 18, y: 3, w: 1, h: 1, fit: 1.4 },
    { art: 'rack',      x: 20, y: 3, w: 2, h: 1 },
    { art: 'desk',      x: 2,  y: 5, w: 3, h: 2 },
    { art: 'chair',     x: 3,  y: 7, w: 1, h: 1, fit: 1.2 },
    { art: 'desk2',     x: 23, y: 5, w: 3, h: 2 },
    { art: 'chair',     x: 24, y: 7, w: 1, h: 1, fit: 1.2 },
    { art: 'holotable', x: 11, y: 7, w: 5, h: 2 },
    { art: 'rug',       x: 3,  y: 10, w: 6, h: 4, floor: true },
    { art: 'couch',     x: 4,  y: 12, w: 4, h: 2 },
    { art: 'plant',     x: 1,  y: 13, w: 1, h: 1, fit: 1.3 },
    { art: 'bar',       x: 13, y: 13, w: 4, h: 1 },
    { art: 'jukebox',   x: 20, y: 12, w: 2, h: 2 },
    { art: 'arcade',    x: 23, y: 12, w: 2, h: 2 },
    { art: 'crate',     x: 26, y: 13, w: 1, h: 1, fit: 1.2 },
    { art: 'boxes',     x: 26, y: 11, w: 1, h: 1, fit: 1.4 },
    { art: 'plant',     x: 9,  y: 13, w: 1, h: 1, fit: 1.3 },
  ];
  PROPS.forEach(function (p) { p.im = img('assets/furniture/' + p.art + '.png'); });
  var HOLO = PROPS.filter(function (p) { return p.art === 'holotable'; })[0];
  var FLOOR = img('assets/industrial/floor.png');
  var WALL = img('assets/industrial/wall.png');

  /* walkable grid: floor is cols 1..COLS-2, rows WALL_ROWS..ROWS-2 */
  var blocked = [];
  for (var gy = 0; gy < ROWS; gy++) {
    blocked.push([]);
    for (var gx = 0; gx < COLS; gx++) blocked[gy].push(gx < 1 || gx > COLS - 2 || gy < WALL_ROWS || gy > ROWS - 2);
  }
  PROPS.forEach(function (p) {
    if (p.floor || p.wall) return;
    for (var y = p.y; y < p.y + p.h; y++) for (var x = p.x; x < p.x + p.w; x++) if (blocked[y]) blocked[y][x] = true;
  });
  function free(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS && !blocked[y][x]; }
  var FREE = [];
  for (var fy = 0; fy < ROWS; fy++) for (var fx = 0; fx < COLS; fx++) if (free(fx, fy)) FREE.push([fx, fy]);

  function tileCenter(tx, ty) { return { x: (tx + 0.5) * T, y: (ty + 0.5) * T + 3 }; }
  function tileOf(px, py) { return [Math.max(0, Math.min(COLS - 1, Math.floor(px / T))), Math.max(0, Math.min(ROWS - 1, Math.floor((py - 3) / T)))]; }

  /* BFS on the tile grid (8-way, no corner cutting) -> list of world waypoints */
  function findPath(from, to) {
    if (!free(to[0], to[1])) return null;
    var key = function (x, y) { return y * COLS + x; };
    var prev = new Map(); prev.set(key(from[0], from[1]), -1);
    var q = [from], qi = 0;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (qi < q.length) {
      var c = q[qi++];
      if (c[0] === to[0] && c[1] === to[1]) break;
      for (var i = 0; i < dirs.length; i++) {
        var nx = c[0] + dirs[i][0], ny = c[1] + dirs[i][1];
        if (!free(nx, ny) || prev.has(key(nx, ny))) continue;
        if (dirs[i][0] && dirs[i][1] && (!free(c[0] + dirs[i][0], c[1]) || !free(c[0], c[1] + dirs[i][1]))) continue;
        prev.set(key(nx, ny), key(c[0], c[1]));
        q.push([nx, ny]);
      }
    }
    if (!prev.has(key(to[0], to[1]))) return null;
    var out = [], k = key(to[0], to[1]);
    while (k !== -1) { out.push(tileCenter(k % COLS, Math.floor(k / COLS))); k = prev.get(k); }
    out.reverse();
    out.shift();   // drop the start tile: the body is already there
    return out;
  }

  /* ---------- the crew ---------- */
  var CAST = {};
  var bodies = [];
  BANTER.cast.forEach(function (c, i) {
    CAST[c.id] = c;
    DATA.AGENT[c.id] = { id: c.id, color: c.color };
    var start = pickOne(FREE);
    var p = tileCenter(start[0], start[1]);
    bodies.push({
      id: c.id, skin: c.skin, cast: c,
      px: p.x, py: p.y, dir: pickOne(['south', 'east', 'west']), state: 'idle',
      odo: 0, faceA: null, aph: rnd(0, Math.PI * 2), phase: i,
      speaking: false, path: null, idleUntil: rnd(300, 2500), pace: rnd(0.9, 1.12),
      convo: null, arrived: true, wantDir: null
    });
  });
  var byId = {};
  bodies.forEach(function (b) { byId[b.id] = b; });

  function walkTo(b, tile, faceDir) {
    var path = findPath(tileOf(b.px, b.py), tile);
    if (!path) return false;
    b.path = path; b.state = path.length ? 'walk' : 'idle'; b.arrived = !path.length; b.wantDir = faceDir || null;
    if (!path.length && faceDir) b.dir = faceDir;
    return true;
  }

  function stepBody(b, dt, now) {
    if (b.state === 'walk' && b.path && b.path.length) {
      var tgt = b.path[0];
      var dx = tgt.x - b.px, dy = tgt.y - b.py, d = Math.hypot(dx, dy);
      var step = SPEED * b.pace * dt;
      if (d <= step) {
        b.px = tgt.x; b.py = tgt.y; b.odo += d; b.path.shift();
      } else {
        b.px += dx / d * step; b.py += dy / d * step; b.odo += step;
      }
      if (d > 0.01) {
        b.faceA = Math.atan2(dy, dx);
        b.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
      }
      if (!b.path.length) {
        b.state = 'idle'; b.arrived = true; b.path = null;
        if (b.wantDir) b.dir = b.wantDir;
        b.idleUntil = now + rnd(1800, 5200);
      }
      return;
    }
    // idle wander — only when not booked into a conversation
    if (!b.convo && now >= b.idleUntil) {
      var tries = 0;
      while (tries++ < 6 && !walkTo(b, pickOne(FREE), pickOne(['south', 'south', 'east', 'west', 'north']))) {}
      if (b.state !== 'walk') b.idleUntil = now + rnd(1000, 3000);
    }
  }

  /* ---------- bubbles + comms feed ---------- */
  var bubbles = [];          // { b, text, until }
  var lastQuote = null;      // the most recent line, for the share card
  var feedList = document.getElementById('feed-list');

  function say(b, text, now) {
    var dur = Math.max(2400, Math.min(5600, 1500 + text.length * 55));
    bubbles = bubbles.filter(function (x) { return x.b !== b; });
    bubbles.push({ b: b, text: text, until: now + dur, born: now });
    b.speaking = true;
    b.speakUntil = now + dur;
    lastQuote = { id: b.id, name: b.cast.name, title: b.cast.title, color: b.cast.color, line: text };
    stats.linesSpoken++;
    var li = document.createElement('li');
    var who = document.createElement('span');
    who.className = 'who'; who.style.color = b.cast.color; who.textContent = b.cast.name.toUpperCase() + ': ';
    li.appendChild(who);
    li.appendChild(document.createTextNode(text));
    feedList.appendChild(li);
    while (feedList.children.length > 4) feedList.removeChild(feedList.firstChild);
    return dur;
  }

  /* ---------- banter director ---------- */
  var nextConvo = bag(BANTER.convos);
  var nextSolo = bag(BANTER.solo);
  var convos = [];           // active: { lines, who:[ids], i, phase:'gather'|'talk', at, deadline }
  var convoAt = 2500, soloAt = 1200;

  function participants(lines) {
    var s = [];
    lines.forEach(function (l) { if (s.indexOf(l.who) < 0) s.push(l.who); });
    return s;
  }
  function startConvo(now) {
    var lines = nextConvo(function (ls) {
      return participants(ls).every(function (id) { return byId[id] && !byId[id].convo; });
    });
    if (!lines) return;
    var ids = participants(lines);
    // a meeting spot: two free tiles side by side, facing each other
    var spot = null;
    for (var tries = 0; tries < 30 && !spot; tries++) {
      var t = pickOne(FREE);
      if (free(t[0] + 2, t[1]) && free(t[0] + 1, t[1])) spot = t;
    }
    if (!spot) return;
    var a = byId[ids[0]], b = byId[ids[1]];
    if (!walkTo(a, spot, 'east') || !walkTo(b, [spot[0] + 2, spot[1]], 'west')) {
      a.state = 'idle'; a.path = null; b.state = 'idle'; b.path = null; return;
    }
    a.convo = b.convo = lines;
    convos.push({ lines: lines, ids: ids, i: 0, phase: 'gather', at: 0, deadline: now + 10000 });
  }
  function stepConvos(now) {
    for (var c = convos.length - 1; c >= 0; c--) {
      var cv = convos[c];
      var members = cv.ids.map(function (id) { return byId[id]; });
      if (cv.phase === 'gather') {
        var here = members.every(function (m) { return m.arrived; });
        if (here || now > cv.deadline) { cv.phase = 'talk'; cv.at = now + 250; }
        continue;
      }
      if (now < cv.at) continue;
      if (cv.i >= cv.lines.length) {
        members.forEach(function (m) { m.convo = null; m.idleUntil = now + rnd(800, 2600); });
        convos.splice(c, 1);
        continue;
      }
      var ln = cv.lines[cv.i++];
      var sp = byId[ln.who];
      // turn toward the partner while speaking
      var other = members.filter(function (m) { return m !== sp; })[0];
      if (other && sp.state !== 'walk') sp.dir = other.px >= sp.px ? 'east' : 'west';
      cv.at = now + say(sp, ln.line, now) + 350;
    }
  }
  function stepDirector(now) {
    if (now >= convoAt) {
      if (convos.length < MAX_CONVOS) startConvo(now);
      convoAt = now + rnd(5500, 9500);
    }
    if (now >= soloAt) {
      var line = nextSolo(function (l) {
        var b = byId[l.who];
        return b && !b.convo && !bubbles.some(function (x) { return x.b === b; });
      });
      if (line) say(byId[line.who], line.line, now);
      soloAt = now + rnd(3200, 6000);
    }
  }

  /* ---------- rendering ---------- */
  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var dpr = 1, vw = 0, vh = 0, cam = { s: 1, ox: 0, oy: 0 };
  var stars = [];
  var HUD_TOP = 44;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    var availH = vh - HUD_TOP - 8;
    cam.s = Math.min(vw / (WW + 16), availH / (WH + 8));
    cam.ox = (vw - WW * cam.s) / 2;
    cam.oy = HUD_TOP + (availH - WH * cam.s) / 2;
    stars = [];
    var n = Math.round(vw * vh / 5000);
    for (var i = 0; i < n; i++) stars.push({ x: rand() * vw, y: rand() * vh, r: rand() < 0.1 ? 1.6 : 0.8, tw: rand() * 6.28 });
  }
  window.addEventListener('resize', resize);

  function toScreen(x, y) { return { x: cam.ox + x * cam.s, y: cam.oy + y * cam.s }; }

  function drawSpace(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var g = ctx.createRadialGradient(vw / 2, vh / 2, 0, vw / 2, vh / 2, Math.max(vw, vh) * 0.7);
    g.addColorStop(0, '#0b1630'); g.addColorStop(1, '#02040a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      ctx.globalAlpha = reduced ? 0.6 : 0.35 + 0.35 * Math.sin(now / 900 + s.tw);
      ctx.fillStyle = '#cfe6ff';
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
  }

  var floorPattern = null;
  function drawRoom(now) {
    // hull rim
    ctx.fillStyle = '#10151d';
    ctx.fillRect(-6, -6, WW + 12, WH + 12);
    ctx.strokeStyle = 'rgba(90,208,255,0.35)'; ctx.lineWidth = 0.6;
    ctx.strokeRect(-6, -6, WW + 12, WH + 12);
    // floor
    var fx = T, fy = WALL_ROWS * T, fw = WW - 2 * T, fh = WH - (WALL_ROWS + 1) * T;
    if (ok(FLOOR)) {
      if (!floorPattern) {
        floorPattern = ctx.createPattern(FLOOR, 'repeat');
        if (floorPattern.setTransform) floorPattern.setTransform(new DOMMatrix().scale(96 / FLOOR.naturalWidth));
      }
      ctx.fillStyle = floorPattern;
    } else ctx.fillStyle = '#1b1f26';
    ctx.fillRect(fx, fy, fw, fh);
    ctx.fillStyle = 'rgba(20,40,70,0.18)'; ctx.fillRect(fx, fy, fw, fh);   // cool station tint
    // back wall: the top band of the industrial wall texture, tiled
    if (ok(WALL)) {
      var sh = WALL.naturalHeight * 0.55, dh = WALL_ROWS * T, dw = WALL.naturalWidth * dh / sh;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, WW, dh); ctx.clip();
      for (var x = 0; x < WW; x += dw) ctx.drawImage(WALL, 0, 0, WALL.naturalWidth, sh, x, 0, dw, dh);
      ctx.restore();
    } else { ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, WW, WALL_ROWS * T); }
    // wall foot shadow + glowing trim
    var wg = ctx.createLinearGradient(0, fy, 0, fy + 10);
    wg.addColorStop(0, 'rgba(0,0,0,0.55)'); wg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = wg; ctx.fillRect(fx, fy, fw, 10);
    ctx.fillStyle = 'rgba(90,208,255,' + (reduced ? 0.5 : 0.4 + 0.15 * Math.sin(now / 700)) + ')';
    ctx.fillRect(0, fy - 0.8, WW, 0.8);
    // side + front walls
    ctx.fillStyle = '#1a1f28';
    ctx.fillRect(0, fy, T, WH - fy); ctx.fillRect(WW - T, fy, T, WH - fy); ctx.fillRect(0, WH - T, WW, T);
    ctx.fillStyle = 'rgba(255,176,46,0.5)';
    ctx.fillRect(T - 0.8, fy, 0.8, fh); ctx.fillRect(WW - T, fy, 0.8, fh); ctx.fillRect(T, WH - T, fw, 0.8);
    // holotable light pool
    var hc = toWorldCenter(HOLO);
    var lg = ctx.createRadialGradient(hc.x, hc.y, 2, hc.x, hc.y, 70);
    lg.addColorStop(0, 'rgba(90,208,255,' + (reduced ? 0.16 : 0.13 + 0.04 * Math.sin(now / 500)) + ')');
    lg.addColorStop(1, 'rgba(90,208,255,0)');
    ctx.fillStyle = lg; ctx.fillRect(fx, fy, fw, fh);
  }
  function toWorldCenter(p) { return { x: (p.x + p.w / 2) * T, y: (p.y + p.h / 2) * T }; }

  function drawProp(p) {
    if (!ok(p.im)) return;
    var w = p.w * T * (p.fit || 1);
    var h = p.im.naturalHeight * w / p.im.naturalWidth;
    var cx = (p.x + p.w / 2) * T;
    var by = p.wall ? (p.y + p.h) * T + 6 : (p.y + p.h) * T;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(p.im, cx - w / 2, by - h, w, h);
  }

  var stats = { booted: false, frames: 0, bodiesDrawn: 0, bubblesVisible: 0, linesSpoken: 0, splashGone: false };

  function render(now) {
    drawSpace(now);
    ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * cam.ox, dpr * cam.oy);
    drawRoom(now);
    PROPS.forEach(function (p) { if (p.floor || p.wall) drawProp(p); });
    // painter's order: props and bodies by their floor line
    var items = [];
    PROPS.forEach(function (p) { if (!p.floor && !p.wall) items.push({ y: (p.y + p.h) * T - 0.5, p: p }); });
    bodies.forEach(function (b) { items.push({ y: b.py, b: b }); });
    items.sort(function (a, b) { return a.y - b.y; });
    var drawn = 0;
    var tops = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.p) { drawProp(it.p); continue; }
      var b = it.b;
      var g = SPRITES.drawBody(ctx, b, now, { reducedMotion: reduced });
      if (g) { drawn++; tops[b.id] = g.top; }
    }
    stats.bodiesDrawn = drawn;
    drawOverlays(now, tops);
  }

  /* name tags + speech bubbles, in SCREEN space so text stays crisp at any zoom */
  var FONT = '"VT323", "Courier New", monospace';
  function wrap(text, maxW) {
    var words = text.split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = words[i]; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function drawOverlays(now, tops) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var ui = Math.max(0.8, Math.min(1.3, cam.s / 3.6));
    // name tags under the feet
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = Math.round(15 * ui) + 'px ' + FONT;
    bodies.forEach(function (b) {
      var s = toScreen(b.px, b.py + 2);
      var label = b.cast.name.toUpperCase();
      var w = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(3,6,13,0.7)'; ctx.fillRect(s.x - w / 2, s.y, w, 16 * ui);
      ctx.fillStyle = b.cast.color; ctx.fillText(label, s.x, s.y + 1);
    });
    // bubbles: expire, then lay out top-down nudging overlaps upward
    bubbles = bubbles.filter(function (x) {
      if (now < x.until) return true;
      x.b.speaking = false; return false;
    });
    var fs = Math.round(18 * ui);
    ctx.font = fs + 'px ' + FONT;
    var placed = [];
    var order = bubbles.slice().sort(function (a, b) { return b.b.py - a.b.py; });
    order.forEach(function (bb) {
      var b = bb.b;
      var topY = tops[b.id] != null ? tops[b.id] : b.py - 24;
      var anchor = toScreen(b.px, topY - 3);
      var lines = wrap(bb.text, 210 * ui);
      var lh = fs * 0.95, pad = 7 * ui;
      ctx.font = Math.round(13 * ui) + 'px ' + FONT;
      var head = b.cast.name.toUpperCase() + ' · ' + b.cast.title.toUpperCase();
      var headW = ctx.measureText(head).width;
      ctx.font = fs + 'px ' + FONT;
      var w = Math.max(headW, Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }))) + pad * 2;
      var h = lines.length * lh + 14 * ui + pad * 1.6;
      var x = Math.max(6, Math.min(vw - w - 6, anchor.x - w / 2));
      var y = anchor.y - h - 8 * ui;
      for (var k = 0; k < placed.length; k++) {
        var o = placed[k];
        if (x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y) y = o.y - h - 4;
      }
      y = Math.max(HUD_TOP, y);
      placed.push({ x: x, y: y, w: w, h: h });
      var age = now - bb.born, life = bb.until - now;
      ctx.globalAlpha = reduced ? 1 : Math.min(1, age / 160, life / 220);
      // tail
      ctx.fillStyle = '#f4f8ff';
      ctx.beginPath();
      var tx = Math.max(x + 10, Math.min(x + w - 10, anchor.x));
      ctx.moveTo(tx - 6 * ui, y + h - 1); ctx.lineTo(tx + 6 * ui, y + h - 1); ctx.lineTo(anchor.x, anchor.y);
      ctx.closePath(); ctx.fill();
      roundRect(x, y, w, h, 5 * ui);
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = b.cast.color; ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = Math.round(13 * ui) + 'px ' + FONT;
      ctx.fillStyle = shade(b.cast.color);
      ctx.fillText(head, x + pad, y + pad * 0.6);
      ctx.font = fs + 'px ' + FONT;
      ctx.fillStyle = '#0b1220';
      for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], x + pad, y + pad * 0.6 + 14 * ui + li * lh);
      ctx.globalAlpha = 1;
    });
    stats.bubblesVisible = placed.length;
  }
  /* darken an accent so it reads on the white bubble */
  function shade(hex) {
    var n = parseInt(hex.slice(1), 16);
    var f = function (v) { return Math.round(v * 0.55); };
    return 'rgb(' + f((n >> 16) & 255) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
  }

  /* ---------- main loop ---------- */
  var last = 0;
  function frame(now) {
    var dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (stats.splashGone || now > 900) {
      for (var i = 0; i < bodies.length; i++) {
        var b = bodies[i];
        if (b.speaking && now > b.speakUntil) b.speaking = false;
        stepBody(b, dt, now);
      }
      stepDirector(now);
      stepConvos(now);
    }
    render(now);
    stats.frames++;
    requestAnimationFrame(frame);
  }

  /* ---------- UI: splash, badge, upsell, toast ---------- */
  var splash = document.getElementById('splash');
  function dismissSplash() {
    if (stats.splashGone) return;
    stats.splashGone = true;
    splash.classList.add('gone');
    setTimeout(function () { splash.style.display = 'none'; }, 700);
  }
  splash.addEventListener('click', dismissSplash);
  window.addEventListener('keydown', dismissSplash, { once: true });
  setTimeout(dismissSplash, 1400);   // first-run rescue: never a wall, auto-advance

  var upsell = document.getElementById('upsell');
  function openUpsell() { upsell.hidden = false; upsellShown = true; }
  var upsellShown = false;
  document.getElementById('demo-badge').addEventListener('click', openUpsell);
  document.getElementById('btn-full').addEventListener('click', openUpsell);
  upsell.querySelector('.upsell-x').addEventListener('click', function () { upsell.hidden = true; });
  setTimeout(function () { if (!upsellShown) openUpsell(); }, 45000);   // one gentle nudge, never blocking
  var gh = document.getElementById('link-github');
  if (/TODO/.test(GITHUB_URL)) {
    gh.classList.add('disabled'); gh.removeAttribute('href'); gh.textContent = 'GITHUB: LINK COMING SOON';
  } else gh.href = GITHUB_URL;
  document.getElementById('link-play').href = PLAY_URL;

  var toastEl = document.getElementById('toast'), toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, 4200);
  }

  /* ---------- SHARE CARD ---------- */
  function buildShareCard() {
    render(performance.now());                 // make sure the canvas holds a fresh frame
    var W = 1200, H = 630, BAND = 168;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#03060d'; x.fillRect(0, 0, W, H);
    // the live scene, cover-cropped around the station into the top area
    var sx = cam.ox * dpr, sy = cam.oy * dpr, sw = WW * cam.s * dpr, sh = WH * cam.s * dpr;
    var areaH = H - BAND, k = Math.max(W / sw, areaH / sh);
    var cw = W / k, ch = areaH / k;
    x.imageSmoothingEnabled = true;
    x.drawImage(canvas, sx + (sw - cw) / 2, sy + (sh - ch) / 2, cw, ch, 0, 0, W, areaH);
    // title chip
    x.fillStyle = 'rgba(3,6,13,0.78)'; x.fillRect(18, 16, 330, 44);
    x.fillStyle = '#ffffff'; x.font = '34px ' + FONT; x.textBaseline = 'middle';
    x.fillText('EMPIRE OF GODS', 30, 39);
    // quote band
    var bandY = H - BAND;
    var bg = x.createLinearGradient(0, bandY, 0, H);
    bg.addColorStop(0, '#0b1630'); bg.addColorStop(1, '#03060d');
    x.fillStyle = bg; x.fillRect(0, bandY, W, BAND);
    var q = lastQuote || { name: 'Zeus', title: 'CEO', color: '#ffd45a', line: "I don't do stand-ups. I do thunder-ups." };
    x.fillStyle = q.color; x.fillRect(0, bandY, W, 4);
    x.textBaseline = 'top'; x.fillStyle = '#ffffff'; x.font = '40px ' + FONT;
    var words = ('“' + q.line + '”').split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (x.measureText(t).width > W - 80 && cur) { lines.push(cur); cur = words[i]; } else cur = t;
    }
    lines.push(cur);
    lines = lines.slice(0, 2);
    lines.forEach(function (l, n) { x.fillText(l, 40, bandY + 18 + n * 38); });
    x.font = '30px ' + FONT; x.fillStyle = q.color;
    x.fillText('— ' + q.name + ', ' + q.title, 40, bandY + 22 + lines.length * 38);
    x.font = '26px ' + FONT; x.fillStyle = '#8fa6bf'; x.textAlign = 'right';
    x.fillText('Empire of Gods — play free: ' + PLAY_LABEL, W - 30, H - 36);
    return c;
  }
  function share() {
    var c = buildShareCard();
    try {
      c.toBlob(function (blob) {
        if (!blob) { toast('Could not render the share card.'); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'empire-of-gods-' + Date.now() + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('Share card saved — post it anywhere!');
      }, 'image/png');
    } catch (e) {
      // file:// pages taint the canvas with local images, so the browser refuses to export it
      toast('Share cards need the hosted page (' + PLAY_LABEL + ') — browsers block image export from file://.');
    }
  }
  document.getElementById('btn-share').addEventListener('click', share);

  /* read-only hook for the headless proof (tools/proof.mjs) */
  window.__eogdemo = {
    seed: SEED,
    stats: function () {
      return {
        booted: stats.booted, frames: stats.frames, bodies: bodies.length, bodiesDrawn: stats.bodiesDrawn,
        bubblesVisible: stats.bubblesVisible, linesSpoken: stats.linesSpoken, splashGone: stats.splashGone,
        walking: bodies.filter(function (b) { return b.state === 'walk'; }).length,
        activeConvos: convos.length, lastQuote: lastQuote
      };
    },
    shareCardDataURL: function () { return buildShareCard().toDataURL('image/png'); }
  };

  /* ---------- boot ---------- */
  resize();
  SPRITES.init().then(function () {
    bodies.forEach(function (b) { SPRITES.ensureSkin(b.skin); });
    stats.booted = true;
  });
  requestAnimationFrame(frame);
})();
