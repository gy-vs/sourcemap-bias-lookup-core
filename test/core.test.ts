import {expect,it} from 'vitest';
import {SegmentMap} from '../src/index.js';

it('looks up a segment',()=>{const x=new SegmentMap();x.add({generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:1,originalColumn:0});expect(x.lookup(1,4)?.source).toBe('a.ts')});

it('distinguishes exact hits from biased hits',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:4,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:1,generatedColumn:10,source:'a.ts',originalLine:2,originalColumn:0});
  const exact=map.lookupWithBias(1,4,'GLB');
  expect(exact).toMatchObject({exact:true,segment:{originalLine:1}});
  const glb=map.lookupWithBias(1,7,'GLB');
  expect(glb).toMatchObject({exact:false,segment:{originalLine:1}});
  const lub=map.lookupWithBias(1,7,'LUB');
  expect(lub).toMatchObject({exact:false,segment:{originalLine:2}});
  expect(map.lookupWithBias(1,7,'EXACT')).toBeNull();
  expect(map.lookupWithBias(1,10,'EXACT')?.exact).toBe(true);
});

it('handles leading whitespace before the first segment',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:4,source:'a.ts',originalLine:1,originalColumn:0});
  expect(map.lookupWithBias(1,0,'GLB')).toBeNull();
  expect(map.lookupWithBias(1,3,'GLB')).toBeNull();
  expect(map.lookupWithBias(1,0,'LUB')?.segment.generatedColumn).toBe(4);
  expect(map.lookupWithBias(1,0,'EXACT')).toBeNull();
});

it('never treats a segment on another line as the same range',()=>{
  const map=new SegmentMap({lineLengths:[[1,12]]});
  map.add({generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:2,generatedColumn:0,source:'a.ts',originalLine:2,originalColumn:0});
  // GLB on line 2 hits the line-2 segment, not the previous line's nearest segment.
  expect(map.lookupWithBias(2,0,'GLB')?.segment.originalLine).toBe(2);
  // The line-1 segment's range ends at the end of line 1, not at the line-2 segment.
  const ranges=map.generatedRangesFor('a.ts',{line:1,column:0});
  expect(ranges).toHaveLength(1);
  expect(ranges[0]).toMatchObject({generatedLine:1,generatedColumn:0,generatedEndLine:1,generatedEndColumn:12});
});

it('returns all same-column duplicates in stable order with zero-length ranges',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:4,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:1,generatedColumn:4,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:1,generatedColumn:9,source:'a.ts',originalLine:1,originalColumn:5});
  const ranges=map.generatedRangesFor('a.ts',{line:1,column:0});
  expect(ranges).toHaveLength(2);
  // First duplicate is cut by the second at the same column: zero-length range.
  expect(ranges[0]).toMatchObject({generatedColumn:4,generatedEndColumn:4});
  expect(ranges[1]).toMatchObject({generatedColumn:4,generatedEndColumn:9});
  // Stable: insertion order preserved between the duplicates.
  expect(ranges[0].segment).not.toBe(ranges[1].segment);
});

it('collects duplicate original positions from several generated fragments',()=>{
  const map=new SegmentMap();
  // Two generated fragments both map to the same original position.
  map.addAll([
    {generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:3,originalColumn:2},
    {generatedLine:1,generatedColumn:6,source:'a.ts',originalLine:4,originalColumn:0},
  ]);
  map.addAll([
    {generatedLine:5,generatedColumn:0,source:'a.ts',originalLine:3,originalColumn:2},
    {generatedLine:8,generatedColumn:2,source:'a.ts',originalLine:3,originalColumn:2},
  ]);
  const ranges=map.generatedRangesFor('a.ts',{line:3,column:2});
  expect(ranges.map(r=>[r.generatedLine,r.generatedColumn])).toEqual([[1,0],[5,0],[8,2]]);
  // Forward lookups work across fragments too.
  expect(map.lookupWithBias(8,4,'GLB')?.segment.originalLine).toBe(3);
});

it('cuts ranges at unmapped segments',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:1,generatedColumn:5});
  map.add({generatedLine:1,generatedColumn:8,source:'a.ts',originalLine:2,originalColumn:0});
  const ranges=map.generatedRangesFor('a.ts',{line:1,column:0});
  expect(ranges[0]).toMatchObject({generatedColumn:0,generatedEndColumn:5});
  // The unmapped segment itself has no original position.
  expect(map.lookupWithBias(1,6,'GLB')).toBeNull();
  expect(map.lookupWithBias(1,9,'GLB')?.segment.originalLine).toBe(2);
});

it('looks up segments without a name',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:1,generatedColumn:3,source:'a.ts',originalLine:1,originalColumn:7,name:'foo'});
  expect(map.lookupWithBias(1,1,'GLB')?.segment.name).toBeUndefined();
  expect(map.lookupWithBias(1,4,'GLB')?.segment.name).toBe('foo');
});

it('ends ranges at line end only when the line length is known',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:2,source:'a.ts',originalLine:1,originalColumn:0});
  expect(map.generatedRangesFor('a.ts',{line:1,column:0})[0].generatedEndColumn).toBeNull();
  map.setLineLength(1,20);
  expect(map.generatedRangesFor('a.ts',{line:1,column:0})[0].generatedEndColumn).toBe(20);
});

it('reverse-looks up an original range spanning lines',()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:1,originalColumn:5});
  map.add({generatedLine:1,generatedColumn:4,source:'a.ts',originalLine:2,originalColumn:0});
  map.add({generatedLine:1,generatedColumn:8,source:'a.ts',originalLine:2,originalColumn:6});
  map.add({generatedLine:1,generatedColumn:12,source:'a.ts',originalLine:3,originalColumn:1});
  map.add({generatedLine:1,generatedColumn:16,source:'b.ts',originalLine:2,originalColumn:3});
  const ranges=map.generatedRangesFor('a.ts',{line:2,column:0},{line:3,column:1});
  expect(ranges.map(r=>r.generatedColumn)).toEqual([4,8,12]);
  // Other sources are excluded even inside the same original range.
  expect(ranges.every(r=>r.segment.source==='a.ts')).toBe(true);
});

it('builds indexes lazily and only once under concurrent first queries',async()=>{
  const map=new SegmentMap();
  map.add({generatedLine:1,generatedColumn:0,source:'a.ts',originalLine:1,originalColumn:0});
  map.add({generatedLine:2,generatedColumn:0,source:'a.ts',originalLine:2,originalColumn:0});
  expect(map.indexBuildCount).toBe(0);
  const [hit,ranges,again]=await Promise.all([
    map.lookupWithBiasAsync(1,3,'GLB'),
    map.generatedRangesForAsync('a.ts',{line:2,column:0}),
    map.lookupWithBiasAsync(2,0,'EXACT'),
  ]);
  expect(hit?.segment.originalLine).toBe(1);
  expect(ranges).toHaveLength(1);
  expect(again?.exact).toBe(true);
  expect(map.indexBuildCount).toBe(1);
  // Later sync queries reuse the built indexes.
  map.lookup(1,0);
  expect(map.indexBuildCount).toBe(1);
});
