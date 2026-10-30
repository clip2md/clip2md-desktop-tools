import {describe,it,expect} from 'vitest';
import {parseTranscript,decodedDuration} from './transcription';
describe('Whisper transcript boundary',()=>{
 const json=(rows:unknown[])=>JSON.stringify({transcription:rows});
 it('keeps real text literal and adds segment offsets to timestamps',()=>{
   const result=parseTranscript(json([{text:' 中文 {{title}} $value ',offsets:{from:1500,to:3000}}]),600000);
   expect(result).toBe('[00:10:01] 中文 {{title}} $value');
 });
 it('rejects wrong schema, reversed, missing or overlapping timestamps',()=>{
   for(const raw of ['{}',json([{text:'x',offsets:{from:3000,to:2000}}]),json([{text:'x',offsets:{from:0,to:601001}}]),json([{text:'x',offsets:{from:0,to:2000}},{text:'y',offsets:{from:1000,to:3000}}])])expect(()=>parseTranscript(raw)).toThrow();
 });
 it('allows Whisper to end a short final utterance shortly after the decoded audio',()=>{
   const row=json([{text:'结尾',offsets:{from:175200,to:177200}}]);
   expect(()=>parseTranscript(row,0,175600)).toThrow();
   expect(parseTranscript(row,0,175600,2000)).toBe('[00:02:55] 结尾');
 });
});
describe('decoded PCM coverage across FFmpeg versions',()=>{
 it('uses exact PCM duration with either final packet start or end progress',()=>{
  expect(decodedDuration('out_time_us=10900000\nprogress=end',[11],11)).toBe(11);
  expect(decodedDuration('out_time_us=11000000\nprogress=end',[11],11)).toBe(11);
  expect(decodedDuration('out_time_us=600000000\nprogress=end',[600,.005],600.005)).toBe(600.005);
 });
 it('rejects missing completion, lost audio and progress outside one bounded packet',()=>{
  expect(()=>decodedDuration('out_time_us=10900000\nprogress=continue',[11])).toThrow('不完整');
  expect(()=>decodedDuration('out_time_us=10000000\nprogress=end',[11])).toThrow('不完整');
  expect(()=>decodedDuration('out_time_us=79900000\nprogress=end',[80],100)).toThrow('不完整');
 });
});
