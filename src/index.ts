export type MappedSegment = {
  generatedLine: number;
  generatedColumn: number;
  source: string;
  originalLine: number;
  originalColumn: number;
  name?: string;
};

/** A segment with no original position. It terminates the range of the previous segment on its line. */
export type UnmappedSegment = {
  generatedLine: number;
  generatedColumn: number;
};

export type Segment = MappedSegment | UnmappedSegment;

export const isMappedSegment = (segment: Segment): segment is MappedSegment => 'source' in segment;

/**
 * GLB: greatest lower bound — closest segment at or before the column.
 * LUB: least upper bound — closest segment at or after the column.
 * EXACT: only a segment starting exactly at the column.
 * All biases search within the queried generated line only; they never fall
 * back to a segment on a neighbouring line.
 */
export type Bias = 'GLB' | 'LUB' | 'EXACT';

export type LookupResult = {
  segment: MappedSegment;
  /** true when the segment starts exactly at the queried column, false for biased hits. */
  exact: boolean;
};

export type GeneratedRange = {
  generatedLine: number;
  generatedColumn: number;
  generatedEndLine: number;
  /** null when the range runs to the end of the line and the line length is unknown. */
  generatedEndColumn: number | null;
  segment: MappedSegment;
};

export type OriginalPosition = { line: number; column: number };

type IndexedSegment = {
  segment: Segment;
  /** insertion order, used as a stable tie-breaker */
  order: number;
  /** position within its generated-line row, assigned when indexes are built */
  rowIndex: number;
};

type Indexes = {
  /** generated line -> segments sorted by generated column (stable) */
  lines: Map<number, IndexedSegment[]>;
  /** source -> original line -> segments sorted by original column (stable) */
  bySource: Map<string, Map<number, IndexedSegment[]>>;
};

/** First index whose key is >= value. */
function lowerBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose key is > value. */
function upperBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const generatedColumn = (item: IndexedSegment) => item.segment.generatedColumn;
const originalColumn = (item: IndexedSegment) => (item.segment as MappedSegment).originalColumn;

export class SegmentMap {
  #segments: IndexedSegment[] = [];
  #lineLengths = new Map<number, number>();
  #indexes: Indexes | null = null;
  #buildPromise: Promise<Indexes> | null = null;
  #buildCount = 0;

  constructor(options: { lineLengths?: Iterable<readonly [number, number]> } = {}) {
    if (options.lineLengths) {
      for (const [line, length] of options.lineLengths) this.#lineLengths.set(line, length);
    }
  }

  /** How many times the indexes were (re)built. Exposed so callers can verify lazy, single construction. */
  get indexBuildCount(): number {
    return this.#buildCount;
  }

  /** Record the length of a generated line so ranges can end at the line end instead of null. */
  setLineLength(line: number, length: number): void {
    this.#lineLengths.set(line, length);
  }

  add(segment: Segment): void {
    this.#segments.push({ segment, order: this.#segments.length, rowIndex: -1 });
    this.#invalidate();
  }

  /** Add a fragment of a generated file; multiple fragments may be added in any order. */
  addAll(segments: Iterable<Segment>): void {
    for (const segment of segments) this.add(segment);
  }

  #invalidate(): void {
    this.#indexes = null;
    this.#buildPromise = null;
  }

  #build(): Indexes {
    this.#buildCount++;
    const lines = new Map<number, IndexedSegment[]>();
    const bySource = new Map<string, Map<number, IndexedSegment[]>>();
    for (const item of this.#segments) {
      const { generatedLine } = item.segment;
      let row = lines.get(generatedLine);
      if (!row) lines.set(generatedLine, (row = []));
      row.push(item);
      if (isMappedSegment(item.segment)) {
        const { source, originalLine } = item.segment;
        let sourceIndex = bySource.get(source);
        if (!sourceIndex) bySource.set(source, (sourceIndex = new Map()));
        let originals = sourceIndex.get(originalLine);
        if (!originals) sourceIndex.set(originalLine, (originals = []));
        originals.push(item);
      }
    }
    // Array.prototype.sort is stable, so equal keys keep insertion order.
    for (const row of lines.values()) {
      row.sort((a, b) => a.segment.generatedColumn - b.segment.generatedColumn);
      row.forEach((item, index) => (item.rowIndex = index));
    }
    for (const sourceIndex of bySource.values()) {
      for (const originals of sourceIndex.values()) {
        originals.sort((a, b) => originalColumn(a) - originalColumn(b));
      }
    }
    return { lines, bySource };
  }

  #ensureIndexes(): Indexes {
    if (!this.#indexes) this.#indexes = this.#build();
    return this.#indexes;
  }

  /** Concurrent first queries share a single build via this memoized promise. */
  #ensureIndexesAsync(): Promise<Indexes> {
    if (this.#indexes) return Promise.resolve(this.#indexes);
    if (!this.#buildPromise) {
      this.#buildPromise = Promise.resolve().then(() => this.#ensureIndexes());
    }
    return this.#buildPromise;
  }

  /** Backwards-compatible greatest-lower-bound lookup. */
  lookup(line: number, column: number): MappedSegment | null {
    return this.lookupWithBias(line, column, 'GLB')?.segment ?? null;
  }

  lookupWithBias(line: number, column: number, bias: Bias = 'GLB'): LookupResult | null {
    return this.#lookup(this.#ensureIndexes(), line, column, bias);
  }

  async lookupWithBiasAsync(line: number, column: number, bias: Bias = 'GLB'): Promise<LookupResult | null> {
    return this.#lookup(await this.#ensureIndexesAsync(), line, column, bias);
  }

  #lookup(indexes: Indexes, line: number, column: number, bias: Bias): LookupResult | null {
    const row = indexes.lines.get(line);
    if (!row || row.length === 0) return null;
    let hit: IndexedSegment | undefined;
    let exact = false;
    if (bias === 'GLB') {
      const index = upperBound(row, column, generatedColumn) - 1;
      if (index >= 0) hit = row[index];
    } else {
      const index = lowerBound(row, column, generatedColumn);
      if (index < row.length) hit = row[index];
    }
    if (!hit) return null;
    exact = hit.segment.generatedColumn === column;
    if (bias === 'EXACT' && !exact) return null;
    if (!isMappedSegment(hit.segment)) return null;
    return { segment: hit.segment, exact };
  }

  /**
   * Reverse lookup: every generated range whose original position falls inside
   * [start, end] (both inclusive) of the given source. Duplicate original
   * positions mapped from several generated fragments are all returned, stably
   * sorted by generated line, generated column, then insertion order.
   */
  generatedRangesFor(source: string, start: OriginalPosition, end: OriginalPosition = start): GeneratedRange[] {
    return this.#rangesFor(this.#ensureIndexes(), source, start, end);
  }

  async generatedRangesForAsync(
    source: string,
    start: OriginalPosition,
    end: OriginalPosition = start,
  ): Promise<GeneratedRange[]> {
    return this.#rangesFor(await this.#ensureIndexesAsync(), source, start, end);
  }

  #rangesFor(indexes: Indexes, source: string, start: OriginalPosition, end: OriginalPosition): GeneratedRange[] {
    const sourceIndex = indexes.bySource.get(source);
    if (!sourceIndex) return [];
    const matches: IndexedSegment[] = [];
    for (let line = start.line; line <= end.line; line++) {
      const row = sourceIndex.get(line);
      if (!row) continue;
      const from = line === start.line ? lowerBound(row, start.column, originalColumn) : 0;
      const to = line === end.line ? upperBound(row, end.column, originalColumn) : row.length;
      for (let index = from; index < to; index++) matches.push(row[index]);
    }
    matches.sort(
      (a, b) =>
        a.segment.generatedLine - b.segment.generatedLine ||
        a.segment.generatedColumn - b.segment.generatedColumn ||
        a.order - b.order,
    );
    return matches.map((item) => this.#rangeOf(indexes, item));
  }

  /**
   * A segment's range extends to the next segment on the same generated line
   * (mapped or not — an unmapped segment cuts the range off), or to the end of
   * the line. Ranges never span lines.
   */
  #rangeOf(indexes: Indexes, item: IndexedSegment): GeneratedRange {
    const segment = item.segment as MappedSegment;
    const row = indexes.lines.get(segment.generatedLine)!;
    const next = row[item.rowIndex + 1]?.segment;
    const endColumn = next ? next.generatedColumn : (this.#lineLengths.get(segment.generatedLine) ?? null);
    return {
      generatedLine: segment.generatedLine,
      generatedColumn: segment.generatedColumn,
      generatedEndLine: segment.generatedLine,
      generatedEndColumn: endColumn,
      segment,
    };
  }

  sources(): string[] {
    const names = this.#segments.filter((item) => isMappedSegment(item.segment)).map((item) => (item.segment as MappedSegment).source.split('/').at(-1)!);
    return [...new Set(names)];
  }
}
