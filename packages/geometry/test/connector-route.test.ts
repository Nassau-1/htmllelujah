import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_ROUTE_LIMITS,
  computeConnectorRoute,
  connectorRoutePathData,
  type ConnectorRouteInput,
  type ConnectorRoutePoint,
} from '../src/connector-route.js';

const route = (input: ConnectorRouteInput) => {
  const result = computeConnectorRoute(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.route;
};

const expectFinitePoint = (point: ConnectorRoutePoint): void => {
  expect(Number.isFinite(point.xPt)).toBe(true);
  expect(Number.isFinite(point.yPt)).toBe(true);
  expect(Math.abs(point.xPt)).toBeLessThanOrEqual(CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt);
  expect(Math.abs(point.yPt)).toBeLessThanOrEqual(CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt);
};

describe('connector route geometry', () => {
  it('preserves the current straight path contract', () => {
    const result = route({
      routing: 'straight',
      start: { xPt: 10, yPt: 20 },
      end: { xPt: 140, yPt: 80 },
    });

    expect(result.segments).toEqual([{ type: 'line', end: { xPt: 140, yPt: 80 } }]);
    expect(result.pathData).toBe('M 10 20 L 140 80');
    expect(result.isSelfLoop).toBe(false);
  });

  it('preserves the current horizontal-first elbow path contract', () => {
    const result = route({
      routing: 'elbow',
      start: { xPt: 10, yPt: 20 },
      end: { xPt: 140, yPt: 80 },
    });

    expect(result.pathData).toBe('M 10 20 L 75 20 L 75 80 L 140 80');
    expect(result.segments).toHaveLength(3);
  });

  it('creates one cubic with outward controls for facing anchors', () => {
    const result = route({
      routing: 'curved',
      start: { xPt: 100, yPt: 100, binding: { elementId: 'left', anchor: 'right' } },
      end: { xPt: 300, yPt: 160, binding: { elementId: 'right', anchor: 'left' } },
    });

    expect(result.isSelfLoop).toBe(false);
    expect(result.segments).toHaveLength(1);
    const segment = result.segments[0];
    expect(segment?.type).toBe('cubic');
    if (segment?.type !== 'cubic') throw new Error('Expected cubic segment.');
    expect(segment.control1.xPt).toBeGreaterThan(result.start.xPt);
    expect(segment.control1.yPt).toBe(result.start.yPt);
    expect(segment.control2.xPt).toBeLessThan(segment.end.xPt);
    expect(segment.control2.yPt).toBe(segment.end.yPt);
    expect(result.pathData).toMatch(/^M 100 100 C /);
  });

  it('infers stable tangents for unbound and center-bound endpoints', () => {
    const unbound = route({
      routing: 'curved',
      start: { xPt: 20, yPt: 30 },
      end: { xPt: 220, yPt: 130 },
    });
    const centered = route({
      routing: 'curved',
      start: { xPt: 20, yPt: 30, binding: { elementId: 'a', anchor: 'center' } },
      end: { xPt: 220, yPt: 130, binding: { elementId: 'b', anchor: 'center' } },
    });

    expect(centered.pathData).toBe(unbound.pathData);
    expect(centered.isSelfLoop).toBe(false);
  });

  it('keeps very short curves bounded instead of applying oversized minimum handles', () => {
    const result = route({
      routing: 'curved',
      start: { xPt: 10, yPt: 10 },
      end: { xPt: 11, yPt: 10 },
      options: { minControlDistancePt: 100, maxControlDistancePt: 200 },
    });
    const segment = result.segments[0];
    if (segment?.type !== 'cubic') throw new Error('Expected cubic segment.');

    expect(segment.control1.xPt).toBe(10.5);
    expect(segment.control2.xPt).toBe(10.5);
  });

  it('routes two anchors on the same bound object as a smooth two-cubic loop', () => {
    const result = route({
      routing: 'curved',
      start: {
        xPt: 120,
        yPt: 80,
        binding: { elementId: 'same-shape', anchor: 'top' },
      },
      end: {
        xPt: 180,
        yPt: 140,
        binding: { elementId: 'same-shape', anchor: 'right' },
      },
    });

    expect(result.isSelfLoop).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments.every((segment) => segment.type === 'cubic')).toBe(true);
    const first = result.segments[0];
    const second = result.segments[1];
    if (first?.type !== 'cubic' || second?.type !== 'cubic') {
      throw new Error('Expected two cubic loop segments.');
    }
    expect({
      xPt: first.end.xPt - first.control2.xPt,
      yPt: first.end.yPt - first.control2.yPt,
    }).toEqual({
      xPt: second.control1.xPt - first.end.xPt,
      yPt: second.control1.yPt - first.end.yPt,
    });
    expect(first.end).not.toEqual(result.start);
    expect(second.end).toEqual({ xPt: 180, yPt: 140 });
    expect(result.pathData.match(/ C /g)).toHaveLength(2);
  });

  it('turns coincident free endpoints into a finite visible auto-loop', () => {
    const result = route({
      routing: 'curved',
      start: { xPt: 250, yPt: 160 },
      end: { xPt: 250, yPt: 160 },
    });

    expect(result.isSelfLoop).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.bounds.widthPt + result.bounds.heightPt).toBeGreaterThan(0);
    expect(result.pathData).not.toContain('NaN');
    expect(result.pathData).not.toContain('Infinity');
    for (const segment of result.segments) {
      expectFinitePoint(segment.end);
      if (segment.type === 'cubic') {
        expectFinitePoint(segment.control1);
        expectFinitePoint(segment.control2);
      }
    }
  });

  it('uses the requested loop radius in document points', () => {
    const compact = route({
      routing: 'curved',
      start: { xPt: 0, yPt: 0, binding: { elementId: 'shape', anchor: 'top' } },
      end: { xPt: 0, yPt: 0, binding: { elementId: 'shape', anchor: 'top' } },
      options: { selfLoopRadiusPt: 20 },
    });
    const large = route({
      routing: 'curved',
      start: { xPt: 0, yPt: 0, binding: { elementId: 'shape', anchor: 'top' } },
      end: { xPt: 0, yPt: 0, binding: { elementId: 'shape', anchor: 'top' } },
      options: { selfLoopRadiusPt: 120 },
    });

    expect(large.bounds.heightPt).toBeGreaterThan(compact.bounds.heightPt);
  });

  it('ignores screen-only zoom metadata and remains deterministic', () => {
    const base = {
      routing: 'curved',
      start: { xPt: 10, yPt: 30, binding: { anchor: 'bottom' } },
      end: { xPt: 400, yPt: 260, binding: { anchor: 'top' } },
    } as const;
    const atOneHundredPercent = computeConnectorRoute({ ...base, zoom: 1 } as ConnectorRouteInput);
    const atFourHundredPercent = computeConnectorRoute({ ...base, zoom: 4 } as ConnectorRouteInput);

    expect(atFourHundredPercent).toEqual(atOneHundredPercent);
  });

  it('clamps malformed options to safe deterministic ranges', () => {
    const malformed = route({
      routing: 'curved',
      start: { xPt: 0, yPt: 0, binding: { anchor: 'right' } },
      end: { xPt: 10_000, yPt: 0, binding: { anchor: 'left' } },
      options: {
        curvature: Number.POSITIVE_INFINITY,
        minControlDistancePt: -500,
        maxControlDistancePt: 1_000_000,
        selfLoopRadiusPt: Number.NaN,
      },
    });
    const segment = malformed.segments[0];
    if (segment?.type !== 'cubic') throw new Error('Expected cubic segment.');

    expect(segment.control1.xPt).toBe(CONNECTOR_ROUTE_LIMITS.maxControlDistancePt);
    expect(segment.control2.xPt).toBe(10_000 - CONNECTOR_ROUTE_LIMITS.maxControlDistancePt);
  });

  it.each([
    ['NaN start x', { xPt: Number.NaN, yPt: 0 }, 'invalid-start-point'],
    ['infinite start y', { xPt: 0, yPt: Number.POSITIVE_INFINITY }, 'invalid-start-point'],
    [
      'out-of-range start x',
      { xPt: CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt + 1, yPt: 0 },
      'invalid-start-point',
    ],
  ])('rejects %s without throwing', (_label, start, code) => {
    expect(
      computeConnectorRoute({
        routing: 'curved',
        start,
        end: { xPt: 10, yPt: 10 },
      }),
    ).toMatchObject({ ok: false, error: { code } });
  });

  it.each([
    ['NaN end x', { xPt: Number.NaN, yPt: 0 }],
    ['infinite end y', { xPt: 0, yPt: Number.NEGATIVE_INFINITY }],
    ['out-of-range end y', { xPt: 0, yPt: -(CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt + 1) }],
  ])('rejects %s without throwing', (_label, end) => {
    expect(
      computeConnectorRoute({
        routing: 'curved',
        start: { xPt: 10, yPt: 10 },
        end,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-end-point' } });
  });

  it('rejects unknown routing received from an untyped boundary', () => {
    expect(
      computeConnectorRoute({
        routing: 'spline',
        start: { xPt: 10, yPt: 10 },
        end: { xPt: 20, yPt: 20 },
      } as unknown as ConnectorRouteInput),
    ).toMatchObject({ ok: false, error: { code: 'invalid-routing' } });
  });

  it('fails closed when an untyped boundary omits either endpoint', () => {
    expect(
      computeConnectorRoute({
        routing: 'curved',
        end: { xPt: 20, yPt: 20 },
      } as unknown as ConnectorRouteInput),
    ).toMatchObject({ ok: false, error: { code: 'invalid-start-point' } });
    expect(
      computeConnectorRoute({
        routing: 'curved',
        start: { xPt: 10, yPt: 10 },
      } as unknown as ConnectorRouteInput),
    ).toMatchObject({ ok: false, error: { code: 'invalid-end-point' } });
  });

  it('returns conservative bounds containing every emitted control point', () => {
    const result = route({
      routing: 'curved',
      start: { xPt: 100, yPt: 200, binding: { anchor: 'left' } },
      end: { xPt: 400, yPt: 100, binding: { anchor: 'right' } },
    });
    const allPoints = [
      result.start,
      ...result.segments.flatMap((segment) =>
        segment.type === 'cubic'
          ? [segment.control1, segment.control2, segment.end]
          : [segment.end],
      ),
    ];

    for (const entry of allPoints) {
      expect(entry.xPt).toBeGreaterThanOrEqual(result.bounds.xPt);
      expect(entry.xPt).toBeLessThanOrEqual(result.bounds.xPt + result.bounds.widthPt);
      expect(entry.yPt).toBeGreaterThanOrEqual(result.bounds.yPt);
      expect(entry.yPt).toBeLessThanOrEqual(result.bounds.yPt + result.bounds.heightPt);
    }
  });

  it('formats independently supplied route segments with renderer precision', () => {
    expect(
      connectorRoutePathData({ xPt: -0, yPt: 1 / 3 }, [
        {
          type: 'cubic',
          control1: { xPt: 1.23456789, yPt: 2 },
          control2: { xPt: 3, yPt: 4 },
          end: { xPt: 5, yPt: 6 },
        },
      ]),
    ).toBe('M 0 0.333333 C 1.234568 2 3 4 5 6');
  });
});
