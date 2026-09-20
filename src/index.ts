/**
 * Segment map with ordered per-line indexes over generated positions and a
 * reverse index keyed by source/original position. Coordinates are 0-based,
 * matching the source-map encoding.
 *
 * Indexes are built lazily on first query and at most once; concurrent first
 * queries await the same build.
 */

/** Bias selects which segment wins when no segment starts on the queried column. */
export type Bias = 'predecessor' | 'successor' | 'strict';

export interface Segment {
  generatedLine: number;
  generatedColumn: number;
  /** Undefined for unmapped segments; such segments cut mapped ranges. */
  source?: string;
  originalLine: number;
  originalColumn: number;
  name?: string;
}

export interface Position {
  line: number;
  column: number;
}

export interface MappedSegment {
  generatedLine: number;
  generatedColumn: number;
  source: string;
  originalLine: number;
  originalColumn: number;
  name?: string;
}

export interface LookupOutcome {
  /** 'exact' when a segment starts on the queried column, otherwise 'biased'. */
  kind: 'exact' | 'biased';
  segment: MappedSegment;
}

export interface GeneratedRange {
  generatedLine: number;
  /** Inclusive start column. */
  generatedColumn: number;
  /** Exclusive end column; Number.POSITIVE_INFINITY when the range reaches line end. */
  endColumn: number;
  endOfLine: boolean;
  source: string;
  originalLine: number;
  originalColumn: number;
  name?: string;
}

interface IndexedSegment {
  ord: number;
  generatedLine: number;
  generatedColumn: number;
  source?: string;
  originalLine: number;
  originalColumn: number;
  name?: string;
  /** Derived from the next segment on the same line, or line end. */
  endColumn: number;
  endOfLine: boolean;
}

interface LineIndex {
  columns: number[];
  segments: IndexedSegment[];
}

interface SourceBucket {
  line: number;
  column: number;
  segments: IndexedSegment[];
}

const LINE_END = Number.POSITIVE_INFINITY;

const isMapped = (segment: Segment): segment is Segment & { source: string } =>
  segment.source !== undefined;

const validCoord = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

/** First index whose column is >= target (segments sorted by column asc). */
function lowerBound(columns: number[], target: number): number {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (columns[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function view(segment: IndexedSegment): MappedSegment {
  const out: MappedSegment = {
    generatedLine: segment.generatedLine,
    generatedColumn: segment.generatedColumn,
    source: segment.source!,
    originalLine: segment.originalLine,
    originalColumn: segment.originalColumn,
  };
  if (segment.name !== undefined) out.name = segment.name;
  return out;
}

export class SegmentMap {
  #segments: Segment[] = [];
  #built = false;
  #building: Promise<void> | null = null;
  #lines = new Map<number, LineIndex>();
  #bySource = new Map<string, SourceBucket[]>();

  add(segment: Segment): void {
    if (this.#built) throw new Error('SegmentMap is already indexed');
    if (!validCoord(segment.generatedLine) || !validCoord(segment.generatedColumn)) {
      throw new Error('generatedLine and generatedColumn must be non-negative integers');
    }
    if (isMapped(segment) && (!validCoord(segment.originalLine) || !validCoord(segment.originalColumn))) {
      throw new Error('originalLine and originalColumn must be non-negative integers');
    }
    this.#segments.push(segment);
  }

  /**
   * Build the indexes. Override to observe builds; the base implementation
   * runs at most once even when several queries race on the lazy first build.
   */
  protected buildIndex(): void {
    const ordered = this.#segments
      .map((segment, ord): IndexedSegment => ({
        ord,
        generatedLine: segment.generatedLine,
        generatedColumn: segment.generatedColumn,
        source: segment.source,
        originalLine: segment.originalLine,
        originalColumn: segment.originalColumn,
        name: segment.name,
        endColumn: LINE_END,
        endOfLine: true,
      }))
      .sort(
        (a, b) =>
          a.generatedLine - b.generatedLine ||
          a.generatedColumn - b.generatedColumn ||
          a.ord - b.ord,
      );

    // Forward index: per generated line, ordered columns for binary search.
    let start = 0;
    for (let i = 1; i <= ordered.length; i++) {
      if (i === ordered.length || ordered[i].generatedLine !== ordered[start].generatedLine) {
        const line = ordered[start].generatedLine;
        const segments = ordered.slice(start, i);
        for (let j = 0; j < segments.length - 1; j++) {
          segments[j].endColumn = segments[j + 1].generatedColumn;
          segments[j].endOfLine = false;
        }
        this.#lines.set(line, {
          columns: segments.map((item) => item.generatedColumn),
          segments,
        });
        start = i;
      }
    }

    // Reverse index: source -> buckets ordered by original position;
    // duplicate original positions keep insertion order within a bucket.
    for (const segment of ordered) {
      if (segment.source === undefined) continue;
      let buckets = this.#bySource.get(segment.source);
      if (!buckets) {
        buckets = [];
        this.#bySource.set(segment.source, buckets);
      }
      let bucket = buckets.at(-1);
      if (
        !bucket ||
        bucket.line !== segment.originalLine ||
        bucket.column !== segment.originalColumn
      ) {
        bucket = {
          line: segment.originalLine,
          column: segment.originalColumn,
          segments: [],
        };
        buckets.push(bucket);
      }
      bucket.segments.push(segment);
    }
  }

  /** Force the lazy index build; concurrent callers share one build. */
  ready(): Promise<void> {
    if (this.#built) return Promise.resolve();
    if (!this.#building) {
      this.#building = new Promise<void>((resolve, reject) => {
        // Defer to a microtask so queries issued in the same tick coalesce.
        queueMicrotask(() => {
          try {
            if (!this.#built) this.buildIndex();
            this.#built = true;
            resolve();
          } catch (error) {
            this.#building = null;
            reject(error);
          }
        });
      });
    }
    return this.#building;
  }

  #ensureSync(): void {
    if (!this.#built) {
      this.buildIndex();
      this.#built = true;
    }
  }

  /**
   * Map a generated position to an original position.
   *
   * - strict: only a segment starting exactly at the column matches
   * - predecessor: closest segment at or before the column, same line
   * - successor: closest segment at or after the column, same line
   *
   * Unmapped segments are never returned and cut ranges: a predecessor query
   * before an unmapped segment does not cross it; a successor search skips it.
   * A segment on another line is never considered.
   */
  async locate(line: number, column: number, bias: Bias = 'predecessor'): Promise<LookupOutcome | null> {
    await this.ready();
    return this.#locate(line, column, bias);
  }

  #locate(line: number, column: number, bias: Bias): LookupOutcome | null {
    const index = this.#lines.get(line);
    if (!index || !validCoord(column)) return null;

    const idx = lowerBound(index.columns, column);
    const exact = idx < index.columns.length && index.columns[idx] === column;

    if (exact) {
      // Same column may host several segments (incl. zero-length); the run is
      // contiguous because it is one column value in the ordered array.
      let runEnd = idx + 1;
      while (runEnd < index.segments.length && index.columns[runEnd] === column) runEnd++;
      // Latest inserted wins; stable and consistent with GLB predecessor.
      for (let j = runEnd - 1; j >= idx; j--) {
        const candidate = index.segments[j];
        if (candidate.source !== undefined) {
          return { kind: 'exact', segment: view(candidate) };
        }
      }
      // Exact position is an unmapped segment: strict stops, predecessor does
      // not cross the cut; successor may continue beyond it.
      if (bias !== 'successor') return null;
      for (let j = runEnd; j < index.segments.length; j++) {
        const candidate = index.segments[j];
        if (candidate.source !== undefined) {
          return { kind: 'biased', segment: view(candidate) };
        }
      }
      return null;
    }

    if (bias === 'strict') return null;

    if (bias === 'predecessor') {
      // idx is the first segment after the column; it cuts the range unless a
      // mapped segment immediately precedes the queried column.
      for (let j = idx - 1; j >= 0; j--) {
        const candidate = index.segments[j];
        if (candidate.source !== undefined) {
          return { kind: 'biased', segment: view(candidate) };
        }
        return null;
      }
      return null;
    }

    // successor
    for (let j = idx; j < index.segments.length; j++) {
      const candidate = index.segments[j];
      if (candidate.source !== undefined) {
        return { kind: 'biased', segment: view(candidate) };
      }
    }
    return null;
  }

  /**
   * Find every generated range mapped into the original half-open interval
   * [start, end) of a source. Ranges never cross generated lines: the end of
   * each range is derived from the next segment on the same line or from line
   * end, and unmapped segments terminate the preceding range.
   *
   * Repeated original positions return all generated fragments, stably
   * ordered by generated line/column (insertion order breaking ties).
   */
  async originalRangesFor(
    source: string,
    start: Position,
    end?: Position,
  ): Promise<GeneratedRange[]> {
    await this.ready();
    const buckets = this.#bySource.get(source);
    if (!buckets) return [];

    // Omitting end queries exactly the start point; otherwise the original
    // interval [start, end) is half open.
    const atEnd: (bucket: SourceBucket) => boolean = end
      ? (bucket) =>
          bucket.line < end.line || (bucket.line === end.line && bucket.column < end.column)
      : (bucket) =>
          bucket.line === start.line && bucket.column === start.column;

    const atOrAfterStart = (bucket: SourceBucket): boolean =>
      bucket.line > start.line ||
      (bucket.line === start.line && bucket.column >= start.column);

    let i = 0;
    while (i < buckets.length && !atOrAfterStart(buckets[i])) i++;

    const hits: IndexedSegment[] = [];
    for (; i < buckets.length && atEnd(buckets[i]); i++) {
      hits.push(...buckets[i].segments);
    }

    hits.sort(
      (a, b) =>
        a.generatedLine - b.generatedLine ||
        a.generatedColumn - b.generatedColumn ||
        a.ord - b.ord,
    );

    return hits.map((segment) => {
      const out: GeneratedRange = {
        generatedLine: segment.generatedLine,
        generatedColumn: segment.generatedColumn,
        endColumn: segment.endColumn,
        endOfLine: segment.endOfLine,
        source: segment.source!,
        originalLine: segment.originalLine,
        originalColumn: segment.originalColumn,
      };
      if (segment.name !== undefined) out.name = segment.name;
      return out;
    });
  }

  /**
   * Legacy lookup: predecessor within the same generated line, or null.
   * Returns the raw mapped segment; unmapped regions yield null.
   */
  lookup(line: number, column: number): MappedSegment | null {
    this.#ensureSync();
    return this.#locate(line, column, 'predecessor')?.segment ?? null;
  }

  sources(): string[] {
    return [
      ...new Set(
        this.#segments
          .filter(isMapped)
          .map((item) => item.source.split('/').at(-1)!),
      ),
    ];
  }
}
