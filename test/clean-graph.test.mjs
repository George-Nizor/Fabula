import test from "node:test";
import assert from "node:assert/strict";
import { frameSpans, cleanGraph, sumExpression, SUM_GROUP } from "../core/clean-graph.mjs";

const cam = { x: 440, y: 0, w: 2560, h: 1440 };
const pip = { x: 2342, y: 822, w: 1098, h: 618 };
const screen = { x: 0, y: 0, w: 2342, h: 1440 };
const pieces = [
  { keepIndex: 0, start: 1.895, end: 7.522, head: cam, screen: null },
  { keepIndex: 1, start: 9.965, end: 14.8, head: cam, screen: null },
  { keepIndex: 1, start: 14.8, end: 18.295, head: pip, screen },
  { keepIndex: 2, start: 22.82, end: 22.83, head: pip, screen },
  { keepIndex: 3, start: 30, end: 40.5, head: cam, screen: null },
];

test("frame spans keep whole frames, adjacent pieces stay adjacent, the audio matches the frames exactly", () => {
  const spans = frameSpans(pieces, 30);
  assert.equal(spans.length, 4, "a piece shorter than a frame disappears");
  let clean = 0;
  for (const span of spans) {
    assert.equal(span.frames, span.lastFrame - span.firstFrame + 1);
    assert.ok(span.firstFrame / 30 >= span.start - 1e-9, "first frame is not before the piece");
    assert.ok(span.lastFrame / 30 < span.end, "last frame is inside the piece");
    assert.ok(Math.abs((span.audioEnd - span.audioStart) - span.frames / 30) < 1e-9, "audio is exactly the frames' length");
    assert.ok(Math.abs(span.cleanStart - clean) < 1e-9);
    clean = span.cleanEnd;
  }
  assert.equal(spans[1].lastFrame + 1, spans[2].firstFrame, "a keep split at a framing boundary keeps every frame once");
  assert.equal(spans[0].firstFrame, 57); // ceil(1.895 * 30)
  assert.equal(spans[0].lastFrame, 225); // ceil(7.522 * 30) - 1
  assert.equal(frameSpans([{ start: 1.9, end: 2.9, head: cam }], 30)[0].firstFrame, 57, "a boundary on the grid is not pushed a frame late by float noise");
});

test("the graph has one branch per distinct rect, an enable per switch, one select, and exact audio", () => {
  const spans = frameSpans(pieces, 30);
  const { graph, heads, screens } = cleanGraph({ spans, fps: 30, headSize: { width: 1920, height: 1080 }, screenSize: { width: 1756, height: 1080 }, rawDuration: 60 });
  assert.equal(heads, 2);
  assert.equal(screens, 1);
  assert.ok(graph.startsWith("[0:v]fps=30,split=3[f0][f1][f2]"));
  assert.ok(graph.includes("[f0]crop=2560:1440:440:0,scale=1920:1080:flags=lanczos"));
  assert.ok(graph.includes("[f1]crop=1098:618:2342:822,scale=1920:1080"));
  assert.ok(graph.includes("[h0][h1]overlay=0:0:enable='between(n,444,548)'"), "the pip crop shows only over its frames");
  assert.equal((graph.match(/select='/g) ?? []).length, 2, "one select per track");
  assert.ok(graph.includes(`select='${sumExpression(spans.map((s) => `between(n,${s.firstFrame},${s.lastFrame})`))}',setpts=N/(30*TB)[v]`));
  assert.ok(graph.includes(`atrim=start=${spans[0].audioStart.toFixed(6)}:end=${spans[0].audioEnd.toFixed(6)}`));
  assert.ok(graph.includes("concat=n=4:v=0:a=1[a]"));
  assert.ok(graph.includes("[f2]crop=2342:1440:0:0,scale=1756:1080:force_original_aspect_ratio=decrease"));
  assert.ok(graph.includes("[sbase][s0]overlay=0:0:enable='between(n,444,548)'"));
});

test("a plain take is one branch and no split", () => {
  const spans = frameSpans([{ start: 0, end: 10, head: { x: 0, y: 0, w: 1920, h: 1080 } }], 30);
  const { graph, heads, screens } = cleanGraph({ spans, fps: 30, headSize: { width: 1920, height: 1080 }, screenSize: null, rawDuration: 10 });
  assert.equal(heads, 1);
  assert.equal(screens, 0);
  assert.ok(graph.startsWith("[0:v]fps=30[f0]"));
  assert.ok(!graph.includes("overlay"));
  assert.ok(!graph.includes("[s]"));
});

test("a long sum is a tree of small groups, never a flat chain the parser refuses", () => {
  const terms = Array.from({ length: 1000 }, (_, i) => `between(n,${i * 10},${i * 10 + 5})`);
  const expr = sumExpression(terms);
  for (const term of terms) assert.ok(expr.includes(term));
  // No run of more than SUM_GROUP operands between one pair of parentheses.
  const flat = expr.replace(/between\(n,\d+,\d+\)/g, "x");
  const longest = Math.max(...flat.split(/[()]/).map((piece) => (piece.match(/x/g) ?? []).length));
  assert.ok(longest <= SUM_GROUP, `flat run of ${longest}`);
  assert.equal(sumExpression(terms.slice(0, 3)), terms.slice(0, 3).join("+"));
});
