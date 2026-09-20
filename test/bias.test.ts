import { describe, expect, it } from 'vitest';
import { SegmentMap, type Segment } from '../src/index.js';

// All coordinates are 0-based, as in the mappings encoding.
const mapped = (
  generatedLine: number,
  generatedColumn: number,
  source: string,
  originalLine: number,
  originalColumn: number,
  name?: string,
): Segment => ({
  generatedLine,
  generatedColumn,
  source,
  originalLine,
  originalColumn,
  ...(name !== undefined ? { name } : {}),
});

const unmapped = (generatedLine: number, generatedColumn: number): Segment => ({
  generatedLine,
  generatedColumn,
  originalLine: 0,
  originalColumn: 0,
});

describe('biased generated -> original lookup', () => {
  it('treats leading whitespace as unmapped and never crosses a line', async () => {
    const map = new SegmentMap();
    // "      ident..." on line 0; line 0's first mapping starts at column 6.
    map.add(mapped(0, 6, 'a.ts', 0, 0));
    map.add(mapped(0, 20, 'a.ts', 0, 10));

    expect(await map.locate(0, 3, 'strict')).toBeNull();
    expect(await map.locate(0, 3, 'predecessor')).toBeNull();

    const successor = await map.locate(0, 3, 'successor');
    expect(successor?.kind).toBe('biased');
    expect(successor?.segment.originalColumn).toBe(0);

    const exact = await map.locate(0, 6, 'strict');
    expect(exact?.kind).toBe('exact');
    expect(exact?.segment.source).toBe('a.ts');

    // No segment on line 1: neighbouring lines must not be considered.
    expect(await map.locate(1, 0, 'predecessor')).toBeNull();
    expect(await map.locate(1, 0, 'successor')).toBeNull();
    expect(await map.locate(1, 100, 'predecessor')).toBeNull();
  });

  it('does not treat the closest segment across a line boundary as the same range', async () => {
    const map = new SegmentMap();
    map.add(mapped(0, 0, 'a.ts', 0, 0));
    map.add(mapped(1, 4, 'a.ts', 1, 0));

    const hit = await map.locate(1, 9, 'predecessor');
    expect(hit?.kind).toBe('biased');
    expect(hit?.segment.originalLine).toBe(1);
    expect(hit?.segment.originalColumn).toBe(0);

    // Line 0's range ends at its own line end, it must not extend into line 1.
    const [rangeLine0] = await map.originalRangesFor('a.ts', { line: 0, column: 0 });
    expect(rangeLine0.generatedLine).toBe(0);
    expect(rangeLine0.endOfLine).toBe(true);
    expect(rangeLine0.endColumn).toBe(Number.POSITIVE_INFINITY);
  });

  it('lets unmapped segments cut ranges under every bias', async () => {
    const map = new SegmentMap();
    map.add(mapped(0, 6, 'a.ts', 0, 0));
    map.add(unmapped(0, 12));
    map.add(mapped(0, 20, 'a.ts', 0, 10));

    const predecessor = await map.locate(0, 10, 'predecessor');
    expect(predecessor?.kind).toBe('biased');
    expect(predecessor?.segment.originalColumn).toBe(0);

    // Exact hit on an unmapped segment.
    expect(await map.locate(0, 12, 'strict')).toBeNull();
    expect(await map.locate(0, 12, 'predecessor')).toBeNull();
    // Predecessor must not cross the unmapped cut.
    expect(await map.locate(0, 15, 'predecessor')).toBeNull();
    expect(await map.locate(0, 19, 'predecessor')).toBeNull();

    // Successor skips the unmapped segment.
    const successor = await map.locate(0, 13, 'successor');
    expect(successor?.kind).toBe('biased');
    expect(successor?.segment.originalColumn).toBe(10);

    const exact = await map.locate(0, 20, 'strict');
    expect(exact?.kind).toBe('exact');
    expect(exact?.segment.originalColumn).toBe(10);
  });

  it('handles zero-length duplicate segments at the same generated column', async () => {
    const map = new SegmentMap();
    map.add(mapped(0, 8, 'a.ts', 0, 0));
    map.add(mapped(0, 8, 'a.ts', 0, 0)); // duplicate segment, later insertion
    map.add(mapped(0, 20, 'a.ts', 0, 5));

    // Exact hit is distinguished from a biased hit; latest inserted wins.
    const exact = await map.locate(0, 8, 'strict');
    expect(exact?.kind).toBe('exact');

    // Both fragments are reachable through the reverse index; the first one
    // is a zero-length range [8, 8) derived from the next segment.
    const ranges = await map.originalRangesFor('a.ts', { line: 0, column: 0 });
    expect(ranges).toHaveLength(2);
    expect(ranges[0].generatedColumn).toBe(8);
    expect(ranges[0].endColumn).toBe(8);
    expect(ranges[0].endOfLine).toBe(false);
    expect(ranges[1].generatedColumn).toBe(8);
    expect(ranges[1].endColumn).toBe(20);

    expect(await map.originalRangesFor('a.ts', { line: 0, column: 5 })).toHaveLength(1);
  });

  it('preserves segments without a name and returns the name when present', async () => {
    const map = new SegmentMap();
    map.add(mapped(0, 0, 'a.ts', 0, 0)); // no name
    map.add(mapped(0, 4, 'a.ts', 0, 1, 'identifier'));

    const unnamed = await map.locate(0, 0, 'strict');
    expect(unnamed?.segment.name).toBeUndefined();

    const named = await map.locate(0, 4, 'strict');
    expect(named?.segment.name).toBe('identifier');

    const ranges = await map.originalRangesFor('a.ts', { line: 0, column: 0 }, { line: 1, column: 0 });
    expect(ranges).toHaveLength(2);
    expect(ranges[0].name).toBeUndefined();
    expect(ranges[1].name).toBe('identifier');
  });

  it('returns all generated fragments for one original position, stably sorted', async () => {
    const map = new SegmentMap();
    // Same original a.ts:2:0 reached from three generated fragments.
    map.add(mapped(5, 10, 'a.ts', 2, 0));
    map.add(mapped(0, 0, 'a.ts', 2, 0));
    map.add(mapped(0, 30, 'a.ts', 2, 0, 'dup'));
    // A different source sharing the generated bundle must not leak through.
    map.add(mapped(0, 0, 'b.ts', 2, 0));

    const ranges = await map.originalRangesFor('a.ts', { line: 2, column: 0 });
    expect(ranges.map((r) => [r.generatedLine, r.generatedColumn])).toEqual([
      [0, 0],
      [0, 30],
      [5, 10],
    ]);
    expect(ranges[1].name).toBe('dup');

    expect(await map.originalRangesFor('missing.ts', { line: 0, column: 0 })).toEqual([]);
  });

  it('treats the original interval as half open and keeps per-line ranges apart', async () => {
    const map = new SegmentMap();
    map.add(mapped(0, 0, 'a.ts', 0, 0));
    map.add(mapped(0, 2, 'a.ts', 0, 2));
    map.add(mapped(1, 0, 'a.ts', 0, 5));
    map.add(mapped(2, 0, 'a.ts', 1, 0));

    // [0:2, 1:0) excludes original 0:5? No: includes 0:2 and 0:5, excludes 1:0.
    const ranges = await map.originalRangesFor(
      'a.ts',
      { line: 0, column: 2 },
      { line: 1, column: 0 },
    );
    expect(ranges.map((r) => [r.originalLine, r.originalColumn])).toEqual([
      [0, 2],
      [0, 5],
    ]);
    // Each generated line contributes its own range; no cross-line merging.
    expect(ranges[0].generatedLine).toBe(0);
    expect(ranges[0].endOfLine).toBe(true);
    expect(ranges[1].generatedLine).toBe(1);
    expect(ranges[1].endOfLine).toBe(true);
  });
});

describe('index lifecycle', () => {
  it('builds the lazy index at most once across concurrent first queries', async () => {
    class CountingMap extends SegmentMap {
      builds = 0;
      protected override buildIndex(): void {
        this.builds++;
        super.buildIndex();
      }
    }

    const map = new CountingMap();
    map.add(mapped(0, 0, 'a.ts', 0, 0));
    map.add(mapped(1, 8, 'a.ts', 1, 0));

    // Issued synchronously, before any await: must coalesce onto one build.
    const results = await Promise.all([
      map.locate(0, 5),
      map.ready(),
      map.originalRangesFor('a.ts', { line: 0, column: 0 }),
      map.locate(1, 8, 'strict'),
    ]);

    expect(map.builds).toBe(1);
    expect(results[0]).not.toBeNull();
    expect(results[3]).toMatchObject({ kind: 'exact' });

    await map.ready();
    expect(map.builds).toBe(1);
  });

  it('rejects additions after the index was built', async () => {
    const map = new SegmentMap();
    map.add(mapped(0, 0, 'a.ts', 0, 0));
    await map.locate(0, 0);
    expect(() => map.add(mapped(0, 1, 'a.ts', 0, 1))).toThrow(/already indexed/);

    const sync = new SegmentMap();
    sync.add(mapped(0, 0, 'a.ts', 0, 0));
    sync.lookup(0, 0);
    expect(() => sync.add(mapped(0, 1, 'a.ts', 0, 1))).toThrow(/already indexed/);
  });

  it('validates coordinates', () => {
    const map = new SegmentMap();
    expect(() => map.add(mapped(-1, 0, 'a.ts', 0, 0))).toThrow();
    expect(() => map.add(mapped(0, 1.5, 'a.ts', 0, 0))).toThrow();
  });

  it('keeps the legacy synchronous lookup and sources behaviour', () => {
    const map = new SegmentMap();
    map.add(mapped(1, 0, 'src/a.ts', 1, 0));
    map.add(unmapped(1, 6));
    expect(map.lookup(1, 4)?.source).toBe('src/a.ts');
    expect(map.lookup(1, 7)).toBeNull();
    expect(map.sources()).toEqual(['a.ts']);
  });
});

describe('lookup complexity', () => {
  it('answers queries with a per-line ordered index instead of scanning all mappings', async () => {
    const lines = 500;
    const perLine = 200; // 100k segments total
    const raw: Segment[] = [];
    const map = new SegmentMap();
    for (let line = 0; line < lines; line++) {
      for (let column = 0; column < perLine; column++) {
        const segment = mapped(line, column * 10, `a.ts`, line, column);
        raw.push(segment);
        map.add(segment);
      }
    }

    const queries: Array<[number, number]> = [];
    for (let i = 0; i < 200; i++) {
      const line = (i * 37) % lines;
      queries.push([line, perLine * 10 - 5]); // worst case for a scan: late column
    }

    await map.ready();

    const scanStart = performance.now();
    for (const [line, column] of queries) {
      let hit: Segment | null = null;
      for (const segment of raw) {
        if (segment.generatedLine === line && segment.generatedColumn <= column) {
          hit = segment;
        }
      }
      if (!hit) throw new Error('baseline scan failed');
    }
    const scanTime = performance.now() - scanStart;

    const queryStart = performance.now();
    await Promise.all(
      queries.map(([line, column]) =>
        map.locate(line, column, 'predecessor').then((result) => {
          if (!result) throw new Error('indexed query failed');
        }),
      ),
    );
    const queryTime = performance.now() - queryStart;

    // The indexed lookup must be decisively sublinear in the mapping count.
    expect(queryTime).toBeLessThan(scanTime / 10);
  });
});
