# Source map core

TypeScript library for source-map segment lookup with biased queries and
original-range reverse lookup.

Run `npm install`, then `npm test` and `npm run build`.

## Segment

All coordinates are 0-based, matching the source-map mappings encoding. A
segment without a `source` is **unmapped**: it is never returned from a query
and cuts the range of the segment before it.

```ts
map.add({ generatedLine: 0, generatedColumn: 6, source: 'a.ts', originalLine: 0, originalColumn: 0 });
map.add({ generatedLine: 0, generatedColumn: 12 }); // unmapped segment
```

## `locate(line, column, bias?)` — generated → original

Async; builds the indexes lazily on first call.

- `'predecessor'` (default): closest segment starting at or before the column,
  on the same generated line. Unmapped segments are not crossed.
- `'successor'`: closest segment starting at or after the column, skipping
  unmapped segments, on the same line.
- `'strict'`: only a segment starting exactly at the queried column.

The result distinguishes an exact column hit from a biased one:

```ts
await map.locate(0, 8, 'strict');      // { kind: 'exact',  segment: {...} } | null
await map.locate(0, 3, 'successor');   // { kind: 'biased', segment: {...} } | null
```

Lookups never cross a line boundary: each generated line owns an ordered
column index, searched with binary search (O(log n) per query instead of a
linear scan of all mappings).

## `originalRangesFor(source, start, end?)` — original → generated

Returns every generated range mapped into the half-open original interval
`[start, end)` (omit `end` to query exactly `start`). Duplicate original
positions mapped from several generated fragments are all returned, stably
ordered by generated line/column (insertion order breaks ties).

Each range ends at the next segment on the same generated line or at line end
(`endColumn = Infinity`, `endOfLine: true`); ranges never span lines and an
unmapped segment terminates the range before it. A zero-length range has equal
`generatedColumn` and `endColumn`.

## Index lifecycle

The per-line forward index and the per-source reverse index are built once,
lazily on first query. Concurrent first queries (`locate` /
`originalRangesFor` / `ready` issued in the same tick) share a single build.
`add()` throws once the map has been indexed. The legacy synchronous
`lookup(line, column)` (same-line predecessor) and `sources()` remain
available.
