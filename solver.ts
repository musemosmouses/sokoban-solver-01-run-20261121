// solver.ts — a push-optimal Sokoban solver.
//
// Strategy: a level is a hallway with one to four rooms off it, and a box
// pushed out of a room can never come back, so every room is solved on its
// own and the answers are joined with walks through the hallway. Inside a
// room the search is A* over pushes: a state is the boxes plus the player's
// reachable region, each push costs one, and the estimate is the cheapest
// matching of boxes to goals over true floor distances, which never
// overestimates (one push moves one box one square). Dead squares (no
// pull-back path to a goal) and frozen 2 x 2 blocks are pruned; both
// prunings are safe, so the first solution found is push-optimal. A plain
// breadth-first search over pushes, same prunings, is the fallback when A*
// spends its node budget. Everything is budgeted by nodes expanded, never
// by the clock, and every tie breaks by insertion order, so two runs write
// the same bytes.

/** A level: its width, height, walls (1 a wall), goals, boxes, player. */
export type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** [dx, dy, the walk letter, the push letter]. */
export const DIRS: readonly (readonly [number, number, string, string])[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
export function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares from which a box alone can be pushed onto some goal: pull back from the goals, one square at a time. */
export function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const z = y - d;
      if (z < 0 || z >= wall.length) continue;
      if (!wall[y] && !wall[z] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** For each goal, the floor distance from every square to it (ignoring boxes), -1 where unreachable. */
export function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (wall[q] || dist[q] !== -1) continue;
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
    out.push(dist);
  }
  return out;
}

/** The number of set bits in a small mask. */
function popcount(mask: number): number {
  let n = 0;
  while (mask > 0) {
    n += mask & 1;
    mask >>= 1;
  }
  return n;
}

/**
 * The cheapest matching of boxes to goals over floor distances, or Infinity
 * when some box cannot reach a distinct goal. Admissible: one push moves one
 * box one square, so no push lowers this by more than one, and it is zero
 * exactly when every box sits on a goal.
 */
export function matchingEstimate(boxes: number[], goals: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 6) {
    // Too many boxes for the matching table: sum each box's nearest goal.
    let total = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let g = 0; g < goals.length; g++) {
        const d = dist[g]![b]!;
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      total += best;
    }
    return total;
  }
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    cost[i] = [];
    for (let j = 0; j < goals.length; j++) {
      const d = dist[j]![boxes[i]!]!;
      cost[i]![j] = d < 0 ? Infinity : d;
    }
  }
  // dp[mask]: the cheapest way to match the first popcount(mask) boxes to the goals in mask.
  const size = 1 << goals.length;
  const dp = new Array<number>(size).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    const k = popcount(mask);
    if (k >= n || dp[mask] === Infinity) continue;
    for (let j = 0; j < goals.length; j++) {
      if (mask & (1 << j)) continue;
      const c = cost[k]![j]!;
      if (c === Infinity) continue;
      const nm = mask | (1 << j);
      if (dp[mask]! + c < dp[nm]!) dp[nm] = dp[mask]! + c;
    }
  }
  let best = Infinity;
  for (let mask = 0; mask < size; mask++) {
    if (popcount(mask) === n && dp[mask]! < best) best = dp[mask]!;
  }
  return best;
}

/** Scratch space shared by one search, so the flood fill never allocates. */
type Search = {
  w: number;
  wall: Uint8Array;
  goal: Uint8Array;
  live: Uint8Array;
  goals: number[];
  dist: Int32Array[];
  occupied: Uint8Array;
  seen: Int32Array;
  mark: Int32Array;
  stack: Int32Array;
  stamp: number;
};

/**
 * The squares the player reaches from `from` around walls and boxes, marked
 * in `seen` with a fresh stamp; returns the lowest square reached and the
 * stamp, so a caller can test membership without clearing anything.
 */
function floodRegion(s: Search, seen: Int32Array, from: number): { low: number; stamp: number } {
  const stamp = ++s.stamp;
  const { w, wall, occupied, stack } = s;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const up = p - w;
    if (!wall[up] && !occupied[up] && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    const down = p + w;
    if (!wall[down] && !occupied[down] && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    const left = p - 1;
    if (!wall[left] && !occupied[left] && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    const right = p + 1;
    if (!wall[right] && !occupied[right] && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return { low, stamp };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkPath(s: Search, from: number, to: number): string {
  const { w, wall, occupied } = s;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walk: the push square is out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]!) out = how[p]! + out;
  return out;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls
 * and boxes with a box off its goal: no push ever frees it.
 */
function frozenBlock(s: Search, t: number): boolean {
  const { w, wall, occupied, goal } = s;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The most states one A* search stores, and one BFS fallback; the whole set's node budget. */
export const ASTAR_STATES = 400_000;
export const BFS_STATES = 250_000;
export const GLOBAL_STATES = 2_000_000;

/** Nodes expanded across the whole set: the only budget, never the clock. */
let spent = 0;

/** A found solution: its push count and its moves in LURD. */
export type Found = { pushes: number; moves: string };

/** A heap entry: [estimate, insertion order, state index]. */
type HeapEntry = [number, number, number];

function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  heap.push(e);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const a = heap[i]!;
    const b = heap[p]!;
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) break;
    heap[i] = b;
    heap[p] = a;
    i = p;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length) {
        const l = heap[c]!;
        const r = heap[c + 1]!;
        if (r[0] < l[0] || (r[0] === l[0] && r[1] < l[1])) c++;
      }
      const ch = heap[c]!;
      const cur = heap[i]!;
      if (ch[0] > cur[0] || (ch[0] === cur[0] && ch[1] > cur[1])) break;
      heap[i] = ch;
      heap[c] = cur;
      i = c;
    }
  }
  return top;
}

/**
 * The push-optimal solution of `level`: A* over pushes when `useHeuristic`
 * (the matching estimate guides it), plain breadth-first over pushes
 * otherwise — breadth-first is A* with a zero estimate. A state is the
 * boxes, sorted, plus the lowest square of the player's reachable region, so
 * two states the player can walk between for free are one. Returns null when
 * the search spends its node budget or the level has no solution.
 */
export function searchPushes(level: Level, maxStates: number, useHeuristic: boolean): Found | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const s: Search = {
    w,
    wall,
    goal,
    live,
    goals,
    dist,
    occupied: new Uint8Array(size),
    seen: new Int32Array(size),
    mark: new Int32Array(size),
    stack: new Int32Array(size),
    stamp: 0,
  };
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const sKey: string[] = [];
  const best = new Map<string, number>();
  for (const b of level.boxes) s.occupied[b] = 1;
  const low0 = floodRegion(s, s.seen, level.player).low;
  for (const b of level.boxes) s.occupied[b] = 0;
  const key0 = low0 + '|' + level.boxes.join(',');
  sKey.push(key0);
  best.set(key0, 0);
  const h0 = matchingEstimate(level.boxes, goals, dist);
  if (h0 === Infinity) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };
  const heap: HeapEntry[] = [];
  let counter = 0;
  heapPush(heap, [useHeuristic ? h0 : 0, counter++, 0]);
  while (heap.length > 0) {
    const [, , si] = heapPop(heap);
    const boxes = sBoxes[si]!;
    const g = sG[si]!;
    if (best.get(sKey[si]!) !== g) continue;
    if (solved(boxes)) {
      const path: number[] = [];
      for (let t = si; t > 0; t = sParent[t]!) path.push(t);
      path.reverse();
      let moves = '';
      let player = level.player;
      let cur = level.boxes.slice();
      for (const t of path) {
        const from = sFrom[t]!;
        const to = sTo[t]!;
        const di = sDir[t]!;
        const [dx, dy, , pushLetter] = DIRS[di]!;
        const d = dy * w + dx;
        for (const b of cur) s.occupied[b] = 1;
        moves += walkPath(s, player, from - d);
        for (const b of cur) s.occupied[b] = 0;
        moves += pushLetter;
        player = from;
        cur = sBoxes[t]!.slice();
        void to;
      }
      return { pushes: path.length, moves };
    }
    if (++spent > GLOBAL_STATES) return null;
    for (const b of boxes) s.occupied[b] = 1;
    const region = floodRegion(s, s.seen, sPlayer[si]!);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (s.seen[b - d] !== region.stamp || wall[t] || s.occupied[t] || !live[t]) continue;
        s.occupied[b] = 0;
        s.occupied[t] = 1;
        const frozen = frozenBlock(s, t);
        let key = '';
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const low = floodRegion(s, s.mark, b).low;
          key = low + '|' + next.join(',');
          h = matchingEstimate(next, goals, dist);
        }
        s.occupied[t] = 0;
        s.occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const ng = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) s.occupied[x] = 0;
          return null;
        }
        best.set(key, ng);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(si);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(di);
        sG.push(ng);
        sKey.push(key);
        heapPush(heap, [ng + (useHeuristic ? h : 0), counter++, sBoxes.length - 1]);
      }
    }
    for (const x of boxes) s.occupied[x] = 0;
  }
  return null;
}

/** One room of a level: its squares, boxes, goals, and whether it is solved. */
export type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
export function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s0 = 0; s0 < wall.length; s0++) {
    if (wall[s0] || cut[s0] || part[s0] >= 0) continue;
    const squares = [s0];
    part[s0] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    p += ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
  }
  return p;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 */
export function solveByRooms(level: Level): Found | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = searchPushes(sub, ASTAR_STATES, true) ?? searchPushes(sub, BFS_STATES, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * The moves that solve a level in XSB text, in as few pushes as the search
 * finds: room by room first, then the whole level when the rooms do not
 * come apart. An empty string when no search solves it.
 */
export function solveLevel(text: string): string {
  const level = parseLevel(text);
  const found =
    solveByRooms(level) ??
    searchPushes(level, ASTAR_STATES, true) ??
    searchPushes(level, BFS_STATES, false);
  return found === null ? '' : found.moves;
}

