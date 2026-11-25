// Throwaway. A VLAN-aware learning switch fabric: per-direction bounded queues, loop marks, pace, delay and loss.
// Built to wasm32-freestanding. The host owns time and randomness' seed; frames live in a slab here, shared by a flood.

extern "env" fn out(sw: u32, port: u32, ptr: [*]const u8, len: u32) void;
extern "env" fn tap(sw: u32, from: u32, to: u32, flood: u32, ptr: [*]const u8, len: u32) void;

const SWITCHES = 8;
const PORTS = 8;
const DIRS = 64;
const SLOTS = 8192;
const FRAME_MAX = 2048;
const QUEUE = 1024;
const LIMIT = 256;
const LOOPED_LIMIT = 64;
const TABLE = 1024;
const NONE: u16 = 0xffff;

const Kind = enum(u8) { none, host, cable };
const Port = struct { kind: Kind = .none, up: bool = false, vlan: u16 = 1, dir: u8 = 0 };
const Entry = struct { key: u64 = 0, seen: f64 = 0, port: u8 = 0 };
const Switch = struct { ports: [PORTS]Port = @splat(.{}), table: [TABLE]Entry = @splat(.{}), looped: u32 = 0 };
const Item = struct { due: f64, slot: u16, vlan: u16, visited: u8, looped: bool };
const Dir = struct {
    q: [QUEUE]Item = undefined,
    head: u32 = 0,
    len: u32 = 0,
    from: u8 = 0,
    to: u8 = 0,
    to_port: u8 = 0,
    up: bool = true,
    ready: bool = false,
    waiting_looped: u32 = 0,
    paced: f64 = 0,
    delay: f64 = 0,
    loss: u32 = 0,
    carried: u32 = 0,
    full: u32 = 0,
    lost: u32 = 0,
    storm: u32 = 0,

    fn at(d: *Dir, i: u32) *Item {
        return &d.q[(d.head + i) % QUEUE];
    }
};

var switches: [SWITCHES]Switch = undefined;
var dirs: [DIRS]Dir = undefined;
var dir_count: u32 = 0;
var ready: [DIRS]u8 = undefined;
var ready_head: u32 = 0;
var ready_len: u32 = 0;
var data: [SLOTS][FRAME_MAX]u8 = undefined;
var lens: [SLOTS]u16 = @splat(0);
var refs: [SLOTS]u16 = @splat(0);
var next_free: [SLOTS]u16 = undefined;
var free: u16 = NONE;
var pace_ms: f64 = 0;
var taps = false;
var hop_count: u32 = 0;
var seed: u32 = 1;

export fn init(pace: f64, with_taps: u32, random_seed: u32) void {
    switches = @splat(.{});
    for (&dirs) |*d| d.* = .{};
    dir_count = 0;
    ready_head = 0;
    ready_len = 0;
    for (0..SLOTS) |i| next_free[i] = if (i + 1 < SLOTS) @intCast(i + 1) else NONE;
    free = 0;
    refs = @splat(0);
    pace_ms = if (pace > 0) 1000 / pace else 0;
    taps = with_taps != 0;
    seed = random_seed;
    hop_count = 0;
}

export fn host(sw: u32, port: u32, vlan: u32) void {
    switches[sw].ports[port] = .{ .kind = .host, .up = true, .vlan = @intCast(vlan) };
}

export fn cable(a: u32, pa: u32, b: u32, pb: u32) u32 {
    const i = dir_count;
    dir_count += 2;
    dirs[i].from = @intCast(a);
    dirs[i].to = @intCast(b);
    dirs[i].to_port = @intCast(pb);
    dirs[i + 1].from = @intCast(b);
    dirs[i + 1].to = @intCast(a);
    dirs[i + 1].to_port = @intCast(pa);
    switches[a].ports[pa] = .{ .kind = .cable, .up = true, .dir = @intCast(i) };
    switches[b].ports[pb] = .{ .kind = .cable, .up = true, .dir = @intCast(i + 1) };
    return i;
}

export fn conditions(dir: u32, delay: f64, loss: f64) void {
    dirs[dir].delay = delay;
    dirs[dir].loss = @intFromFloat(loss * 4294967295.0);
}

/// Takes a free slot for the host to write a frame into, or 0 when none is left. The slot is `frame(ptr)`'s argument.
export fn take() u32 {
    const s = free;
    if (s == NONE) return NONE;
    free = next_free[s];
    refs[s] = 1;
    return s;
}

export fn address(slot: u32) [*]u8 {
    return &data[slot];
}

fn release(s: u16) void {
    refs[s] -= 1;
    if (refs[s] != 0) return;
    next_free[s] = free;
    free = s;
}

export fn receive(sw: u32, port: u32, slot: u32, len: u32, now: f64) void {
    const s: u16 = @intCast(slot);
    lens[s] = @intCast(len);
    forward(sw, port, switches[sw].ports[port].vlan, s, now, 0, false);
    release(s);
}

fn mac(b: *const [FRAME_MAX]u8, at: u32) u64 {
    var v: u64 = 0;
    for (0..6) |i| v = (v << 8) | b[at + i];
    return v;
}

fn find(sw: *Switch, key: u64) *Entry {
    var i: u32 = @truncate((key *% 0x9E3779B97F4A7C15) >> 54);
    var n: u32 = 0;
    while (sw.table[i].key != 0 and sw.table[i].key != key and n < 32) : (n += 1) i = (i + 1) % TABLE;
    return &sw.table[i];
}

fn forward(sw_no: u32, in: u32, vlan: u16, s: u16, now: f64, visited: u8, looped: bool) void {
    const sw = &switches[sw_no];
    if (!sw.ports[in].up or lens[s] < 14) return;
    const b = &data[s];
    const v: u64 = @as(u64, vlan) << 48;
    const e = find(sw, v | mac(b, 6));
    e.* = .{ .key = v | mac(b, 6), .seen = now, .port = @intCast(in) };
    if (looped) sw.looped += 1;

    var to: u32 = 0;
    var flood: u32 = 0;
    if (b[0] & 1 != 0) {
        flood = 1;
    } else {
        const d = find(sw, v | mac(b, 0));
        if (d.key == 0 or !sw.ports[d.port].up or now - d.seen > 300_000) {
            flood = 2;
        } else if (d.port != in) {
            if (send(sw_no, d.port, vlan, s, now, visited, looped)) to = @as(u32, 1) << @intCast(d.port);
        }
    }
    if (flood != 0) {
        for (0..PORTS) |p| {
            if (p == in) continue;
            const port = sw.ports[p];
            if (port.kind == .none or !port.up or (port.kind == .host and port.vlan != vlan)) continue;
            if (send(sw_no, @intCast(p), vlan, s, now, visited, looped)) to |= @as(u32, 1) << @intCast(p);
        }
    }
    if (taps) tap(sw_no, in, to, flood, b, lens[s]);
}

fn send(sw_no: u32, p: u32, vlan: u16, s: u16, now: f64, visited: u8, looped: bool) bool {
    const port = switches[sw_no].ports[p];
    if (port.kind == .host) {
        out(sw_no, p, &data[s], lens[s]);
        return true;
    }
    const d = &dirs[port.dir];
    if (!d.up) return false;
    if (d.loss != 0 and random() < d.loss) {
        d.lost += 1;
        return true;
    }
    var due: f64 = 0;
    if (d.delay > 0) due = now + d.delay;
    if (looped and pace_ms > 0) {
        if (d.waiting_looped >= LOOPED_LIMIT) {
            d.storm += 1;
            return true;
        }
        d.waiting_looped += 1;
        d.paced = @max(now, d.paced) + pace_ms;
        due = @max(due, d.paced);
    } else if (d.len >= (if (d.delay > 0) @as(u32, QUEUE) else LIMIT)) {
        d.full += 1;
        return true;
    }
    if (d.len == QUEUE) {
        d.full += 1;
        return true;
    }
    refs[s] += 1;
    var i = d.len;
    d.len += 1;
    while (i > 0 and d.at(i - 1).due > due) : (i -= 1) d.at(i).* = d.at(i - 1).*;
    d.at(i).* = .{ .due = due, .slot = s, .vlan = vlan, .visited = visited | (@as(u8, 1) << @intCast(sw_no)), .looped = looped };
    arm(port.dir, now);
    return true;
}

fn arm(i: u8, now: f64) void {
    const d = &dirs[i];
    if (d.ready or d.len == 0 or d.at(0).due > now) return;
    d.ready = true;
    ready[(ready_head + ready_len) % DIRS] = i;
    ready_len += 1;
}

fn random() u32 {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}

/// Carries at most `most` frames that are due. Returns how many it carried.
export fn drain(now: f64, most: u32) u32 {
    for (0..dir_count) |i| arm(@intCast(i), now);
    var n: u32 = 0;
    while (n < most and ready_len > 0) : (n += 1) {
        const i = ready[ready_head];
        ready_head = (ready_head + 1) % DIRS;
        ready_len -= 1;
        const d = &dirs[i];
        d.ready = false;
        if (d.len == 0) continue;
        const item = d.at(0).*;
        if (item.due > now) continue;
        d.head = (d.head + 1) % QUEUE;
        d.len -= 1;
        arm(i, now);
        if (item.looped and pace_ms > 0) d.waiting_looped -= 1;
        d.carried += 1;
        hop_count += 1;
        const bit = @as(u8, 1) << @intCast(d.to);
        forward(d.to, d.to_port, item.vlan, item.slot, now, item.visited, item.looped or item.visited & bit != 0);
        release(item.slot);
    }
    return n;
}

/// When the next frame is due, 0 for now, or -1 when none waits.
export fn next() f64 {
    if (ready_len > 0) return 0;
    var at: f64 = -1;
    for (0..dir_count) |i| {
        const d = &dirs[i];
        if (d.len > 0 and (at < 0 or d.at(0).due < at)) at = d.at(0).due;
    }
    return at;
}

export fn hops() u32 {
    return hop_count;
}
export fn dropped() u32 {
    var n: u32 = 0;
    for (0..dir_count) |i| n += dirs[i].full + dirs[i].storm + dirs[i].lost;
    return n;
}
